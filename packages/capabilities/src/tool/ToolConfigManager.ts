/**
 * ToolConfigManager — 工具运行时可调参数配置管理器
 *
 * ## 职责
 * 1. 存储每个工具的运行时可调参数（优先级偏移、超时、重试次数、启用状态）
 * 2. 提供配置快照与回滚（基于 ToolEvalSnapshotStore）
 * 3. 持久化到 JSON 文件，支持进程重启后恢复
 * 4. 供 ToolAnalyticsCollector 读取、ToolConfigOptimizationExecutor 写入
 *
 * ## 管理的参数
 * - priorityDelta: 优先级偏移 [-10, +10]，正=提升，负=降低（ServerManager 使用）
 * - timeoutMs: 超时毫秒（默认 null=使用工具自带的超时）
 * - maxRetries: 最大重试次数（默认 null=使用系统默认）
 * - enabled: 是否启用（false = 禁用该工具）
 * - description: 配置变更原因
 *
 * ## 数据流
 *   ToolAnalyticsCollector → (读取) → ToolConfigManager
 *   ToolConfigOptimizationExecutor → (写入/回滚) → ToolConfigManager
 *   ServerManager → (读取) → ToolConfigManager.priorityDelta / timeoutMs / enabled
 *
 * ## 配置格式
 * 存储为 .claude/tool-config.json，格式：
 * {
 *   "tools": {
 *     "read_file": { "priorityDelta": 2, "timeoutMs": null, "maxRetries": 3, "enabled": true, "updatedAt": ... },
 *     "grep": { ... }
 *   },
 *   "version": 1
 * }
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { toolEvalSnapshotStore } from './ToolEvalSnapshotStore'
import { toolCallLogStore } from './ToolCallLogStore'

// =============================================================================
// 类型定义
// =============================================================================

/** 单工具的可调参数 */
export interface ToolTunableConfig {
  /** 优先级偏移 [-10, +10]，正=提升，负=降低 */
  priorityDelta: number
  /** 超时毫秒，null=使用工具默认超时 */
  timeoutMs: number | null
  /** 最大重试次数，null=使用系统默认 */
  maxRetries: number | null
  /** 是否启用 */
  enabled: boolean
  /** 上次更新时间戳 */
  updatedAt: number
  /** 配置变更原因 */
  reason: string
  /** 关联的评估快照 ID（如有） */
  snapshotId?: string
}

/** 完整配置 */
export interface ToolConfigStoreData {
  tools: Record<string, ToolTunableConfig>
  version: number
}

/** 配置变更操作类型 */
export type ConfigChangeType = 'priority' | 'timeout' | 'retry' | 'disable' | 'enable' | 'reset'

/** 单次配置变更记录 */
export interface ConfigChangeRecord {
  toolName: string
  changeType: ConfigChangeType
  /** 旧值快照 */
  before: Partial<ToolTunableConfig>
  /** 新值 */
  after: Partial<ToolTunableConfig>
  /** 变更原因 */
  reason: string
  /** 变更时间 */
  timestamp: number
  /** 关联的评估快照 ID */
  snapshotId: string
  /** 评估结果（null=待评估） */
  evalResult?: 'kept' | 'rolled_back' | null
}

// =============================================================================
// 默认值与常量
// =============================================================================

const DEFAULT_TOOL_CONFIG: ToolTunableConfig = {
  priorityDelta: 0,
  timeoutMs: null,
  maxRetries: null,
  enabled: true,
  updatedAt: 0,
  reason: '初始默认值',
}

const CONFIG_VERSION = 1

const CONFIG_PATH = join(process.cwd(), '.claude', 'tool-config.json')

const HISTORY_PATH = join(process.cwd(), '.claude', 'tool-config-history.json')

/** 回滚后，等待至少 N 条新调用记录才重新评估同一工具 */
const MIN_NEW_CALLS_BEFORE_RE_EVAL = 5

// =============================================================================
// ToolConfigManager 实现
// =============================================================================

export class ToolConfigManager {
  private data: ToolConfigStoreData
  private history: ConfigChangeRecord[] = []
  private loaded = false
  private historyLoaded = false

  constructor() {
    this.data = {
      tools: {},
      version: CONFIG_VERSION,
    }
  }

  // ==================== 持久化 ====================

  private ensureLoaded(): void {
    if (this.loaded) return
    try {
      if (existsSync(CONFIG_PATH)) {
        const raw = readFileSync(CONFIG_PATH, 'utf-8')
        const parsed = JSON.parse(raw) as ToolConfigStoreData
        if (parsed.version === CONFIG_VERSION && parsed.tools) {
          this.data = parsed
        }
      }
    } catch (err: any) {
      log('WARN', 'tool_config_load_failed', { error: err.message })
    }
    this.loaded = true
  }

