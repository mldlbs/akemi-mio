/**
 * StateBroadcaster — 自进化系统实时状态广播器
 *
 * 以 1Hz 频率采集 Evolution 系统的当前状态、性能指标和计划进度，
 * 维护滚动历史缓冲区以支持实时曲线/热力图渲染，
 * 通过 IPC push 到渲染进程供 Canvas 仪表盘使用。
 *
 * 数据流:
 *   StateBroadcaster (1Hz) → webContents.send('evolution:dashboard:live')
 *   → EvolutionDashboardCanvas Widget (Canvas 渲染)
 *
 * 与 EvolutionDashboardService 的区别：
 *   - EvolutionDashboardService：事件驱动（仅在状态变化时推送），无历史缓冲区
 *   - StateBroadcaster：定时驱动（固定 1Hz），维护 120 帧滚动历史
 */

import { BrowserWindow } from 'electron'
import { log } from '../logger/Logger'
import type { SelfEvolutionService } from './SelfEvolutionService'
import type { PlanManagerLike } from './types'
import type { PipelineMetrics } from './automation'

// =============================================================================
// 类型定义
// =============================================================================

export interface DashboardLiveSnapshot {
  /** 调度器状态 */
  schedulerState: string
  /** 当前进化阶段（idle / analyzing / fixing / cooldown / error） */
  currentStage: string
  /** 进度百分比 (0-100) */
  progress: number
  /** 文本摘要 */
  summary: string
  /** 错误计数 */
  errorCount: number
  /** 修复计数 */
  fixedCount: number
  /** 队列大小 */
  queueSize: number
  /** 连续失败 */
  consecutiveFailures: number
  /** 上次运行时间戳 */
  lastRunAt: number | null
  /** 当前活跃计划（如果有） */
  plan: {
    hasActive: boolean
    title: string
    completedSteps: number
    totalSteps: number
    percentComplete: number
    currentStep: string
  } | null
  /** 采集时间戳 */
  timestamp: number
}

/**
 * 包含滚动历史的高频推送负载
 */
export interface DashboardLivePayload {
  /** 当前快照 */
  current: DashboardLiveSnapshot
  /** 滚动历史（最新在前），最多 120 帧 = 2 分钟 */
  history: DashboardLiveSnapshot[]
  /** 服务是否活跃 */
  active: boolean
}

// =============================================================================
// StateBroadcaster
// =============================================================================

export class StateBroadcaster {
  private service: SelfEvolutionService | null = null
  private planManager: PlanManagerLike | null = null
  private win: BrowserWindow | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private active = false

  /** 滚动历史缓冲区（最新在前） */
  private history: DashboardLiveSnapshot[] = []
  private static readonly MAX_HISTORY = 120
  private static readonly INTERVAL_MS = 2000

  /** 上次推送的 JSON 指纹，用于跳过无变化推送 */
  private lastSnapshotJson: string | null = null

  // ==================== 依赖注入 ====================

  setService(svc: SelfEvolutionService): void {
    this.service = svc
  }

  setPlanManager(pm: PlanManagerLike): void {
    this.planManager = pm
  }

  setWindow(win: BrowserWindow): void {
    this.win = win
  }

  // ==================== 生命周期 ====================

  /** 启动 1Hz 广播 */
  start(): void {
    if (this.timer) return
    this.active = true
    this.timer = setInterval(() => this.tick(), StateBroadcaster.INTERVAL_MS)
    log('INFO', 'state_broadcaster_started', { intervalMs: StateBroadcaster.INTERVAL_MS })
  }

  /** 停止广播 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.active = false
    log('INFO', 'state_broadcaster_stopped')
  }

  /** 获取历史缓冲区副本 */
  getHistory(): DashboardLiveSnapshot[] {
    return [...this.history]
  }

  /** 获取活跃状态 */
  isActive(): boolean {
    return this.active
  }

  // ==================== 内部逻辑 ====================

  private tick(): void {
    const snapshot = this.collectSnapshot()

    // 快照无变化时跳过推送（JSON 指纹比较）
    const json = JSON.stringify(snapshot)
    if (json === this.lastSnapshotJson) return
    this.lastSnapshotJson = json

    this.history.unshift(snapshot)

    // 裁剪历史缓冲区
    if (this.history.length > StateBroadcaster.MAX_HISTORY) {
      this.history = this.history.slice(0, StateBroadcaster.MAX_HISTORY)
    }

    this.pushToRenderer(snapshot)
  }

  /** 采集当前状态快照 */
  private collectSnapshot(): DashboardLiveSnapshot {
    const svc = this.service

    // 从 SelfEvolutionService 获取调度器状态
    const schedulerState = svc?.getSchedulerState() ?? 'IDLE'
    const stage = schedulerState === 'ANALYZING' ? 'analyzing' : schedulerState === 'COOLDOWN' ? 'cooldown' : 'idle'

    // 从 SelfEvolutionService 获取指标
    const pipelineMetrics = svc?.getLastPipelineMetrics() ?? null
    const consecutiveFailures = svc?.getConsecutiveFailures() ?? 0
    const lastRunAt = svc?.getLastRun() ?? 0

    // 计算进度
    const progress = this.calcProgress(stage, pipelineMetrics)

    // 采集活跃计划状态
    const planSnapshot = this.collectPlanSnapshot()

    return {
      schedulerState,
      currentStage: stage,
      progress,
      summary: pipelineMetrics
        ? `采集 ${pipelineMetrics.totalCollected} 个问题，修复 ${pipelineMetrics.totalFixed} 个`
        : stage === 'analyzing'
          ? '分析中…'
          : stage === 'cooldown'
            ? '冷却中'
            : '待机中',
      errorCount: pipelineMetrics?.totalFailed ?? 0,
      fixedCount: pipelineMetrics?.totalFixed ?? 0,
      queueSize: pipelineMetrics?.queueSize ?? 0,
      consecutiveFailures,
      lastRunAt: lastRunAt > 0 ? lastRunAt : null,
      plan: planSnapshot,
      timestamp: Date.now(),
    }
  }

  /** 采集计划进度 */
  private collectPlanSnapshot(): DashboardLiveSnapshot['plan'] {
    const pm = this.planManager
    if (!pm) return null

    try {
      const activePlan = pm.getActivePlan()
      if (!activePlan) return null

      const totalSteps = activePlan.steps?.length ?? 0
      const completedSteps = activePlan.steps?.filter((s) => s.status === 'done').length ?? 0
      const currentStep = activePlan.steps?.find((s) => s.status === 'in_progress')

      return {
        hasActive: true,
        title: activePlan.title ?? '',
        completedSteps,
        totalSteps,
        percentComplete: totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0,
        currentStep: currentStep?.description ?? '',
      }
    } catch {
      return null
    }
  }

  /** 根据阶段和管道指标计算进度百分比 */
  private calcProgress(stage: string, metrics: PipelineMetrics | null): number {
    if (stage === 'idle') return metrics && metrics.totalCollected > 0 ? 100 : 0
    if (stage === 'analyzing') return 20
    if (stage === 'cooldown') return 50
    if (stage === 'error') return 0
    return 0
  }

  /** 推送状态到渲染进程 */
  private pushToRenderer(snapshot: DashboardLiveSnapshot): void {
    const win = this.win
    if (!win || win.isDestroyed()) return

    const payload: DashboardLivePayload = {
      current: snapshot,
      history: this.history.length > 1 ? this.history.slice(1) : [],
      active: this.active,
    }

    try {
      win.webContents.send('evolution:dashboard:live', payload)
    } catch (err: any) {
      // 静默失败（窗口可能正在关闭）
    }
  }
}
