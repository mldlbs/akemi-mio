/**
 * GuardrailConfigStore — PolicyConfig Event Projection
 *
 * M4.4 重构：从 Producer 改为 Event Projection。
 *
 * 职责：
 * - 通过 applyActivated / applyRollback 消费 Event 维护内存 Projection
 * - loadFromEvents() 启动时从 EvaluationEvent 日志重建 state
 * - allocateVersion() 作为辅助工具方法
 * - getActiveConfig() 供 Consumer/Policy 读取当前 config
 *
 * ConfigStore 是纯 Consumer（Projection），不控制 Event lifecycle。
 * Truth Source 是 EvaluationEvent log，ConfigStore 是运行时优化。
 */
import type { GuardrailPolicyConfig } from './GuardrailTypes'
import { DEFAULT_GUARDRAIL_POLICY_CONFIG } from './GuardrailTypes'
import type { EvaluationEvent, RollbackTrigger } from './types'
import { migrateConfigPayload, CONFIG_EVENT_TYPES } from './EvaluationEventSchema'

export interface ConfigRecord {
  version: string
  config: GuardrailPolicyConfig
  activatedAt: number
  /** M7.3: 触发该 activation 的 recommendationId（可选） */
  recommendationId?: string
}

export interface RollbackRecord {
  fromVersion: string
  toVersion: string
  trigger: RollbackTrigger
  reason?: string
  /** M7.3: 发起该回滚的 recommendationId（可选） */
  sourceRecommendationId?: string
}

export interface ActiveConfigState {
  version: string
  config: GuardrailPolicyConfig
}

export class GuardrailConfigStore {
  private records: Map<string, ConfigRecord> = new Map()
  private activeVersion: string | null = null
  private versionCounter = 0
  private rollbackHistory: RollbackRecord[] = []

  constructor() {}

  // ══════════════════════════════════════════════
  // Projection API — 纯 Consumer 行为
  // ══════════════════════════════════════════════

  /**
   * 追加一条 activated 记录到 projection。
   * 不 emit event，不生成 version。version 由 Producer 提供。
   */
  applyActivated(version: string, config: GuardrailPolicyConfig, activatedAt: number, recommendationId?: string): void {
    this.records.set(version, { version, config: { ...config, version }, activatedAt, recommendationId })
    this.activeVersion = version
  }

  /**
   * 追加一条 rollback 记录到 projection。
   * 切换 activeVersion 到 toVersion。
   * Throws 如果 toVersion 不存在于 records。
   */
  applyRollback(
    fromVersion: string,
    toVersion: string,
    _trigger: RollbackTrigger,
    _reason?: string,
    sourceRecommendationId?: string,
  ): void {
    if (this.activeVersion === toVersion) {
      throw new Error(`Version ${toVersion} is already active`)
    }
    if (!this.records.has(toVersion)) {
      throw new Error(`Cannot rollback to unknown version ${toVersion}`)
    }
    this.rollbackHistory.push({ fromVersion, toVersion, trigger: _trigger, reason: _reason, sourceRecommendationId })
    this.activeVersion = toVersion
  }

  /**
   * 从 EvaluationEvent 日志全量重建 state。
   *
   * Throws 条件:
   * - 回滚目标版本不存在（fracture）
   * - 第一个 config event 是 rollback（空 timeline 无法回滚）
   *
   * 0 config events → 静默返回（不抛出，不 fallback）。
   * Caller 应通过 getVersionHistory().length === 0 判断是否需要 seed。
   *
   * 支持 eventSchemaVersion 迁移：
   * - 旧事件缺失 eventSchemaVersion → 默认 v1
   * - 读取前调用 migrateConfigPayload 确保 Config 结构完整
   */
  loadFromEvents(events: EvaluationEvent[]): void {
    this.records.clear()
    this.activeVersion = null

    const configEvents = events
      .filter((e): e is EvaluationEvent & { type: keyof typeof import('./EvaluationEventSchema').EVENT_SCHEMA_VERSIONS } =>
        CONFIG_EVENT_TYPES.has(e.type),
      )
      .sort((a, b) => a.timestamp - b.timestamp)

    if (configEvents.length === 0) {
      return
    }

    for (const event of configEvents) {
      if (event.type === 'guardrail.config.activated' || event.type === 'guardrail.config.initialized') {
        const rawPayload = event.payload as unknown as Record<string, unknown>
        const fromVersion = (rawPayload.eventSchemaVersion as number) ?? 1
        const migrated = migrateConfigPayload(event.type, rawPayload as any, fromVersion)
        this.applyActivated(
          migrated.version as string,
          migrated.config as unknown as GuardrailPolicyConfig,
          migrated.activatedAt as number,
          rawPayload.recommendationId as string | undefined,
        )
      } else {
        // type === 'guardrail.config.rollback'
        const p = event.payload as { fromVersion: string; toVersion: string; trigger: RollbackTrigger; reason?: string }
        if (!this.records.has(p.toVersion)) {
          throw new Error(`Timeline fracture: rollback to unknown version ${p.toVersion}`)
        }
        this.applyRollback(
          p.fromVersion,
          p.toVersion,
          p.trigger,
          p.reason,
          (event.payload as any).sourceRecommendationId as string | undefined,
        )
      }
    }

    // Post-replay guard: events were processed but nothing became active
    if (this.activeVersion === null) {
      throw new Error('Timeline fracture: first config event is a rollback, no activation found')
    }
  }

  // ══════════════════════════════════════════════
  // Query API
  // ══════════════════════════════════════════════

  /** 当前 active config。无 active version 时返回 DEFAULT。 */
  getActiveConfig(): ActiveConfigState {
    if (this.activeVersion === null) {
      return { version: DEFAULT_GUARDRAIL_POLICY_CONFIG.version, config: DEFAULT_GUARDRAIL_POLICY_CONFIG }
    }
    const record = this.records.get(this.activeVersion)!
    return { version: record.version, config: record.config }
  }

  /** 按 version 查询已存储的 config */
  getConfig(version: string): GuardrailPolicyConfig | undefined {
    return this.records.get(version)?.config
  }

  /** 校验 version 是否存在于历史中 */
  hasVersion(version: string): boolean {
    return this.records.has(version)
  }

  /** 获取全部版本记录，按激活时间升序 */
  getVersionHistory(): ConfigRecord[] {
    return Array.from(this.records.values()).sort((a, b) => a.activatedAt - b.activatedAt)
  }

  /** M7.3: 查询指定 version 的 activation recommendationId */
  getActivationRecommendationId(version: string): string | undefined {
    return this.records.get(version)?.recommendationId
  }

  /** M7.3: 获取回滚历史记录 */
  getRollbackHistory(): RollbackRecord[] {
    return [...this.rollbackHistory]
  }

  // ══════════════════════════════════════════════
  // Helper — Producer 侧的辅助工具方法
  // ══════════════════════════════════════════════

  /** 预览下一个版本号（不推进计数器） */
  peekNextVersion(): string {
    return `v${this.versionCounter + 1}`
  }

  /**
   * 分配下一个单调版本号。
   * 仅作为辅助工具，不表示最终事实。Producer 可自行生成 version 字符串。
   */
  allocateVersion(): string {
    this.versionCounter++
    return `v${this.versionCounter}`
  }
}
