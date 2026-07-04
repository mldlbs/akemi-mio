/**
 * PluginHealthGuard — 插件健康守卫
 *
 * 借用「全局快捷键冲突」领域的概念模型重新思考插件热加载：
 *
 * === 免疫系统层 (Immune System) ===
 *   Cell (细胞)          → 每个已加载的插件实例
 *   Antigen (抗原)       → 文件变更事件 / 新版本
 *   Antibody (抗体)      → 签名验证 (verifier.ts)
 *   Inflammation (炎症)  → 错误升级: log → warn → quarantine
 *   Immune Memory (免疫记忆) → 失败历史记录
 *   Quarantine (隔离)    → 连续失败后临时禁用，冷却后自动恢复
 *   Autoimmune (自身免疫) → 避免误隔离健康插件
 *
 * === 城市规划层 (Urban Planning) ===
 *   Zone (区域)          → 工具名称 (tool name)
 *   Zoning Conflict (区域冲突) → 两个插件注册同名工具
 *   Mediation (调解)     → 冲突解决策略: keep_existing / take_over / reject
 *   Land Registry (地籍) → ToolRegistry 本身
 *
 * === 进化论层 (Evolution) ===
 *   Population (种群)    → 所有已加载插件
 *   Mutation (突变)      → 插件热更新 (版本变更)
 *   Natural Selection (自然选择) → 低适应度插件自动淘汰
 *   Fitness (适应度)     → 基于成功率、错误数、运行时间的综合评分
 *   Extinction (灭绝)    → 严重故障后禁止重新加载
 */

import { log } from '../logger/Logger'
import { eventBus } from '../core/EventBus'

// ============================================================
// Types
// ============================================================

/** 插件健康状态 — 对应免疫系统中的细胞状态 */
export type PluginHealthStatus = 'healthy' | 'degraded' | 'quarantined' | 'dead'

/** 冲突调解策略 — 对应城市规划中的区域冲突解决 */
export type ConflictResolution = 'keep_existing' | 'take_over' | 'reject'

/** 插件健康记录 — 免疫系统的"细胞档案" */
export interface PluginHealthRecord {
  /** 插件名 — 细胞标识 */
  name: string
  /** 当前版本 */
  version: string
  /** 健康状态 */
  status: PluginHealthStatus
  /** 连续失败次数 (炎症指标) */
  consecutiveFailures: number
  /** 总失败次数 */
  totalFailures: number
  /** 总调用次数 */
  totalCalls: number
  /** 失败调用次数 */
  failedCalls: number
  /** 最近错误信息 */
  lastError?: string
  /** 最近错误时间 */
  lastErrorTime?: number
  /** 隔离到期时间 (0 = 未隔离) */
  quarantineUntil: number
  /** 隔离冷却倍数 (每次隔离后冷却时间翻倍，类似免疫强化) */
  quarantineMultiplier: number
  /** 热重载次数 (突变计数) */
  reloadCount: number
  /** 适应度评分 0-100 (进化论: fitness) */
  fitnessScore: number
  /** 前一个版本 (用于回滚 — 免疫系统的"记忆B细胞") */
  previousVersion?: string
  /** 前一个版本的源码路径 (用于自动回滚) */
  previousSourcePath?: string
  /** 加载时间 */
  loadedAt: number
}

/** 区域冲突记录 — 对应城市规划中的 zone conflict */
export interface ZoneConflictRecord {
  toolName: string
  existingPlugin: string
  incomingPlugin: string
  resolution: ConflictResolution
  resolvedAt: number
}

/** 隔离事件 — 对应免疫反应 */
export interface QuarantineEvent {
  pluginName: string
  reason: string
  errorDetail?: string
  quarantineDuration: number
  timestamp: number
}

// ============================================================
// Constants
// ============================================================

/** 默认隔离冷却时间 (ms) — 第一次隔离 30s */
const BASE_QUARANTINE_MS = 30_000

/** 最大隔离冷却时间 (ms) — 5 分钟上限，防止永久隔离 */
const MAX_QUARANTINE_MS = 300_000

/** 连续失败阈值 — 超过此次数触发隔离 (炎症爆发阈值) */
const FAILURE_THRESHOLD = 3

/** 适应度最低阈值 — 低于此分数自动标记为 dead (自然选择) */
const FITNESS_EXTINCTION_THRESHOLD = 10

/** 适应度初始值 */
const FITNESS_INITIAL = 80

/** 成功调用奖励分 */
const FITNESS_SUCCESS_BONUS = 0.5

