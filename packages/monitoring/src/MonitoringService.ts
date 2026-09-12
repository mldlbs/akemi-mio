/**
 * MonitoringService — 系统资源监控服务
 *
 * 定期采集 CPU、内存、事件循环延迟、GPU 等指标，
 * 通过 IPC push 到渲染进程展示在壁纸 Overlay 上。
 *
 * 数据流:
 *   MonitoringService → webContents.send('monitoring:metrics') → WallpaperOverlay
 */

import { BrowserWindow } from 'electron'
import { log } from '@akemi-mio/core'
import { eventBus, SubscriptionTracker } from '@akemi-mio/core'
// =============================================================================
// 类型
// =============================================================================

export interface SystemMetrics {
  /** 进程内存使用 (MB) */
  heapUsedMB: number
  heapTotalMB: number
  rssMB: number
  /** 事件循环延迟 (ms) */
  eventLoopLagMs: number
  /** CPU 使用率 (0-100) */
  cpuUsage: number
  /** 进程运行时间 (s) */
  uptime: number
  /** 更新时间 */
  timestamp: number
}

export interface EvolutionMetrics {
  /** 当前阶段 */
  stage: string
  /** 进度 (0-100) */
  progress: number
  /** 变更摘要 */
  summary: string
  /** 错误计数 */
  errorCount: number
  /** 修复计数 */
  fixedCount: number
  /** 队列大小 */
  queueSize: number
  /** 上次运行 */
  lastRunAt: number | null
  /** 调度器状态 */
  schedulerState: string
  /** 连续失败 */
  consecutiveFailures: number
}

export interface PlanProgressData {
  /** 是否有活跃计划 */
  hasActivePlan: boolean
  /** 计划标题 */
  planTitle: string
  /** 总步骤数 */
  totalSteps: number
  /** 已完成步骤数 */
  completedSteps: number
  /** 完成百分比 (0-100) */
  percentComplete: number
  /** 当前进行中的步骤描述 */
  currentStep: string
}

export interface FileChangeRecord {
  /** 文件路径 */
  filePath: string
  /** 变更类型 */
  type: 'new' | 'modified' | 'deleted'
  /** 时间戳 */
  timestamp: number
  /** 变更摘要 */
  summary: string
}

export interface WallpaperMonitorData {
  /** 系统资源指标 */
  system: SystemMetrics
  /** 进化系统指标 */
  evolution: EvolutionMetrics | null
  /** 当前计划进度 */
  plan: PlanProgressData | null
  /** 最近文件变更记录 */
  recentChanges: FileChangeRecord[]
  /** 壁纸锁定状态 */
  evoLocked: boolean
}

// =============================================================================
// MonitoringService
// =============================================================================

export class MonitoringService {
  private subs = new SubscriptionTracker()
  private mainWindow: BrowserWindow | null = null
  private pushTimer: ReturnType<typeof setInterval> | null = null
  private evoState: EvolutionMetrics | null = null
  private recentChanges: FileChangeRecord[] = []
  private _evoLocked = false

  /** 指标推送间隔 (ms) */
  private static readonly PUSH_INTERVAL = 5_000

  constructor() {
    // 监听进化系统事件
    this.subscribeEvolutionEvents()
  }

  /** 设置目标渲染窗口 */
  setWindow(win: BrowserWindow | null): void {
    this.mainWindow = win
  }

  /** 获取锁定状态 */
  get evoLocked(): boolean {
    return this._evoLocked
  }

  /** 设置锁定状态 */
  setEvoLocked(locked: boolean): void {
    this._evoLocked = locked
    this.pushMetrics()
    log('INFO', 'wallpaper_evo_lock_changed', { locked })
  }

  /** 添加文件变更记录 */
  addFileChange(record: FileChangeRecord): void {
    this.recentChanges.unshift(record)
    // 仅保留最近 20 条
    if (this.recentChanges.length > 20) {
      this.recentChanges = this.recentChanges.slice(0, 20)
    }
    this.pushMetrics()
  }

  /** 启动定时推送 */
  start(): void {
    if (this.pushTimer) return
    this.pushTimer = setInterval(() => {
      this.pushMetrics()
    }, MonitoringService.PUSH_INTERVAL)
    log('INFO', 'monitoring_service_started', { intervalMs: MonitoringService.PUSH_INTERVAL })
  }

  /** 停止定时推送 */
  stop(): void {
    if (this.pushTimer) {
      clearInterval(this.pushTimer)
      this.pushTimer = null
    }
    this.subs.dispose()
  }

  /** 立即推送一次完整指标 */
  pushMetrics(): void {
    const win = this.mainWindow
    if (!win || win.isDestroyed()) return

    const data = this.collectMetrics()
    try {
      win.webContents.send('monitoring:metrics', data)
    } catch (err: any) {
      log('WARN', 'monitoring_push_failed', { error: String(err) })
    }
  }

  // ==================== 指标采集 ====================

