/**
 * EvolutionDashboardService — 自进化壁纸仪表盘
 *
 * 监听 Evolution 系统的 EventBus 事件，聚合为仪表盘状态 JSON，
 * 通过 IPC push 到渲染进程在桌面 overlay 上展示进化进度卡片。
 *
 * 数据流:
 *   EventBus evolution.* → DashboardService → webContents.send('evolution:dashboard') → React Component
 */

import { BrowserWindow } from 'electron'
import { log } from '@akemi-mio/core/logger/Logger'
import { eventBus, SubscriptionTracker } from '@akemi-mio/core/core/EventBus'

// =============================================================================
// 仪表盘状态类型
// =============================================================================

export interface EvolutionDashboardState {
  /** 当前进化阶段 */
  stage: 'idle' | 'collecting' | 'analyzing' | 'fixing' | 'verifying' | 'cooldown' | 'error'
  /** 进度百分比 (0-100) */
  progress: number
  /** 变更摘要 */
  summary: string
  /** 错误数量 */
  errorCount: number
  /** 本次修复数量 */
  fixedCount: number
  /** 队列剩余问题数 */
  queueSize: number
  /** 上次运行时间戳 */
  lastRunAt: number | null
  /** 调度器状态 */
  schedulerState: string
  /** 安全模式 */
  safetyMode: string
  /** 连续失败次数 */
  consecutiveFailures: number
  /** 仪表盘是否可见 */
  visible: boolean
  /** 最后更新时间 */
  updatedAt: number
}

// =============================================================================
// 默认状态
// =============================================================================

const DEFAULT_STATE: EvolutionDashboardState = {
  stage: 'idle',
  progress: 0,
  summary: '',
  errorCount: 0,
  fixedCount: 0,
  queueSize: 0,
  lastRunAt: null,
  schedulerState: 'IDLE',
  safetyMode: 'auto',
  consecutiveFailures: 0,
  visible: true,
  updatedAt: Date.now(),
}

// =============================================================================
// EvolutionDashboardService
// =============================================================================

export class EvolutionDashboardService {
  private state: EvolutionDashboardState = { ...DEFAULT_STATE }
  private subs = new SubscriptionTracker()
  private mainWindow: BrowserWindow | null = null
  private pushTimer: ReturnType<typeof setTimeout> | null = null
  /** 防抖间隔：避免事件风暴导致渲染器过载 */
  private static readonly PUSH_DEBOUNCE_MS = 500

  constructor() {
    this.registerEventListeners()
  }

  /** 设置目标渲染窗口 */
  setWindow(win: BrowserWindow | null): void {
    this.mainWindow = win
    // 窗口就绪后立即推送一次当前状态
    if (win && !win.isDestroyed()) {
      this.pushState()
    }
  }

  /** 获取当前仪表盘状态快照 */
  getState(): EvolutionDashboardState {
    return { ...this.state }
  }

  /** 切换仪表盘可见性（同时控制鼠标穿透） */
  toggleVisibility(): boolean {
    this.state.visible = !this.state.visible
    this.pushState()
    // 隐藏仪表盘时启用鼠标穿透，显示时恢复
    this.updateMouseThrough()
    log('INFO', 'evolution_dashboard_visibility', { visible: this.state.visible })
    return this.state.visible
  }

  /** 启用鼠标穿透模式（仪表盘完全隐藏时） */
  enableMouseThrough(): void {
    this.applyMouseThrough(true)
  }

  /** 禁用鼠标穿透模式（仪表盘显示时） */
  disableMouseThrough(): void {
    this.applyMouseThrough(false)
  }

  /** 直接设置 Electron 窗口的鼠标穿透属性 */
  private applyMouseThrough(enabled: boolean): void {
    const win = this.mainWindow
    if (!win || win.isDestroyed()) return
    if (process.platform !== 'win32' && process.platform !== 'linux') return
    try {
      win.setIgnoreMouseEvents(enabled, { forward: true })
    } catch {
      try {
        win.setIgnoreMouseEvents(enabled)
      } catch {
        // 静默失败（某些平台不支持）
      }
    }
  }

  /** 根据仪表盘状态同步鼠标穿透 */
  private updateMouseThrough(): void {
    if (this.state.visible) {
      this.disableMouseThrough()
    } else {
      this.enableMouseThrough()
    }
  }

