/**
 * BlogModeService — 博客写作双模式切换服务
 *
 * 职责：
 * 1. 管理博客写作的执行模式（MCP / Plan:推理链）
 * 2. 通过 BlogModeMonitor 监控条件变化，自动推荐/执行模式切换
 * 3. 切换时做状态快照保存与恢复，保证无缝过渡
 * 4. 发布模式切换事件，供其他模块消费
 *
 * 工作流：
 *   startSession(topic) →
 *     monitor.recommendMode() → 选择最优模式 →
 *     在选定模式下执行 →
 *     checkAndAutoSwitch() 在每次用户输入后评估是否需要切换 →
 *     需要切换 → captureSnapshot() → switchMode() → restoreSnapshot()
 *
 * 状态流：
 *   用户输入 → Monitor 评估 → 需要切换?
 *     ├─ 否 → 继续当前模式
 *     └─ 是 → 快照(当前模式状态) → 切换到新模式 → 恢复(保存的输出)
 */

import { log } from '../../logger/Logger'
import { eventBus } from '../../core/EventBus'
import { blogModeMonitor } from './BlogModeMonitor'
import type {
  BlogExecutionMode,
  ModeSwitchSnapshot,
  ModeSwitchRequest,
  ModeSwitchResult,
  ModeSwitchLogEntry,
  ModeRecommendation,
} from './BlogExecutionMode'
import type { BlogSessionState } from './types'

// =============================================================================
// 常量
// =============================================================================

/** 快照保留时间（1 小时） */
const SNAPSHOT_TTL_MS = 60 * 60 * 1000

/** 最大保留快照数 */
const MAX_SNAPSHOTS = 50

/** 切换冷却时间（5 秒内不重复切换） */
const SWITCH_COOLDOWN_MS = 5_000

// =============================================================================
// BlogModeService
// =============================================================================

export class BlogModeService {
  /** 当前全局执行模式（对新会话的默认值） */
  private defaultMode: BlogExecutionMode = 'mcp'

  /** 按会话 ID 索引的当前模式 */
  private sessionModes = new Map<string, BlogExecutionMode>()

  /** 按会话 ID 索引的模式切换快照 */
  private snapshots = new Map<string, ModeSwitchSnapshot[]>()

  /** 切换审计日志 */
  private auditLog: ModeSwitchLogEntry[] = []

  /** 上次切换时间（冷却控制） */
  private lastSwitchTime = 0

  constructor() {
    // 周期性清理过期快照
    setInterval(() => this.cleanExpiredSnapshots(), 10 * 60 * 1000)
    log('INFO', 'blog_mode_service_init', { defaultMode: this.defaultMode })
  }

  // ==========================================================================
  // 模式查询
  // ==========================================================================

  /**
   * 获取会话的当前执行模式
   */
  getSessionMode(sessionId: string): BlogExecutionMode {
    return this.sessionModes.get(sessionId) ?? this.defaultMode
  }

  /**
   * 获取全部默认模式
   */
  getDefaultMode(): BlogExecutionMode {
    return this.defaultMode
  }

  /**
   * 设置全局默认模式
   */
  setDefaultMode(mode: BlogExecutionMode): void {
    const old = this.defaultMode
    this.defaultMode = mode
    log('INFO', 'blog_default_mode_changed', {
      from: old,
      to: mode,
    })
  }

  // ==========================================================================
  // 启动会话（含模式推荐）
  // ==========================================================================

  /**
   * 以推荐模式启动博客写作会话
   *
   * @param topic 博客主题
   * @param userInput 用户初始输入
   * @param profile 写作习惯画像
   * @returns 推荐模式及推荐详情
   */
  startWithModeRecommendation(
    topic: string,
    userInput: string,
    profile?: { totalSessions: number; avgRevisionRounds: number; prefersOutline: boolean; preferredLengthRange: { min: number; max: number } },
  ): ModeRecommendation {
    // 构造写作习惯画像（仅传递模式推荐需要的字段）
    const habitProfile = profile
      ? {
          totalSessions: profile.totalSessions,
          avgRevisionRounds: profile.avgRevisionRounds,
          prefersOutline: profile.prefersOutline,
          preferredLengthRange: { ...profile.preferredLengthRange },
          commonTopics: [],
          commonPlatforms: [],
          stylePreferences: [],
          preferredHour: null,
          hasFixedSchedule: false,
          preferredPublishDay: null,
          lastUpdated: 0,
        }
      : undefined

    return blogModeMonitor.recommendMode(topic, userInput, habitProfile)
  }

  /**
   * 在会话启动后注册其模式
   */
  registerSession(sessionId: string, mode?: BlogExecutionMode): void {
    this.sessionModes.set(sessionId, mode ?? this.defaultMode)
  }