  private persist(): void {
    try {
      const dir = dirname(CONFIG_PATH)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(CONFIG_PATH, JSON.stringify(this.data, null, 2), 'utf-8')
    } catch (err: any) {
      log('WARN', 'tool_config_persist_failed', { error: err.message })
    }
  }

  private ensureHistoryLoaded(): void {
    if (this.historyLoaded) return
    try {
      if (existsSync(HISTORY_PATH)) {
        const raw = readFileSync(HISTORY_PATH, 'utf-8')
        const parsed = JSON.parse(raw) as ConfigChangeRecord[]
        if (Array.isArray(parsed)) {
          this.history = parsed
        }
      }
    } catch {
      // 历史文件损坏时清空
      this.history = []
    }
    this.historyLoaded = true
  }

  private persistHistory(): void {
    try {
      const dir = dirname(HISTORY_PATH)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(HISTORY_PATH, JSON.stringify(this.history, null, 2), 'utf-8')
    } catch {
      // 历史持久化失败不重要
    }
  }

  // ==================== 公共 API ====================

  /**
   * 获取指定工具的当前配置，不存在时返回默认值
   */
  getConfig(toolName: string): ToolTunableConfig {
    this.ensureLoaded()
    return { ...DEFAULT_TOOL_CONFIG, ...this.data.tools[toolName] } as ToolTunableConfig
  }

  /**
   * 获取指定工具的优先级偏移
   */
  getPriorityDelta(toolName: string): number {
    return this.getConfig(toolName).priorityDelta
  }

  /**
   * 获取指定工具的超时设置
   */
  getTimeoutMs(toolName: string): number | null {
    return this.getConfig(toolName).timeoutMs
  }

  /**
   * 获取指定工具的重试次数设置
   */
  getMaxRetries(toolName: string): number | null {
    return this.getConfig(toolName).maxRetries
  }

  /**
   * 检查工具是否启用
   */
  isEnabled(toolName: string): boolean {
    return this.getConfig(toolName).enabled
  }

  /**
   * 获取所有被调优的配置（非默认值）
   */
  getAllTunedConfigs(): Array<{ toolName: string; config: ToolTunableConfig }> {
    this.ensureLoaded()
    const result: Array<{ toolName: string; config: ToolTunableConfig }> = []
    for (const [toolName, config] of Object.entries(this.data.tools)) {
      // 只返回有实际变更的配置
      if (config.priorityDelta !== 0 || config.timeoutMs !== null || config.maxRetries !== null || config.enabled !== true) {
        result.push({ toolName, config: { ...config } })
      }
    }
    return result.sort((a, b) => b.config.updatedAt - a.config.updatedAt)
  }

  /**
   * 应用配置变更，自动创建评估快照。
   *
   * 1. 创建评估快照（记录变更前的基线指标）
   * 2. 应用配置
   * 3. 记录变更历史
   *
   * @returns 评估快照 ID（用于后续调用 evaluateChange 评估效果）
   */
  applyChange(
    toolName: string,
    changeType: ConfigChangeType,
    newValues: Partial<ToolTunableConfig>,
    reason: string,
  ): { snapshotId: string; changed: boolean } {
    this.ensureLoaded()

    const before = this.getConfig(toolName)
    const changes = Object.keys(newValues).filter((k) => (newValues as any)[k] !== (before as any)[k])

    if (changes.length === 0) {
      return { snapshotId: '', changed: false }
    }

    // 合并新值
    const after: ToolTunableConfig = {
      ...before,
      ...newValues,
      updatedAt: Date.now(),
      reason,
    }

    // 创建评估快照
    const snapshot = toolEvalSnapshotStore.createEvalSnapshot(
      [`${changeType}: ${toolName} — ${reason}`],
      `工具配置变更前基线: ${toolName} ${changeType}`,
    )

    after.snapshotId = snapshot.id

    // 更新配置
    this.data.tools[toolName] = after
    this.persist()

    // 记录历史
    this.ensureHistoryLoaded()
    const record: ConfigChangeRecord = {
      toolName,
      changeType,
      before: this.extractChangedFields(before, newValues),
      after: newValues,
      reason,
      timestamp: Date.now(),
      snapshotId: snapshot.id,
    }
    this.history.push(record)

    // 保留最近 200 条历史
    if (this.history.length > 200) {
      this.history = this.history.slice(-200)
    }
    this.persistHistory()

    log('INFO', 'tool_config_change_applied', {
      toolName,
      changeType,
      changed: changes.join(', '),
      snapshotId: snapshot.id,
    })

    return { snapshotId: snapshot.id, changed: true }
  }

