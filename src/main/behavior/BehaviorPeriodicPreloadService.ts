/**
 * BehaviorPeriodicPreloadService — 空闲时段内容预加载 + 哑提醒推送
 *
 * ## 职责
 * 1. 定期检查当前时段和即将到来时段的预测
 * 2. 对有预加载价值的预测执行内容预加载
 * 3. 通过 IPC 向渲染进程推送哑提醒
 * 4. 管理预加载状态，避免重复预加载
 *
 * ## 轻打扰展示
 * - 使用 `behavior:prediction` IPC 事件推送
 * - 渲染进程显示为小图标/徽标，不抢占焦点
 * - 用户可一键忽略 (dismiss)
 * - 同一预测 30 分钟内不重复推送
 *
 * ## 集成点
 * - 依赖 BehaviorPeriodicPredictor 获取预测模型
 * - 注入 PreloadExecutor 以执行实际内容预加载
 * - 注入 NotifyRenderer 以推送 IPC 事件到渲染进程
 * - 在 AppRuntime 中以 lazyInit 方式启动
 *
 * ## 资源保护
 * - 并发预加载任务受限 (MAX_CONCURRENT_PRELOADS)
 * - 预加载超时保护 (PRELOAD_TIMEOUT_MS)
 * - 相同话题在 MIN_REPEAT_INTERVAL_MS 内不重复推送
 * - 低置信度预测不触发任何操作
 */

import { log } from '../logger/Logger'
import {
  BehaviorPeriodicPredictor,
  behaviorPeriodicPredictor,
  type TimeSlotPrediction,
  type PeriodicQueryPrediction,
  type PeriodicPredictionEvent,
} from './BehaviorPeriodicPredictor'
import { asrKeywordActionTracker } from './AsrKeywordActionTracker'

// ══════════════════════════════════════════
//  常量
// ══════════════════════════════════════════

/** 检查间隔：每 15 分钟检查一次 */
const CHECK_INTERVAL_MS = 15 * 60 * 1000

/** 预测事件过期时间（展示后 5 分钟） */
const PREDICTION_EXPIRY_MS = 5 * 60 * 1000

/** 同一话题的最小重复间隔（30 分钟） */
const MIN_REPEAT_INTERVAL_MS = 30 * 60 * 1000

/** 预加载超时 */
const PRELOAD_TIMEOUT_MS = 8_000

/** 最多同时进行的预加载数 */
const MAX_CONCURRENT_PRELOADS = 2

// ══════════════════════════════════════════
//  BehaviorPeriodicPreloadService
// ══════════════════════════════════════════

export class BehaviorPeriodicPreloadService {
  private timer: ReturnType<typeof setInterval> | null = null
  private predictor: BehaviorPeriodicPredictor
  private running = false

  /** 已发送的事件 ID → 时间戳（去重） */
  private sentEvents = new Map<string, number>()
  /** 活跃的预加载任务 */
  private activePreloads = new Set<string>()
  /** 外部注入的预加载执行器 */
  private preloadExecutor: ((prediction: PeriodicQueryPrediction) => Promise<string | null>) | null = null
  /** 外部注入的 IPC 推送函数 */
  private notifyRenderer: ((event: PeriodicPredictionEvent) => void) | null = null

  constructor(predictor: BehaviorPeriodicPredictor) {
    this.predictor = predictor
  }

  // ══════════════════════════════════════════
  //  依赖注入
  // ══════════════════════════════════════════

  /**
   * 注入预加载执行器。
   * 当需要为预测预取数据时调用。
   * 例如：注入一个执行 weather API 调用的函数来预缓存天气数据。
   */
  setPreloadExecutor(exec: (prediction: PeriodicQueryPrediction) => Promise<string | null>): void {
    this.preloadExecutor = exec
  }

  /**
   * 注入渲染进程通知函数。
   * 当预测准备好时，通过此函数推送哑提醒。
   * 通常由 AppRuntime 注入，包装为 `mainWindow.webContents.send('behavior:prediction', event)`。
   */
  setNotifyRenderer(notify: (event: PeriodicPredictionEvent) => void): void {
    this.notifyRenderer = notify
  }