  /**
   * 移除会话（清理状态）
   */
  unregisterSession(sessionId: string): void {
    this.sessionModes.delete(sessionId)
    this.snapshots.delete(sessionId)
  }

  // ==========================================================================
  // 模式切换核心逻辑
  // ==========================================================================

  /**
   * 请求切换模式
   *
   * 切换流程：
   * 1. 检查冷却时间
   * 2. 生成当前状态快照
   * 3. 切换模式（更新 sessionModes map）
   * 4. 触发切换事件
   * 5. 记录审计日志
   */
  async switchMode(request: ModeSwitchRequest, sessionState?: BlogSessionState | null): Promise<ModeSwitchResult> {
    const startedAt = Date.now()
    const warnings: string[] = []
    const currentMode = this.getSessionMode(request.sessionId)

    // 检查是否已在目标模式
    if (currentMode === request.targetMode && !request.force) {
      return {
        success: true,
        fromMode: currentMode,
        toMode: request.targetMode,
        durationMs: 0,
        warnings: ['已在目标模式下，无需切换'],
      }
    }

    // 检查冷却时间
    const timeSinceLastSwitch = Date.now() - this.lastSwitchTime
    if (timeSinceLastSwitch < SWITCH_COOLDOWN_MS && !request.force) {
      warnings.push(`切换冷却中（${SWITCH_COOLDOWN_MS - timeSinceLastSwitch}ms 后可用）`)
      if (!request.force) {
        return {
          success: false,
          fromMode: currentMode,
          toMode: request.targetMode,
          durationMs: Date.now() - startedAt,
          error: '切换冷却中',
          warnings,
        }
      }
    }

    try {
      // 1. 生成快照
      const snapshot = this.captureSnapshot(request.sessionId, currentMode, request.targetMode, sessionState)

      // 2. 切换模式
      this.sessionModes.set(request.sessionId, request.targetMode)
      this.lastSwitchTime = Date.now()

      // 3. 发出切换事件
      eventBus.emit('blog.mode.switched', {
        sessionId: request.sessionId,
        fromMode: currentMode,
        toMode: request.targetMode,
        reason: request.reason,
        snapshotId: snapshot.snapshotId,
        timestamp: Date.now(),
      })

      // 4. 记录审计日志
      const durationMs = Date.now() - startedAt
      this.auditLog.push({
        timestamp: Date.now(),
        sessionId: request.sessionId,
        fromMode: currentMode,
        toMode: request.targetMode,
        reason: request.reason,
        success: true,
        durationMs,
        trigger: request.force ? 'forced' : 'manual',
      })

      log('INFO', 'blog_mode_switched', {
        sessionId: request.sessionId,
        from: currentMode,
        to: request.targetMode,
        reason: request.reason,
        snapshotId: snapshot.snapshotId,
        durationMs,
      })

      return {
        success: true,
        snapshotId: snapshot.snapshotId,
        fromMode: currentMode,
        toMode: request.targetMode,
        durationMs,
        warnings,
      }
    } catch (err: any) {
      const durationMs = Date.now() - startedAt
      log('ERROR', 'blog_mode_switch_failed', {
        sessionId: request.sessionId,
        from: currentMode,
        to: request.targetMode,
        error: err.message,
      })

      return {
        success: false,
        fromMode: currentMode,
        toMode: request.targetMode,
        durationMs,
        error: err.message,
        warnings: ['切换过程中出现异常，当前模式可能不一致'],
      }
    }
  }

  // ==========================================================================
  // 自动切换（由 Monitor 驱动）
  // ==========================================================================

  /**
   * 在每次用户输入后调用。
   * 自动评估是否需要切换模式。
   *
   * @returns 是否执行了切换
   */
  async checkAndAutoSwitch(
    sessionId: string,
    sessionState: BlogSessionState,
    userInput: string,
  ): Promise<{ switched: boolean; result?: ModeSwitchResult; recommendation?: ModeRecommendation }> {
    const currentMode = this.getSessionMode(sessionId)

    // 构建简化的 profile
    const profile = {
      totalSessions: 0,
      avgRevisionRounds: 1,
      prefersOutline: true,
      preferredLengthRange: { min: 800, max: 3000 },
    }

    // 让 monitor 评估是否需要切换
    const { shouldSwitch, recommendation } = blogModeMonitor.shouldSwitch(
      currentMode,
      sessionState.topic,
      userInput,
      profile,
    )

    if (!shouldSwitch) {
      return { switched: false, recommendation }
    }

    // 执行自动切换
    const result = await this.switchMode(
      {
        sessionId,
        targetMode: recommendation.recommendedMode,
        reason: recommendation.reasons.join('; '),
        force: false,
      },
      sessionState,
    )

    return { switched: result.success, result, recommendation }
  }

