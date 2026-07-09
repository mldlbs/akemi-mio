/**
 * GuardrailConfigStore — PolicyConfig 版本管理
 *
 * 职责：
 * - 单调版本生成（v1 → v2 → v3，只增不降）
 * - 版本激活与存储
 * - 版本回滚（含回滚前提校验）
 * - getActiveConfig() 供 Consumer/Policy 消费当前 config
 *
 * 不负责：
 * - emit EvaluationEvent（调用方负责发射 activation/rollback event）
 * - 持久化（M4.3 为内存版本，后续可加持久化）
 * - Config UI / 自动版本调整（M5+）
 *
 * 关键约定：
 * - version 由 ConfigStore 管理，Policy 消费但不生产
 * - Config 切换在下一个 consume() 边界生效（不中断 in-flight Decision）
 * - Replay 可仅从 Event 重建版本迁移图（ConfigStore 是运行时优化，非 truth source）
 */

import type { GuardrailPolicyConfig } from './GuardrailTypes'
import { DEFAULT_GUARDRAIL_POLICY_CONFIG } from './GuardrailTypes'
import type { RollbackTrigger } from './types'

export interface ConfigRecord {
  version: string
  config: GuardrailPolicyConfig
  activatedAt: number
}

export interface ActiveConfigState {
  version: string
  config: GuardrailPolicyConfig
}

export interface ActivationResult {
  version: string
  activatedAt: number
}

export interface RollbackResult {
  fromVersion: string
  toVersion: string
}

export class GuardrailConfigStore {
  private records: Map<string, ConfigRecord> = new Map()
  private activeVersion: string | null = null
  private versionCounter = 0

  constructor(seedConfig?: GuardrailPolicyConfig) {
    if (seedConfig) {
      this.activateConfig(seedConfig)
    }
  }

  /**
   * 激活新版本。
   * 生成单调 version，存储 config，设为 active。
   * 返回 { version, activatedAt } 供调用方 emit event。
   */
  activateConfig(config: GuardrailPolicyConfig): ActivationResult {
    const version = this.generateVersion()
    const activatedAt = Date.now()
    this.records.set(version, { version, config: { ...config, version }, activatedAt })
    this.activeVersion = version
    return { version, activatedAt }
  }

  /**
   * 回滚到历史版本。
   * 前提：toVersion !== activeVersion，且 toVersion 存在于 records。
   * 返回 { fromVersion, toVersion } 供调用方 emit event。
   */
  rollback(toVersion: string, _trigger: RollbackTrigger, _reason?: string): RollbackResult {
    if (this.activeVersion === toVersion) {
      throw new Error(`Version ${toVersion} is already active`)
    }
    if (!this.records.has(toVersion)) {
      throw new Error(`Version ${toVersion} not found in config history`)
    }
    const fromVersion = this.activeVersion!
    this.activeVersion = toVersion
    return { fromVersion, toVersion }
  }

  /**
   * 当前 active config。
   * 无 seed config 且未 activate 时，返回 DEFAULT_GUARDRAIL_POLICY_CONFIG。
   */
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

  /** 预览下一个版本号（不激活） */
  peekNextVersion(): string {
    return `v${this.versionCounter + 1}`
  }

  private generateVersion(): string {
    this.versionCounter++
    return `v${this.versionCounter}`
  }
}