/** 失败调用扣分 */
const FITNESS_FAILURE_PENALTY = 5

/** 重载成功奖励分 (证明可被热更) */
const FITNESS_RELOAD_BONUS = 3

/** 适应度上限 */
const FITNESS_MAX = 100

/** 适应度下限 */
const FITNESS_MIN = 0

// ============================================================
// PluginHealthGuard
// ============================================================

export class PluginHealthGuard {
  /** 免疫记忆 — 所有已知插件的健康档案 */
  private records = new Map<string, PluginHealthRecord>()

  /** 区域冲突日志 — 城市规划的冲突记录 */
  private zoneConflicts: ZoneConflictRecord[] = []

  /** 隔离事件日志 */
  private quarantineLog: QuarantineEvent[] = []

  /** 隔离定时器 — 用于自动解除隔离 (免疫恢复) */
  private quarantineTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // ==========================================================
  // Immune System — 免疫系统层
  // ==========================================================

  /**
   * 注册新细胞 (插件加载时调用)
   * 创建健康档案，初始化免疫记忆
   */
  registerCell(name: string, version: string, previousVersion?: string): PluginHealthRecord {
    const existing = this.records.get(name)
    const record: PluginHealthRecord = {
      name,
      version,
      status: 'healthy',
      consecutiveFailures: 0,
      totalFailures: existing?.totalFailures ?? 0,
      totalCalls: existing?.totalCalls ?? 0,
      failedCalls: existing?.failedCalls ?? 0,
      quarantineUntil: 0,
      quarantineMultiplier: existing?.quarantineMultiplier ?? 1,
      reloadCount: (existing?.reloadCount ?? 0) + 1,
      fitnessScore: existing ? Math.min(FITNESS_MAX, existing.fitnessScore + FITNESS_RELOAD_BONUS) : FITNESS_INITIAL,
      previousVersion: existing ? existing.version : previousVersion,
      loadedAt: Date.now(),
    }
    this.records.set(name, record)
    return record
  }

  /**
   * 抗原检测 — 检查插件是否处于隔离期
   * @returns true 如果允许加载 (安全)
   */
  checkAntigen(name: string): { allowed: boolean; reason?: string } {
    const record = this.records.get(name)
    if (!record) return { allowed: true }

    if (record.status === 'dead') {
      return { allowed: false, reason: `Plugin "${name}" is marked DEAD (extinction). Manual intervention required.` }
    }

    if (record.status === 'quarantined') {
      const now = Date.now()
      if (now < record.quarantineUntil) {
        const remaining = Math.ceil((record.quarantineUntil - now) / 1000)
        return { allowed: false, reason: `Plugin "${name}" is in quarantine. ${remaining}s remaining.` }
      }
      // 隔离期满，自动恢复
      this.clearQuarantine(name)
    }

    return { allowed: true }
  }

  /**
   * 炎症反应 — 记录插件错误，必要时触发隔离
   * 连续失败达到阈值 → 升级到隔离状态
   */
  reportFailure(name: string, error: string, phase: string): void {
    const record = this.records.get(name)
    if (!record) return

    record.consecutiveFailures++
    record.totalFailures++
    record.lastError = error
    record.lastErrorTime = Date.now()

    // 适应度下降
    record.fitnessScore = Math.max(FITNESS_MIN, record.fitnessScore - FITNESS_FAILURE_PENALTY)

    // 检测是否达到炎症爆发阈值
    if (record.consecutiveFailures >= FAILURE_THRESHOLD) {
      const duration = Math.min(MAX_QUARANTINE_MS, BASE_QUARANTINE_MS * record.quarantineMultiplier)
      this.quarantine(name, `連續 ${record.consecutiveFailures} 次失敗 (phase: ${phase})`, error, duration)
    } else if (record.fitnessScore <= FITNESS_EXTINCTION_THRESHOLD) {
      // 适应度过低 → 灭绝
      this.markDead(name, `適應度降至 ${record.fitnessScore}（低於閾值 ${FITNESS_EXTINCTION_THRESHOLD}）`)
    }

    eventBus.emit('plugin.health-changed', { name, status: record.status, fitnessScore: record.fitnessScore })
  }

  /**
   * 免疫成功 — 记录插件正常调用，增强适应度
   */
  reportSuccess(name: string): void {
    const record = this.records.get(name)
    if (!record) return

    record.totalCalls++
    record.consecutiveFailures = 0 // 成功调用重置连续失败
    record.fitnessScore = Math.min(FITNESS_MAX, record.fitnessScore + FITNESS_SUCCESS_BONUS)

    // 成功调用可能使 degraded → healthy
    if (record.status === 'degraded' && record.fitnessScore > 60) {
      record.status = 'healthy'
      log('INFO', 'plugin_immune_recovery', { name, fitnessScore: record.fitnessScore })
    }
  }