  // ==========================================================================
  // 状态快照
  // ==========================================================================

  /**
   * 捕获当前模式下的状态快照
   */
  private captureSnapshot(
    sessionId: string,
    fromMode: BlogExecutionMode,
    toMode: BlogExecutionMode,
    sessionState?: BlogSessionState | null,
  ): ModeSwitchSnapshot {
    const snapshotId = `mode_snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    const snapshot: ModeSwitchSnapshot = {
      snapshotId,
      sessionId,
      fromMode,
      toMode,
      capturedAt: Date.now(),
      sessionState: sessionState ?? null,
      modeState: {},
      completedStageOutputs: sessionState?.stageOutputs ?? {},
      userFeedback: sessionState?.userFeedback ?? [],
      restored: false,
    }

    // 按会话 ID 存储快照
    const existing = this.snapshots.get(sessionId) ?? []
    existing.push(snapshot)
    this.snapshots.set(sessionId, existing)

    // 限制快照数量
    if (existing.length > MAX_SNAPSHOTS) {
      const removed = existing.shift()
      if (removed) log('DEBUG', 'blog_mode_snapshot_pruned', { snapshotId: removed.snapshotId })
    }

    log('DEBUG', 'blog_mode_snapshot_captured', {
      snapshotId,
      sessionId,
      fromMode,
      toMode,
      hasSessionState: !!sessionState,
    })

    return snapshot
  }

  /**
   * 恢复到指定快照
   */
  restoreSnapshot(snapshotId: string): ModeSwitchSnapshot | null {
    for (const [, snapshots] of this.snapshots) {
      const snapshot = snapshots.find((s) => s.snapshotId === snapshotId)
      if (snapshot) {
        snapshot.restored = true
        log('INFO', 'blog_mode_snapshot_restored', {
          snapshotId,
          sessionId: snapshot.sessionId,
          from: snapshot.fromMode,
          to: snapshot.toMode,
        })
        return snapshot
      }
    }
    return null
  }

  /**
   * 获取会话的快照列表
   */
  getSnapshots(sessionId: string): ModeSwitchSnapshot[] {
    return this.snapshots.get(sessionId) ?? []
  }

  /**
   * 清理过期快照
   */
  private cleanExpiredSnapshots(): void {
    const now = Date.now()
    let cleanedCount = 0

    for (const [sessionId, snapshots] of this.snapshots) {
      const valid = snapshots.filter((s) => now - s.capturedAt < SNAPSHOT_TTL_MS)
      if (valid.length !== snapshots.length) {
        cleanedCount += snapshots.length - valid.length
        this.snapshots.set(sessionId, valid)
      }
    }

    if (cleanedCount > 0) {
      log('DEBUG', 'blog_mode_snapshot_cleanup', { cleanedCount })
    }
  }

  // ==========================================================================
  // 审计与状态报告
  // ==========================================================================

  /**
   * 生成会话的模式状态报告
   */
  getModeReport(sessionId: string): {
    currentMode: BlogExecutionMode
    defaultMode: BlogExecutionMode
    snapshotCount: number
    recentSwitches: ModeSwitchLogEntry[]
  } {
    return {
      currentMode: this.getSessionMode(sessionId),
      defaultMode: this.defaultMode,
      snapshotCount: (this.snapshots.get(sessionId) ?? []).length,
      recentSwitches: this.auditLog
        .filter((entry) => entry.sessionId === sessionId)
        .slice(-10),
    }
  }

  /**
   * 生成完整的模式统计
   */
  getStats(): {
    sessionsByMode: Record<BlogExecutionMode, number>
    totalSwitches: number
    recentSwitchLog: ModeSwitchLogEntry[]
  } {
    const sessionsByMode: Record<BlogExecutionMode, number> = { mcp: 0, plan_chain: 0 }
    for (const mode of this.sessionModes.values()) {
      sessionsByMode[mode] = (sessionsByMode[mode] ?? 0) + 1
    }

    return {
      sessionsByMode,
      totalSwitches: this.auditLog.length,
      recentSwitchLog: this.auditLog.slice(-20),
    }
  }

  // ==========================================================================
  // 重置
  // ==========================================================================

  reset(): void {
    this.sessionModes.clear()
    this.snapshots.clear()
    this.auditLog = []
    this.lastSwitchTime = 0
    blogModeMonitor.reset()
    log('INFO', 'blog_mode_service_reset')
  }
}

// =============================================================================
// 全局单例
// =============================================================================

export const blogModeService = new BlogModeService()