  // ══════════════════════════════════════════
  //  生命周期
  // ══════════════════════════════════════════

  /**
   * 启动定时检查。
   * 首次执行延迟 30 秒等系统稳定，后续按指定的间隔运行。
   */
  start(intervalMs: number = CHECK_INTERVAL_MS): void {
    if (this.timer) return

    log('INFO', 'periodic_preload_service_started', {
      intervalMs,
      intervalMinutes: Math.round(intervalMs / 60_000),
    })

    // 首次执行延迟 30 秒
    setTimeout(() => {
      this.checkAndPreload().catch((err) =>
        log('WARN', 'periodic_preload_first_check_failed', { error: String(err) }),
      )
    }, 30_000)

    this.timer = setInterval(() => {
      this.checkAndPreload().catch((err) =>
        log('WARN', 'periodic_preload_check_failed', { error: String(err) }),
      )
    }, intervalMs)
  }

  /** 停止定时检查 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    log('INFO', 'periodic_preload_service_stopped')
  }

  /** 是否正在运行 */
  isRunning(): boolean {
    return this.timer !== null
  }

  // ══════════════════════════════════════════
  //  核心检查周期
  // ══════════════════════════════════════════

  /**
   * 执行一次检查 + 预加载周期。
   *
   * 1. 获取当前时段预测
   * 2. 获取即将到来时段（最多 1 小时）的预测
   * 3. 对有 suggestPreload 标签的预测执行异步预加载
   * 4. 推送哑提醒到渲染进程
   */
  async checkAndPreload(): Promise<void> {
    if (this.running) return
    this.running = true

    try {
      // 1. 获取当前时段和即将到来时段的预测
      const currentSlot = this.predictor.predictCurrentSlot()
      const upcomingSlots = this.predictor.predictUpcomingSlots(4)

      // 2. 收集所有需要处理的预测
      const toProcess: Array<{ prediction: PeriodicQueryPrediction }> = []

      if (currentSlot && currentSlot.actionable) {
        for (const p of currentSlot.predictions) {
          if (p.suggestPreload) {
            toProcess.push({ prediction: p })
          }
        }
      }

      for (const slot of upcomingSlots) {
        for (const p of slot.predictions) {
          if (p.suggestPreload) {
            toProcess.push({ prediction: p })
          }
        }
      }

      // ── 3. ASR 关键词动作预测 ──
      const asrHints: Array<{ message: string; icon: string; category: string; confidence: number }> = []
      try {
        const asrSlot = asrKeywordActionTracker.predictCurrentSlot()
        if (asrSlot && asrSlot.actionable) {
          for (const p of asrSlot.predictions) {
            if (p.suggestHint) {
              asrHints.push({
                message: p.hintMessage,
                icon: p.icon,
                category: p.category,
                confidence: p.confidence,
              })
            }
          }
        }
      } catch {
        // ASR 关键词跟踪器不可用时优雅降级
      }

      // ── 推送 ASR 动作提示 ──
      if (asrHints.length > 0 && this.notifyRenderer) {
        const now = Date.now()
        for (const hint of asrHints) {
          const eventId = `asr_${hint.category}_${now}`
          const lastSent = this.sentEvents.get(`asr:${hint.category}`) ?? 0
          if (now - lastSent < MIN_REPEAT_INTERVAL_MS) continue

          const event: PeriodicPredictionEvent = {
            topic: hint.category,
            description: hint.message,
            confidence: hint.confidence,
            associatedTool: undefined,
            preloaded: false,
            eventId,
            expiresAt: now + PREDICTION_EXPIRY_MS,
          }
          this.notifyRenderer(event)
          this.sentEvents.set(`asr:${hint.category}`, now)
        }
      }

      if (toProcess.length === 0 && asrHints.length === 0) {
        log('DEBUG', 'periodic_preload_no_actionable_predictions')
        return
      }

      // 4. 按话题去重
      const seenTopics = new Set<string>()
      const uniquePredictions = toProcess.filter(({ prediction }) => {
        if (seenTopics.has(prediction.topic)) return false
        seenTopics.add(prediction.topic)
        return true
      })

      // 4. 并行处理每个预测
      const promises = uniquePredictions.map(async ({ prediction }) => {
        const eventId = `pred_${prediction.topic}_${Date.now()}`
        const now = Date.now()

        // 检查重复推送
        const lastSent = this.sentEvents.get(prediction.topic) ?? 0
        if (now - lastSent < MIN_REPEAT_INTERVAL_MS) {
          log('DEBUG', 'periodic_preload_skip_repeat', {
            topic: prediction.topic,
            lastSent: new Date(lastSent).toISOString(),
          })
          return
        }

        // 执行预加载（如果有执行器且未达并发上限）
        let preloaded = false
        if (this.preloadExecutor && this.activePreloads.size < MAX_CONCURRENT_PRELOADS) {
          const cacheKey = `periodic:${prediction.topic}`
          if (!this.activePreloads.has(cacheKey)) {
            this.activePreloads.add(cacheKey)
            try {
              const timeoutPromise = new Promise<null>((_, reject) =>
                setTimeout(() => reject(new Error('Preload timeout')), PRELOAD_TIMEOUT_MS),
              )
              const result = await Promise.race([
                this.preloadExecutor(prediction),
                timeoutPromise,
              ])
              preloaded = result !== null && result.length > 0
            } catch (err) {
              log('DEBUG', 'periodic_preload_exec_failed', {
                topic: prediction.topic,
                error: String(err),
              })
            } finally {
              this.activePreloads.delete(cacheKey)
            }
          }
        }

        // 推送哑提醒
        const event: PeriodicPredictionEvent = {
          topic: prediction.topic,
          description: prediction.description,
          confidence: prediction.confidence,
          associatedTool: prediction.associatedTool,
          preloaded,
          eventId,
          expiresAt: now + PREDICTION_EXPIRY_MS,
        }

        if (this.notifyRenderer) {
          this.notifyRenderer(event)
        }

        this.sentEvents.set(prediction.topic, now)

        // 清理过期记录
        this.cleanupSentEvents()

        log('INFO', 'periodic_preload_event_sent', {
          topic: event.topic,
          description: event.description,
          confidence: event.confidence,
          preloaded: event.preloaded,
        })
      })

      await Promise.allSettled(promises)
    } catch (err) {
      log('WARN', 'periodic_preload_check_error', { error: String(err) })
    } finally {
      this.running = false
    }
  }