  /**
   * 记录工具调用结果 (用于适应度计算)
   */
  recordCallResult(name: string, success: boolean): void {
    const record = this.records.get(name)
    if (!record) return

    record.totalCalls++
    if (!success) {
      record.failedCalls++
      record.fitnessScore = Math.max(FITNESS_MIN, record.fitnessScore - FITNESS_FAILURE_PENALTY)
    } else {
      record.consecutiveFailures = 0
      record.fitnessScore = Math.min(FITNESS_MAX, record.fitnessScore + FITNESS_SUCCESS_BONUS)
    }
  }

  // ==========================================================
  // Quarantine — 隔离机制 (免疫防御)
  // ==========================================================

  /**
   * 隔离插件 — 免疫系统的防御反应
   * 临时禁用插件，设定自动恢复时间
   */
  private quarantine(name: string, reason: string, errorDetail: string | undefined, duration: number): void {
    const record = this.records.get(name)
    if (!record) return

    record.status = 'quarantined'
    record.quarantineUntil = Date.now() + duration
    record.quarantineMultiplier = Math.min(8, record.quarantineMultiplier * 2) // 指数退避

    const event: QuarantineEvent = {
      pluginName: name,
      reason,
      errorDetail,
      quarantineDuration: duration,
      timestamp: Date.now(),
    }
    this.quarantineLog.push(event)

    // 设置自动解除隔离定时器
    const existingTimer = this.quarantineTimers.get(name)
    if (existingTimer) clearTimeout(existingTimer)

    const timer = setTimeout(() => {
      this.clearQuarantine(name)
    }, duration)
    this.quarantineTimers.set(name, timer)

    log('WARN', 'plugin_quarantined', { name, reason, duration: `${duration / 1000}s` })
    eventBus.emit('plugin.quarantined', event)
  }

  /**
   * 解除隔离 — 免疫恢复
   * 隔离期满且无新错误 → 降级到 degraded
   */
  private clearQuarantine(name: string): void {
    const record = this.records.get(name)
    if (!record || record.status !== 'quarantined') return

    record.status = 'degraded'
    record.quarantineUntil = 0
    record.consecutiveFailures = 0

    // 保留较高冷却倍数，下次再犯错隔离更久 (免疫强化)
    // 但降级期间如果连续成功，会逐步恢复

    log('INFO', 'plugin_quarantine_cleared', { name, fitnessScore: record.fitnessScore })
    eventBus.emit('plugin.health-changed', { name, status: 'degraded', fitnessScore: record.fitnessScore })
  }

  /**
   * 标记插件死亡 — 进化论中的灭绝
   * 永久禁止加载，需手动干预
   */
  private markDead(name: string, reason: string): void {
    const record = this.records.get(name)
    if (!record) return

    record.status = 'dead'
    log('ERROR', 'plugin_extinct', { name, reason, fitnessScore: record.fitnessScore })
    eventBus.emit('plugin.dead', { name, reason, fitnessScore: record.fitnessScore })
  }

  /**
   * 手动复活插件 — 管理员干预
   */
  resurrect(name: string): boolean {
    const record = this.records.get(name)
    if (!record || record.status !== 'dead') return false

    record.status = 'degraded'
    record.fitnessScore = 30 // 给一次重生机会
    record.consecutiveFailures = 0
    record.quarantineMultiplier = 1
    log('INFO', 'plugin_resurrected', { name })
    eventBus.emit('plugin.health-changed', { name, status: 'degraded', fitnessScore: 30 })
    return true
  }

  // ==========================================================
  // Urban Planning — 城市规划层 (区域冲突调解)
  // ==========================================================

  /**
   * 调解区域冲突 — 两个插件争夺同一个工具名
   *
   * 策略:
   *   keep_existing — 保留现有 (先到先得，类似 grandfather clause)
   *   take_over     — 新插件接管 (类似 eminent domain)
   *   reject        — 拒绝新插件注册 (类似 zoning board 拒绝)
   */
  mediateConflict(
    toolName: string,
    existingPlugin: string,
    incomingPlugin: string,
    strategy: ConflictResolution = 'keep_existing',
  ): ZoneConflictRecord {
    const record: ZoneConflictRecord = {
      toolName,
      existingPlugin,
      incomingPlugin,
      resolution: strategy,
      resolvedAt: Date.now(),
    }
    this.zoneConflicts.push(record)

    log('WARN', 'plugin_zone_conflict', {
      toolName,
      existingPlugin,
      incomingPlugin,
      resolution: strategy,
    })
    eventBus.emit('plugin.zone-conflict', record)
    return record
  }