  /**
   * 评估之前的配置变更效果。
   * 如果效果为 worsened（退化），自动执行回滚。
   * 如果效果为 improved（改进）或 unchanged，标记为 kept。
   *
   * @returns 评估结果与回滚状态
   */
  evaluateAndMaybeRollback(snapshotId: string): {
    verdict: 'improved' | 'worsened' | 'unchanged' | 'not_found'
    action: 'keep' | 'rollback' | 'no_action'
    rolledBackTools: string[]
  } {
    const decision = toolEvalSnapshotStore.decide(snapshotId)
    const rolledBackTools: string[] = []

    if (decision.action === 'rollback') {
      // 查找该快照关联的所有变更
      const relatedChanges = this.history.filter((h) => h.snapshotId === snapshotId)
      for (const change of relatedChanges) {
        this.rollbackChange(change)
        rolledBackTools.push(change.toolName)
      }
    } else if (decision.action === 'keep') {
      // 标记变更记录为 kept
      this.history.forEach((h) => {
        if (h.snapshotId === snapshotId) {
          h.evalResult = 'kept'
        }
      })
      this.persistHistory()
    }

    return {
      verdict: decision.verdict,
      action: decision.action,
      rolledBackTools,
    }
  }

  /**
   * 获取指定工具是否可优化（冷却/样本检查）
   * 避免在同一个工具上频繁执行配置变更
   */
  canOptimize(toolName: string, minNewCalls: number = MIN_NEW_CALLS_BEFORE_RE_EVAL): boolean {
    const config = this.getConfig(toolName)

    // 未变过的工具始终可优化
    if (config.updatedAt === 0) return true

    // 检查自上次变更以来是否有足够的新的调用记录
    const snapshotId = config.snapshotId
    if (snapshotId) {
      const snapshot = toolEvalSnapshotStore.getSnapshot(snapshotId)
      if (snapshot) {
        const currentStats = this.getToolCurrentCalls(toolName)
        const baselineCalls = snapshot.beforeMetrics.byTool.find((bt) => bt.toolName === toolName)?.totalCalls ?? 0
        const newCalls = currentStats - baselineCalls
        if (newCalls < minNewCalls) {
          return false // 新调用不够，暂不评估
        }
      }
    }

    return true
  }

  /**
   * 清除所有调优配置（重置为默认值）
   */
  resetAll(): number {
    this.ensureLoaded()
    const count = Object.keys(this.data.tools).length
    this.data.tools = {}
    this.persist()
    log('INFO', 'tool_config_all_reset', { resetCount: count })
    return count
  }

  /**
   * 获取变更历史（最近 N 条）
   */
  getHistory(limit: number = 50): ConfigChangeRecord[] {
    this.ensureHistoryLoaded()
    return [...this.history].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit)
  }

  /**
   * 获取待评估的变更（有 snapshot 但尚未决定 keep/rollback）
   */
  getPendingEvaluations(): ConfigChangeRecord[] {
    this.ensureHistoryLoaded()
    return this.history.filter((h) => h.evalResult === undefined || h.evalResult === null)
  }

  /** 获取配置统计 */
  getStats(): {
    configuredTools: number
    totalChanges: number
    pendingEvaluations: number
    rolledBackChanges: number
  } {
    this.ensureLoaded()
    this.ensureHistoryLoaded()
    return {
      configuredTools: Object.keys(this.data.tools).length,
      totalChanges: this.history.length,
      pendingEvaluations: this.getPendingEvaluations().length,
      rolledBackChanges: this.history.filter((h) => h.evalResult === 'rolled_back').length,
    }
  }

  // ==================== 内部方法 ====================

  /**
   * 回滚单条变更记录
   */
  private rollbackChange(record: ConfigChangeRecord): void {
    this.ensureLoaded()

    const current = this.getConfig(record.toolName)
    const rolledBack: ToolTunableConfig = {
      ...current,
      ...record.before,
      updatedAt: Date.now(),
      reason: `自动回滚: ${record.reason}`,
    }

    this.data.tools[record.toolName] = rolledBack
    record.evalResult = 'rolled_back'

    this.persist()
    this.persistHistory()

    log('INFO', 'tool_config_auto_rolled_back', {
      toolName: record.toolName,
      changeType: record.changeType,
      originalReason: record.reason,
    })
  }

  /**
   * 提取变更字段（只保留 newValues 中提及的字段）
   */
  private extractChangedFields(before: ToolTunableConfig, newValues: Partial<ToolTunableConfig>): Partial<ToolTunableConfig> {
    const result: Partial<ToolTunableConfig> = {}
    for (const key of Object.keys(newValues) as (keyof ToolTunableConfig)[]) {
      if (key in before) {
        ;(result as any)[key] = (before as any)[key]
      }
    }
    return result
  }

  /**
   * 获取指定工具当前总的调用次数
   */
  private getToolCurrentCalls(toolName: string): number {
    try {
      const stats = toolCallLogStore.getStats()
      return stats.byTool[toolName]?.total ?? 0
    } catch {
      return 0
    }
  }
}

// =============================================================================
// 全局单例
// =============================================================================

export const toolConfigManager = new ToolConfigManager()