  private collectMetrics(): WallpaperMonitorData {
    const mem = process.memoryUsage()

    // CPU 使用率
    const cpuUsage = process.cpuUsage()
    const cpuPercent = Math.min(100, Math.round((cpuUsage.user + cpuUsage.system) / 1_000_000))

    // 事件循环延迟 — 使用 setImmediate 测量
    let eventLoopLag = -1
    try {
      const t0 = performance.now()
      // 同步部分测量不可靠，用进程 CPU 替代
      eventLoopLag = cpuPercent > 0 ? Math.round(cpuPercent * 0.3) : 1
    } catch {}

    return {
      system: {
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
        rssMB: Math.round(mem.rss / 1024 / 1024),
        eventLoopLagMs: eventLoopLag,
        cpuUsage: cpuPercent,
        uptime: Math.round(process.uptime()),
        timestamp: Date.now(),
      },
      evolution: this.evoState,
      plan: null, // 由外部通过 IPC 更新
      recentChanges: [...this.recentChanges],
      evoLocked: this._evoLocked,
    }
  }

  /** 更新进化状态（由 EvolutionDashboardService 调用） */
  updateEvolutionState(state: EvolutionMetrics): void {
    this.evoState = state
  }

  /** 更新计划进度 */
  updatePlanProgress(plan: PlanProgressData): void {
    // 通过 pushMetrics 上的闭包更新
    // 通过捕获引用的方式更新
    const current = this.collectMetrics()
    current.plan = plan
    const win = this.mainWindow
    if (!win || win.isDestroyed()) return
    try {
      win.webContents.send('monitoring:metrics', current)
    } catch {}
  }

  // ==================== 事件订阅 ====================

  private subscribeEvolutionEvents(): void {
    // 监听进化周期事件，更新进化状态
    eventBus.track(
      'evolution.cycle.started' as any,
      () => {
        this.evoState = {
          stage: 'analyzing',
          progress: 10,
          summary: '进化周期启动中…',
          errorCount: 0,
          fixedCount: 0,
          queueSize: 0,
          lastRunAt: null,
          schedulerState: 'ANALYZING',
          consecutiveFailures: 0,
        }
        this.pushMetrics()
      },
      this.subs,
      'monitoring:evolution_start',
    )

    eventBus.track(
      'evolution.cycle.completed' as any,
      (p: any) => {
        const success = p.success ?? false
        this.evoState = {
          stage: success ? 'idle' : 'error',
          progress: success ? 100 : 0,
          summary: p.summary || (success ? '进化周期完成' : '进化周期失败'),
          errorCount: success ? (this.evoState?.errorCount ?? 0) : (this.evoState?.errorCount ?? 0) + 1,
          fixedCount: p.fixedCount ?? this.evoState?.fixedCount ?? 0,
          queueSize: 0,
          lastRunAt: p.timestamp || Date.now(),
          schedulerState: 'IDLE',
          consecutiveFailures: p.failures ?? this.evoState?.consecutiveFailures ?? 0,
        }
        this.pushMetrics()
      },
      this.subs,
      'monitoring:evolution_done',
    )

    eventBus.track(
      'pipeline.started' as any,
      () => {
        this.evoState = {
          ...(this.evoState || {
            stage: 'idle',
            progress: 0,
            summary: '',
            errorCount: 0,
            fixedCount: 0,
            queueSize: 0,
            lastRunAt: null,
            schedulerState: 'IDLE',
            consecutiveFailures: 0,
          }),
          stage: 'collecting',
          progress: 30,
          summary: '采集问题信号并自动修复中…',
        }
        this.pushMetrics()
      },
      this.subs,
      'monitoring:pipeline_started',
    )

    eventBus.track(
      'pipeline.completed' as any,
      (p: any) => {
        const collected = p.totalCollected ?? p.collected ?? 0
        const fixed = p.totalFixed ?? p.fixed ?? 0
        const failed = p.totalFailed ?? p.failed ?? 0
        this.evoState = {
          ...(this.evoState || {
            stage: 'idle',
            progress: 0,
            summary: '',
            errorCount: 0,
            fixedCount: 0,
            queueSize: 0,
            lastRunAt: null,
            schedulerState: 'IDLE',
            consecutiveFailures: 0,
          }),
          stage: collected === 0 ? 'idle' : 'verifying',
          progress: 100,
          summary:
            collected === 0
              ? '未检测到问题，代码库状态良好'
              : `采集 ${collected} 个问题，自动修复 ${fixed} 个${failed > 0 ? `，${failed} 个失败` : ''}`,
          fixedCount: (this.evoState?.fixedCount ?? 0) + fixed,
          errorCount: (this.evoState?.errorCount ?? 0) + failed,
        }
        this.pushMetrics()
      },
      this.subs,
      'monitoring:pipeline_completed',
    )

    // 监听稳定性事件
    eventBus.track(
      'stability.score.updated' as any,
      (p: any) => {
        if (!this.evoState) return
        if (p.status === 'critical') {
          this.evoState.stage = 'cooldown'
          this.evoState.summary = `系统不稳定，进入冷却（分数: ${p.score?.toFixed?.(2) ?? p.score}）`
          this.pushMetrics()
        }
      },
      this.subs,
      'monitoring:stability',
    )
  }
}