  /**
   * 查询区域归属 — 最近的冲突中谁拥有某个工具名
   */
  getZoneOwner(toolName: string): string | undefined {
    // 倒序查找最近冲突
    for (let i = this.zoneConflicts.length - 1; i >= 0; i--) {
      const c = this.zoneConflicts[i]
      if (c.toolName === toolName) {
        return c.resolution === 'take_over' ? c.incomingPlugin : c.existingPlugin
      }
    }
    return undefined
  }

  /**
   * 获取所有区域冲突记录
   */
  getZoneConflicts(): ZoneConflictRecord[] {
    return [...this.zoneConflicts]
  }

  // ==========================================================
  // Evolution — 进化论层 (适应度 & 自然选择)
  // ==========================================================

  /**
   * 计算适应度分数
   * 公式: 基础分 + 成功率*权重 - 失败率*权重 + 重载奖励 - 隔离惩罚
   */
  getFitness(name: string): number {
    const record = this.records.get(name)
    return record?.fitnessScore ?? FITNESS_INITIAL
  }

  /**
   * 自然选择 — 返回所有低于阈值的插件名
   * 用于定期清理 (可由外部定时器调用)
   */
  naturalSelection(): string[] {
    const condemned: string[] = []
    for (const [name, record] of this.records) {
      if (record.status === 'healthy' && record.fitnessScore <= FITNESS_EXTINCTION_THRESHOLD) {
        this.markDead(name, `自然選擇: 適應度 ${record.fitnessScore} 低於閾值`)
        condemned.push(name)
      }
    }
    return condemned
  }

  /**
   * 突变追踪 — 记录热重载 (版本变更)
   * 返回突变是否成功 (基于前几次突变的结果预测)
   */
  trackMutation(name: string, newVersion: string, oldVersion: string): { risky: boolean; warning?: string } {
    const record = this.records.get(name)
    if (!record) return { risky: false }

    const isRisky = record.consecutiveFailures > 0 || record.status === 'degraded'
    if (isRisky) {
      return {
        risky: true,
        warning: `Plugin "${name}" 處於不穩定狀態 (failures=${record.consecutiveFailures}, fitness=${record.fitnessScore})，本次熱重載風險較高`,
      }
    }
    return { risky: false }
  }

  // ==========================================================
  // Query API
  // ==========================================================

  /** 获取插件健康记录 */
  getRecord(name: string): PluginHealthRecord | undefined {
    return this.records.get(name)
  }

  /** 获取所有健康记录 */
  getAllRecords(): PluginHealthRecord[] {
    return Array.from(this.records.values())
  }

  /** 获取隔离日志 */
  getQuarantineLog(): QuarantineEvent[] {
    return [...this.quarantineLog]
  }

  /** 统计总览 */
  getStats(): {
    total: number
    healthy: number
    degraded: number
    quarantined: number
    dead: number
    totalZoneConflicts: number
    averageFitness: number
  } {
    const records = Array.from(this.records.values())
    const statusCount = { healthy: 0, degraded: 0, quarantined: 0, dead: 0 }
    let totalFitness = 0

    for (const r of records) {
      statusCount[r.status]++
      totalFitness += r.fitnessScore
    }

    return {
      total: records.length,
      ...statusCount,
      totalZoneConflicts: this.zoneConflicts.length,
      averageFitness: records.length > 0 ? Math.round(totalFitness / records.length) : 0,
    }
  }

  /** 移除插件记录 (插件卸载时调用) */
  removeRecord(name: string): void {
    const timer = this.quarantineTimers.get(name)
    if (timer) {
      clearTimeout(timer)
      this.quarantineTimers.delete(name)
    }
    this.records.delete(name)
  }

  /** 完全重置所有状态 (用于测试或系统重置) */
  reset(): void {
    for (const timer of this.quarantineTimers.values()) {
      clearTimeout(timer)
    }
    this.quarantineTimers.clear()
    this.records.clear()
    this.zoneConflicts = []
    this.quarantineLog = []
  }
}

/** 全局单例 — 类似于免疫系统是全身性的 */
export const pluginHealthGuard = new PluginHealthGuard()