  // ══════════════════════════════════════════
  //  清理
  // ══════════════════════════════════════════

  /** 清理过期的发送记录 */
  private cleanupSentEvents(): void {
    const now = Date.now()
    for (const [topic, timestamp] of this.sentEvents) {
      if (now - timestamp > MIN_REPEAT_INTERVAL_MS * 2) {
        this.sentEvents.delete(topic)
      }
    }
  }

  // ══════════════════════════════════════════
  //  手动控制
  // ══════════════════════════════════════════

  /** 立即执行一次检查 */
  async checkNow(): Promise<void> {
    return this.checkAndPreload()
  }

  /** 重置所有已发送状态（用于测试或会话切换） */
  reset(): void {
    this.sentEvents.clear()
    this.activePreloads.clear()
  }

  /** 获取服务运行状态 */
  getStats(): { running: boolean; timerActive: boolean; sentEvents: number; activePreloads: number } {
    return {
      running: this.running,
      timerActive: this.timer !== null,
      sentEvents: this.sentEvents.size,
      activePreloads: this.activePreloads.size,
    }
  }
}

// ══════════════════════════════════════════
//  全局单例
// ══════════════════════════════════════════

export const behaviorPeriodicPreloadService = new BehaviorPeriodicPreloadService(behaviorPeriodicPredictor)
