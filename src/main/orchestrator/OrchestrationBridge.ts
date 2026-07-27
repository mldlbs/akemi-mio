/**
 * OrchestrationBridge — 编排事件桥接器
 *
 * 将 ToolChainOrchestrator 的 EventBus 事件桥接到 Electron IPC，
 * 使渲染进程的 OrchestrationProgressWidget 能够实时显示编排进度。
 *
 * 使用方式：
 * ```typescript
 * const bridge = new OrchestrationBridge()
 * bridge.start(mainWindow)
 * ```
 *
 * 桥接的事件：
 * - orchestration:progress → IPC 'orchestration:progress'
 */

import { BrowserWindow } from 'electron'
import { log } from '../logger/Logger'
import { eventBus, SubscriptionTracker } from '../core/EventBus'
import { ORCHESTRATION_EVENTS } from './types'

export class OrchestrationBridge {
  private subs = new SubscriptionTracker()
  private mainWindow: BrowserWindow | null = null
  private _started = false

  /** 是否已启动 */
  get started(): boolean {
    return this._started
  }

  /**
   * 启动桥接器，订阅 EventBus 事件并转发到主窗口。
   */
  start(mainWindow: BrowserWindow | null): void {
    if (this._started) return
    this._started = true
    this.mainWindow = mainWindow

    this.subs.add(
      eventBus.on(ORCHESTRATION_EVENTS.PROGRESS as any, (progress: any) => {
        this.sendToWindow('orchestration:progress', progress)
      }),
    )

    this.subs.add(
      eventBus.on(ORCHESTRATION_EVENTS.PLAN_CREATED as any, (plan: any) => {
        log('INFO', 'orchestration_plan_created', {
          planId: plan.planId,
          steps: plan.steps?.length,
        })
      }),
    )

    this.subs.add(
      eventBus.on(ORCHESTRATION_EVENTS.COMPLETED as any, (result: any) => {
        log('INFO', 'orchestration_completed_event', {
          planId: result.planId,
          success: result.success,
          durationMs: result.totalDurationMs,
        })
      }),
    )

    log('INFO', 'orchestration_bridge_started')
  }

  /** 更新主窗口引用 */
  setWindow(win: BrowserWindow | null): void {
    this.mainWindow = win
  }

  /** 停止桥接器 */
  stop(): void {
    this.subs.dispose()
    this._started = false
    this.mainWindow = null
    log('INFO', 'orchestration_bridge_stopped')
  }

  /**
   * 发送事件到渲染进程。
   */
  private sendToWindow(channel: string, data: any): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return
    try {
      this.mainWindow.webContents.send(channel, data)
    } catch (err: any) {
      log('WARN', 'orchestration_bridge_send_failed', {
        channel,
        error: err.message,
      })
    }
  }
}