  /** 销毁服务，清理订阅 */
  destroy(): void {
    this.subs.dispose()
    if (this.pushTimer) {
      clearTimeout(this.pushTimer)
      this.pushTimer = null
    }
  }

  // ==================== 事件监听注册 ====================

  private registerEventListeners(): void {
    // 进化周期开始
    eventBus.track(
      'evolution.cycle.started' as any,
      (p: any) => {
        this.update({
          stage: 'analyzing',
          progress: 10,
          summary: '进化周期启动中…',
          updatedAt: Date.now(),
        })
      },
      this.subs,
      'dashboard:evolution_start',
    )

    // 调度器状态变更
    eventBus.track(
      'evolution.scheduler.state' as any,
      (p: any) => {
        this.update({
          schedulerState: p.to || p.state || 'UNKNOWN',
          updatedAt: Date.now(),
        })
      },
      this.subs,
      'dashboard:scheduler_state',
    )

    // 管道启动（PipelineOrchestrator 开始采集 + 修复流程）
    eventBus.track(
      'pipeline.started' as any,
      (p: any) => {
        this.update({
          stage: 'collecting',
          progress: 30,
          summary: `采集问题信号并自动修复中…`,
          updatedAt: Date.now(),
        })
      },
      this.subs,
      'dashboard:pipeline_started',
    )

    // 管道完成 — 来自 PipelineOrchestrator
    eventBus.track(
      'pipeline.completed' as any,
      (p: any) => {
        const collected = p.totalCollected ?? p.collected ?? 0
        const fixed = p.totalFixed ?? p.fixed ?? 0
        const failed = p.totalFailed ?? p.failed ?? 0
        const queue = p.queueSize ?? p.queueRemaining ?? p.queue ?? 0

        this.update({
          stage: collected === 0 ? 'idle' : 'verifying',
          progress: 100,
          summary:
            collected === 0
              ? '未检测到问题，代码库状态良好'
              : `采集 ${collected} 个问题，自动修复 ${fixed} 个${failed > 0 ? `，${failed} 个失败` : ''}`,
          errorCount: failed,
          fixedCount: fixed,
          queueSize: queue,
          updatedAt: Date.now(),
        })
      },
      this.subs,
      'dashboard:pipeline_completed',
    )

    // 进化周期完成
    eventBus.track(
      'evolution.cycle.completed' as any,
      (p: any) => {
        const success = p.success ?? false
        this.update({
          stage: success ? 'idle' : 'error',
          progress: success ? 100 : 0,
          summary: p.summary || (success ? '进化周期完成' : '进化周期失败'),
          errorCount: success ? this.state.errorCount : this.state.errorCount + 1,
          consecutiveFailures: p.failures ?? this.state.consecutiveFailures,
          lastRunAt: p.timestamp || Date.now(),
          updatedAt: Date.now(),
        })
      },
      this.subs,
      'dashboard:evolution_done',
    )

    // 管道错误
    eventBus.track(
      'pipeline.errored' as any,
      (p: any) => {
        this.update({
          stage: 'error',
          summary: `管道执行错误: ${p.error || '未知错误'}`,
          errorCount: this.state.errorCount + 1,
          updatedAt: Date.now(),
        })
      },
      this.subs,
      'dashboard:pipeline_errored',
    )

    // 冷却进入
    eventBus.track(
      'stability.score.updated' as any,
      (p: any) => {
        if (p.status === 'critical') {
          this.update({
            stage: 'cooldown',
            summary: `系统不稳定，进入冷却（分数: ${p.score?.toFixed?.(2) ?? p.score}）`,
            updatedAt: Date.now(),
          })
        }
      },
      this.subs,
      'dashboard:stability',
    )
  }

  // ==================== 内部方法 ====================

  /** 合并更新并防抖推送 */
  private update(patch: Partial<EvolutionDashboardState>): void {
    Object.assign(this.state, patch)
    this.schedulePush()
  }

  /** 防抖推送 — 合并短时间内的多次更新 */
  private schedulePush(): void {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer)
    }
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      this.pushState()
    }, EvolutionDashboardService.PUSH_DEBOUNCE_MS)
  }

  /** 立即推送当前状态到渲染进程 */
  private pushState(): void {
    const win = this.mainWindow
    if (!win || win.isDestroyed()) return

    try {
      win.webContents.send('evolution:dashboard', this.getState())
    } catch (err: any) {
      log('WARN', 'evolution_dashboard_push_failed', { error: String(err) })
    }
  }
}
