/**
 * TaskCompletionTtsHook — 任务完成→欢快语音反馈桥接器
 *
 * 当任务完成时，临时将 TTS 切换为愉悦/欢快风格，提供完成感反馈。
 * 短暂维持后自动恢复为中性，避免持续欢快显得不自然。
 *
 * 设计原则：
 *   - 无侵入：通过 TtsService.setEmotion() 和 BehaviorEmotionDetector 的临时标签工作
 *   - 可恢复：欢快状态有 TTL，到期自动恢复中性
 *   - 防抖：短时间内的连续任务完成不会重复触发
 */

import { log } from '../logger/Logger'
import { eventBus } from '../core/EventBus'
import type { EmotionTtsParams } from './types'
import { BEHAVIOR_EMOTION_TTS_MAP } from './types'

// ══════════════════════════════════════════
//  配置常量
// ══════════════════════════════════════════

/** 欢快 TTS 持续时长（毫秒），之后自动恢复中性 */
const JOYFUL_TTL_MS = 30_000 // 30 秒

/** 防抖间隔（毫秒）：在此间隔内的任务完成不重复触发 */
const DEBOUNCE_MS = 60_000 // 60 秒

/** 监听的任务完成事件列表 */
const TASK_COMPLETION_EVENTS = [
  'scheduler.task.completed',
  'plan_scheduler.task_completed',
  'plan_scheduler.plan_execution_completed',
] as const

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 外部依赖接口（便于解耦和测试） */
export interface TaskCompletionTtsDeps {
  /** 设置情感 TTS 参数 */
  setEmotion: (params: EmotionTtsParams) => void
  /** 获取当前情感 TTS 参数 */
  getEmotionParams: () => EmotionTtsParams
}

// ══════════════════════════════════════════
//  桥接器
// ══════════════════════════════════════════

export class TaskCompletionTtsHook {
  /** 欢快状态 TTL 定时器 */
  private joyfulTimer: ReturnType<typeof setTimeout> | null = null

  /** 上次触发欢快反馈的时间戳 */
  private lastJoyfulTime = 0

  /** 是否已订阅 EventBus */
  private subscribed = false

  /** 订阅清理函数列表 */
  private disposers: Array<() => void> = []

  /** 外部依赖（由 init 注入） */
  private deps: TaskCompletionTtsDeps | null = null

  /** 是否启用 */
  private enabled = true

  // ── 生命周期 ──

  /**
   * 初始化桥接器，注入 TtsService 依赖。
   *
   * @param deps TTS 服务接口
   */
  init(deps: TaskCompletionTtsDeps): void {
    this.deps = deps
    this.subscribeEvents()
    log('INFO', 'task_completion_tts_hook_initialized')
  }

  /** 启用/禁用任务完成 TTS 反馈 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) {
      this.cancelJoyfulTimer()
    }
    log('INFO', 'task_completion_tts_enabled', { enabled })
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /** 清理：取消定时器 + 取消订阅 */
  dispose(): void {
    this.cancelJoyfulTimer()
    for (const disposer of this.disposers) {
      disposer()
    }
    this.disposers = []
    this.subscribed = false
    this.deps = null
    log('INFO', 'task_completion_tts_hook_disposed')
  }

  // ── 事件处理 ──

  /**
   * 监听任务完成事件。
   * 对每个任务完成事件，触发欢快 TTS 反馈（需经过防抖）。
   */
  private subscribeEvents(): void {
    if (this.subscribed) return
    this.subscribed = true

    for (const event of TASK_COMPLETION_EVENTS) {
      const disposer = eventBus.on(event as any, () => {
        this.onTaskCompleted()
      }, `task-completion-tts-hook:${event}`)
      this.disposers.push(disposer)
    }

    log('INFO', 'task_completion_tts_events_subscribed', {
      events: TASK_COMPLETION_EVENTS.map(String),
    })
  }

  /**
   * 任务完成时的处理函数。
   * 经过防抖和启用检查，触发欢快 TTS。
   */
  private onTaskCompleted(): void {
    if (!this.enabled || !this.deps) return

    const now = Date.now()

    // 防抖：距上次欢快反馈不足 DEBOUNCE_MS 则跳过
    if (now - this.lastJoyfulTime < DEBOUNCE_MS) {
      log('DEBUG', 'task_completion_tts_debounced', {
        elapsedMs: now - this.lastJoyfulTime,
        debounceMs: DEBOUNCE_MS,
      })
      return
    }

    this.lastJoyfulTime = now
    this.triggerJoyfulTts()
  }

  /**
   * 触发欢快 TTS 反馈。
   * 从映射表获取 joyful 参数并设置到 TTS 服务，同时启动恢复定时器。
   */
  private triggerJoyfulTts(): void {
    if (!this.deps) return

    // 取消之前的恢复定时器（重新计时）
    this.cancelJoyfulTimer()

    // 获取欢快参数
    const joyfulParams: EmotionTtsParams = { ...BEHAVIOR_EMOTION_TTS_MAP['joyful'] }

    // 混合当前语音角色，保持音色一致
    const currentParams = this.deps.getEmotionParams()
    joyfulParams.voice = currentParams.voice || joyfulParams.voice

    // 设置到 TTS 服务
    this.deps.setEmotion(joyfulParams)

    log('INFO', 'task_completion_tts_joyful_triggered', {
      voice: joyfulParams.voice,
      rate: joyfulParams.rate,
      pitch: joyfulParams.pitch,
      ttlMs: JOYFUL_TTL_MS,
    })

    // 启动恢复定时器：JOYFUL_TTL_MS 后恢复中性
    this.joyfulTimer = setTimeout(() => {
      this.restoreNeutral()
    }, JOYFUL_TTL_MS)
  }

  /**
   * 恢复为中性 TTS 参数。
   */
  private restoreNeutral(): void {
    if (!this.deps) return

    const neutralParams: EmotionTtsParams = { ...BEHAVIOR_EMOTION_TTS_MAP['neutral'] }

    // 保持当前语音角色
    const currentParams = this.deps.getEmotionParams()
    neutralParams.voice = currentParams.voice || neutralParams.voice

    this.deps.setEmotion(neutralParams)

    log('INFO', 'task_completion_tts_restored_neutral', {
      voice: neutralParams.voice,
    })
  }

  /** 取消欢快 TTL 定时器 */
  private cancelJoyfulTimer(): void {
    if (this.joyfulTimer) {
      clearTimeout(this.joyfulTimer)
      this.joyfulTimer = null
    }
  }
}

/** 全局单例 */
export const taskCompletionTtsHook = new TaskCompletionTtsHook()
