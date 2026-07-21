/**
 * SleepOrchestrator — 智能休眠期任务编排
 *
 * ── 职责 ──
 * 1. 检测用户连续 1 小时无交互 → 自动进入休眠编排模式
 * 2. 在休眠期内分析用户近期交互模式（工具调用频率和对话主题）
 * 3. 预测下次可能请求，预加载常用工具链
 * 4. 用户唤醒时生成个性化主动问候（PiperTTS 语音）
 *
 * ── 架构 ──
 *   SleepOrchestrator 是一个独立的后台服务，通过 EventBus 监听用户交互事件，
 *   并通过 TaskRunner 注册每 10 分钟的定期 tick。
 *
 * 数据流：
 *   EventBus 'agent.input.received' ──→ recordUserInteraction()
 *   EventBus 'agent.tool.invoked'   ──→ recordToolCall()
 *   TaskRunner 每 10 分钟 tick     ──→ tick() → 检查是否 60 分钟无交互
 *     ├─ 超过 60 分钟 → analyzeAndPlan() → 同时间段模式分析 → 预加载建议
 *     └─ 用户回归     → onWakeUp()      → PiperTTS 语音问候
 *
 * ── 集成点 ──
 * - 在 AppRuntime 中创建实例，注入 TtsService
 * - 注册到 TaskRunner（每 10 分钟）
 * - 自动订阅 EventBus 事件
 *
 * ── 风险控制 ──
 * - 分析冷却期：至少 10 分钟间隔，避免频繁分析
 * - 预加载列表上限：最多 3 条建议，避免资源浪费
 * - 语音问候仅在用户唤醒时播放一次（防止重复打扰）
 * - 空的 greeting 不播放
 */

import { log } from '../logger/Logger'
import { eventBus } from '../core/EventBus'
import { toolCallLogStore, type ToolCallRecord } from '../tool/ToolCallLogStore'
import type { TtsService } from '../tts/TtsService'
import type { TaskExecutionResult } from '../core/tasks/unified/TaskTypes'

// ════════════════════════════════════════════
// 类型定义
// ════════════════════════════════════════════

/** 轻量工具调用记录（用于内存中的行为跟踪） */
export interface SleekToolCallRecord {
  name: string
  timestamp: number
  success?: boolean
  args?: Record<string, any>
}

/** 时间槽模式分析结果 */
export interface TimeSlotPattern {
  /** 分析的时间段（小时 0-23） */
  hour: number
  /** 该时间段的工具调用总数 */
  totalCalls: number
  /** 高频工具序列（2-3 阶 n-gram） */
  topSequences: Array<{
    tools: string[]
    frequency: number
  }>
  /** 高频单个工具 */
  topTools: Array<{
    name: string
    frequency: number
  }>
  /** 数据是否足够 */
  hasSufficientData: boolean
}

/** 休眠编排分析快照 */
export interface SleepAnalysis {
  /** 是否处于不活跃状态 */
  isInactive: boolean
  /** 不活跃持续时间（毫秒） */
  inactiveDurationMs: number
  /** 最后交互时间戳 */
  lastInteractionAt: number
  /** 当前时间槽模式分析 */
  timeSlotPattern: TimeSlotPattern | null
  /** 预加载建议的工具列表（最多 3 条） */
  preloadSuggestions: string[]
  /** 数据是否足够 */
  hasSufficientData: boolean
  /** 分析时间戳 */
  analyzedAt: number
}

// ════════════════════════════════════════════
// 配置常量
// ════════════════════════════════════════════

/** 不活跃阈值：60 分钟 */
const INACTIVITY_THRESHOLD_MS = 60 * 60 * 1000

/** 分析冷却期：10 分钟 */
const ANALYSIS_COOLDOWN_MS = 10 * 60 * 1000

/** 内存工具调用记录上限 */
const MAX_TOOL_RECORDS = 500

/** 同时间段分析窗口：7 天 */
const TIME_SLOT_WINDOW_DAYS = 7

/** 最高预加载建议数 */
const MAX_PRELOAD_SUGGESTIONS = 3

/** n-gram 最小/最大长度 */
const MIN_NGRAM = 2
const MAX_NGRAM = 3

/** 序列高频判定阈值 */
const MIN_SEQUENCE_FREQ = 2

/** 序列间最大间隔（毫秒）——超过此值不算连续 */
const SEQUENCE_GAP_MS = 30_000

/** 最小工具调用数据量 */
const MIN_TOOL_CALLS_FOR_ANALYSIS = 10

/** 问候语最短字符（TtsService.speakInternal 要求 >= 15） */
const GREETING_MIN_LENGTH = 15

// ════════════════════════════════════════════
// SleepOrchestrator
// ════════════════════════════════════════════

export class SleepOrchestrator {
  // ── 状态 ──

  /** 最后交互时间戳 */
  private lastInteractionAt: number = Date.now()

  /** 是否处于休眠模式 */
  private asleep = false

  /** 是否已在当前唤醒周期播报过问候 */
  private greetedOnWake = false

  /** 缓存的预加载建议（休眠期分析生成） */
  private pendingPreloadSuggestions: string[] = []

  /** 最近一次分析快照 */
  private lastAnalysis: SleepAnalysis | null = null

  /** 上次分析完成的时间戳 */
  private lastAnalysisTime = 0

  /** 内存工具调用记录（补充 ToolCallLogStore 的近实时数据） */
  private recentToolCalls: SleekToolCallRecord[] = []

  /** EventBus 订阅回收句柄 */
  private subscriptions: Array<() => void> = []

  // ── 依赖（延时注入） ──

  /** TTS 服务（可选，无 TTS 时跳过语音问候） */
  private ttsService: TtsService | null = null

  // ── 生命周期 ──

  constructor() {
    this.subscribeToEvents()
    log('INFO', 'sleep_orchestrator_created')
  }

  /** 订阅 EventBus 事件 */
  private subscribeToEvents(): void {
    // 用户输入事件
    const unsubInput = eventBus.on('agent.input.received', () => {
      this.recordUserInteraction()
    })

    // 工具调用事件
    const unsubTool = eventBus.on('agent.tool.invoked', (payload) => {
      const toolName = payload?.tool
      if (toolName) {
        this.recordToolCall(toolName, payload.args)
      }
    })

    this.subscriptions = [unsubInput, unsubTool]
  }

  /** 销毁所有订阅 */
  destroy(): void {
    for (const unsub of this.subscriptions) {
      unsub()
    }
    this.subscriptions = []
    log('INFO', 'sleep_orchestrator_destroyed')
  }

  // ── 依赖注入 ──

  /** 注入 TTS 服务引用（可选） */
  setTtsService(tts: TtsService | null): void {
    this.ttsService = tts
  }

  // ── 公共记录方法 ──

  /**
   * 记录用户交互（EventBus 事件触发时自动调用，
   * 也可由 ChatExecutor/AgentService 手动调用）。
   */
  recordUserInteraction(): void {
    const wasAsleep = this.asleep
    this.lastInteractionAt = Date.now()

    if (wasAsleep) {
      // 用户回归 → 触发唤醒序列
      this.onWakeUp().catch((err) => {
        log('WARN', 'sleep_orchestrator_wake_error', { error: String(err) })
      })
    }
  }

  /**
   * 记录工具调用（EventBus 事件触发时自动调用，
   * 也可由 ToolScheduler/ChatExecutor 手动调用）。
   */
  recordToolCall(toolName: string, args?: Record<string, any>): void {
    const wasAsleep = this.asleep
    this.lastInteractionAt = Date.now()

    this.recentToolCalls.push({
      name: toolName,
      timestamp: Date.now(),
      args: args ? { ...args } : undefined,
    })

    if (this.recentToolCalls.length > MAX_TOOL_RECORDS) {
      this.recentToolCalls = this.recentToolCalls.slice(-Math.floor(MAX_TOOL_RECORDS / 2))
    }

    if (wasAsleep) {
      this.onWakeUp().catch((err) => {
        log('WARN', 'sleep_orchestrator_wake_error', { error: String(err) })
      })
    }
  }

  // ── 定期 Tick（由 TaskRunner 每 10 分钟调用） ──

  /**
   * 定期检查任务：检查用户是否 60 分钟无交互。
   * 若超过阈值则触发分析；若用户已回归则取消休眠状态。
   */
  async tick(): Promise<TaskExecutionResult> {
    const now = Date.now()
    const inactiveDuration = now - this.lastInteractionAt

    try {
      // ── 场景 1：不活跃超过 60 分钟，且尚未进入休眠 ──
      if (inactiveDuration >= INACTIVITY_THRESHOLD_MS && !this.asleep) {
        this.asleep = true
        this.greetedOnWake = false
        log('INFO', 'sleep_orchestrator_enter_sleep', {
          inactiveMinutes: Math.round(inactiveDuration / 60_000),
        })
        await this.analyzeAndPlan()
      }

      // ── 场景 2：用户已回归，但状态未更新（兜底） ──
      if (inactiveDuration < INACTIVITY_THRESHOLD_MS && this.asleep) {
        this.asleep = false
        log('INFO', 'sleep_orchestrator_exit_sleep', {
          inactiveMinutes: Math.round(inactiveDuration / 60_000),
        })
      }

      return { success: true, summary: `sleep_tick: inactive=${Math.round(inactiveDuration / 60_000)}min, asleep=${this.asleep}` }
    } catch (err: any) {
      log('ERROR', 'sleep_orchestrator_tick_error', { error: err.message })
      return { success: false, summary: `sleep_tick_error: ${err.message}` }
    }
  }

  // ── 分析引擎 ──

  /**
   * 进入休眠后触发分析：
   * 1. 从 ToolCallLogStore 查询最近 7 天同一小时段的工具调用
   * 2. 分析高频工具组合（2-3 阶 n-gram）
   * 3. 选出前 3 个预加载建议
   */
  private async analyzeAndPlan(): Promise<void> {
    const now = Date.now()

    // 冷却检查
    if (now - this.lastAnalysisTime < ANALYSIS_COOLDOWN_MS) {
      log('DEBUG', 'sleep_orchestrator_analysis_skipped_cooldown', {
        lastAnalysis: Math.round((now - this.lastAnalysisTime) / 1000) + 's ago',
      })
      return
    }

    this.lastAnalysisTime = now

    // 获取当前时间槽（小时）
    const currentHour = new Date().getHours()

    // 查询 ToolCallLogStore 中最近 7 天的记录
    const sevenDaysAgo = now - TIME_SLOT_WINDOW_DAYS * 24 * 60 * 60 * 1000
    const historicalCalls = toolCallLogStore.query({
      since: sevenDaysAgo,
      limit: 2000,
    })

    // 合并历史记录 + 内存近实时记录
    const allCalls = this.mergeToolCallRecords(historicalCalls)

    if (allCalls.length < MIN_TOOL_CALLS_FOR_ANALYSIS) {
      log('INFO', 'sleep_orchestrator_insufficient_data', {
        totalCalls: allCalls.length,
        minRequired: MIN_TOOL_CALLS_FOR_ANALYSIS,
      })
      this.lastAnalysis = {
        isInactive: true,
        inactiveDurationMs: now - this.lastInteractionAt,
        lastInteractionAt: this.lastInteractionAt,
        timeSlotPattern: null,
        preloadSuggestions: [],
        hasSufficientData: false,
        analyzedAt: now,
      }
      this.pendingPreloadSuggestions = []
      return
    }

    // 1. 分析当前时间槽模式
    const pattern = this.analyzeTimeSlot(allCalls, currentHour)

    // 2. 生成预加载建议
    const suggestions = this.selectPreloadCandidates(pattern)

    log('INFO', 'sleep_orchestrator_analysis_complete', {
      totalCalls: allCalls.length,
      sameHourCalls: pattern.totalCalls,
      topSequences: pattern.topSequences.length,
      suggestions,
    })

    // 3. 缓存分析结果
    this.lastAnalysis = {
      isInactive: true,
      inactiveDurationMs: now - this.lastInteractionAt,
      lastInteractionAt: this.lastInteractionAt,
      timeSlotPattern: pattern,
      preloadSuggestions: suggestions,
      hasSufficientData: true,
      analyzedAt: now,
    }
    this.pendingPreloadSuggestions = suggestions
  }

  /**
   * 合并 ToolCallLogStore 历史记录和内存近实时记录。
   * 去重（按时间戳相近的同名调用去重）。
   */
  private mergeToolCallRecords(historical: ToolCallRecord[]): SleekToolCallRecord[] {
    const merged: SleekToolCallRecord[] = []

    // 历史记录的键集合（用于去重）
    const seenKeys = new Set<string>()

    for (const rec of historical) {
      const key = `${rec.toolName}|${rec.timestamp}`
      if (seenKeys.has(key)) continue
      seenKeys.add(key)
      merged.push({
        name: rec.toolName,
        timestamp: rec.timestamp,
        success: rec.success,
        args: rec.args,
      })
    }

    // 追加内存记录（补充最近但尚未持久化的调用）
    for (const rec of this.recentToolCalls) {
      const key = `${rec.name}|${rec.timestamp}`
      if (seenKeys.has(key)) continue
      seenKeys.add(key)
      merged.push(rec)
    }

    // 按时间戳升序排列
    merged.sort((a, b) => a.timestamp - b.timestamp)

    return merged
  }

  /**
   * 分析指定小时段的高频工具调用模式。
   * 使用滑动窗口 n-gram 统计工具序列。
   */
  private analyzeTimeSlot(calls: SleekToolCallRecord[], targetHour: number): TimeSlotPattern {
    // 筛选同时间段的调用
    const slotCalls = calls.filter((c) => {
      const h = new Date(c.timestamp).getHours()
      return h === targetHour
    })

    if (slotCalls.length < 3) {
      return {
        hour: targetHour,
        totalCalls: slotCalls.length,
        topSequences: [],
        topTools: [],
        hasSufficientData: false,
      }
    }

    // ── 统计高频单个工具 ──
    const toolCounts = new Map<string, number>()
    for (const c of slotCalls) {
      toolCounts.set(c.name, (toolCounts.get(c.name) || 0) + 1)
    }

    const topTools = Array.from(toolCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, frequency]) => ({ name, frequency }))

    // ── 提取 2-3 阶高频序列 ──
    const seqCounts = new Map<string, { count: number; gapTotal: number }>()

    for (let n = MIN_NGRAM; n <= MAX_NGRAM; n++) {
      for (let i = 0; i <= slotCalls.length - n; i++) {
        const seq = slotCalls.slice(i, i + n)
        const gapMs = seq[seq.length - 1].timestamp - seq[0].timestamp
        if (gapMs > SEQUENCE_GAP_MS) continue

        const key = seq.map((c) => c.name).join('→')
        const existing = seqCounts.get(key)
        if (existing) {
          existing.count++
          existing.gapTotal += gapMs
        } else {
          seqCounts.set(key, { count: 1, gapTotal: gapMs })
        }
      }
    }

    const topSequences = Array.from(seqCounts.entries())
      .filter(([, data]) => data.count >= MIN_SEQUENCE_FREQ)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, MAX_PRELOAD_SUGGESTIONS)
      .map(([key, data]) => ({
        tools: key.split('→'),
        frequency: data.count,
      }))

    return {
      hour: targetHour,
      totalCalls: slotCalls.length,
      topSequences,
      topTools,
      hasSufficientData: true,
    }
  }

  /**
   * 从时间槽模式中选出预加载候选工具。
   * 策略：
   * 1. 优先使用高频序列中的第一个工具
   * 2. 若序列不足，使用高频工具
   * 3. 最多 3 条建议
   */
  private selectPreloadCandidates(pattern: TimeSlotPattern): string[] {
    const candidates: string[] = []

    // 从序列中提取首工具（最常出现的序列）
    for (const seq of pattern.topSequences) {
      if (candidates.length >= MAX_PRELOAD_SUGGESTIONS) break
      // 使用序列描述作为建议（如 "read_file → edit_file"）
      const desc = seq.tools.join(' → ')
      if (!candidates.includes(desc)) {
        candidates.push(desc)
      }
    }

    // 补充高频工具（如果序列不够）
    for (const t of pattern.topTools) {
      if (candidates.length >= MAX_PRELOAD_SUGGESTIONS) break
      if (!candidates.includes(t.name)) {
        candidates.push(t.name)
      }
    }

    return candidates
  }

  // ── 唤醒序列 ──

  /**
   * 用户回归后的唤醒序列：
   * 1. 退出休眠模式
   * 2. 若有缓存的预加载建议，播放个性化语音问候
   */
  private async onWakeUp(): Promise<void> {
    this.asleep = false

    if (this.greetedOnWake) return
    this.greetedOnWake = true

    if (this.pendingPreloadSuggestions.length > 0) {
      await this.playWakeUpGreeting()
    }
  }

  /**
   * 播放唤醒语音问候。
   * 使用预加载建议构建个性化问候语，通过 PiperTTS 播放。
   */
  private async playWakeUpGreeting(): Promise<void> {
    if (!this.ttsService) {
      log('DEBUG', 'sleep_orchestrator_no_tts_skip_greeting')
      return
    }

    const greeting = this.buildGreeting()
    if (!greeting || greeting.length < GREETING_MIN_LENGTH) {
      log('DEBUG', 'sleep_orchestrator_greeting_too_short', { length: greeting?.length })
      return
    }

    log('INFO', 'sleep_orchestrator_play_greeting', {
      greeting: greeting.slice(0, 60),
      suggestions: this.pendingPreloadSuggestions,
    })

    try {
      await this.ttsService.speak(greeting)
      // 播报后清除预加载建议（已使用）
      this.pendingPreloadSuggestions = []
    } catch (err: any) {
      log('WARN', 'sleep_orchestrator_greeting_failed', { error: err.message })
    }
  }

  /**
   * 根据预加载建议构建个性化问候语。
   */
  private buildGreeting(): string {
    const suggestions = this.pendingPreloadSuggestions

    if (suggestions.length === 0) {
      return '欢迎回来，有什么需要帮忙的吗？'
    }

    // 如果有具体的工具序列建议，以此构建个性化问候
    const topSuggestion = suggestions[0]

    // 判断是否包含工具序列（含 →）
    if (topSuggestion.includes('→')) {
      const tools = topSuggestion.split('→').map((t) => t.trim())
      const firstTool = tools[0]
      return `欢迎回来。根据你的使用习惯，我注意到你之前经常使用「${firstTool}」等工具。需要我提前准备好相关环境吗？`
    }

    // 单个工具建议
    return `欢迎回来。根据分析，你可能需要使用「${topSuggestion}」工具。需要我帮忙调用吗？`
  }

  // ── 查询接口 ──

  /** 获取最近一次分析快照 */
  getAnalysis(): SleepAnalysis | null {
    return this.lastAnalysis
  }

  /** 获取当前预加载建议列表 */
  getPreloadSuggestions(): string[] {
    return [...this.pendingPreloadSuggestions]
  }

  /** 是否处于休眠模式 */
  isAsleep(): boolean {
    return this.asleep
  }

  /** 获取最后交互时间 */
  getLastInteractionAt(): number {
    return this.lastInteractionAt
  }

  /** 获取不活跃时长（毫秒） */
  getInactiveDurationMs(): number {
    return Date.now() - this.lastInteractionAt
  }

  /** 手动强制触发分析（用于测试或调试） */
  async triggerAnalysisNow(): Promise<SleepAnalysis | null> {
    this.lastAnalysisTime = 0 // 清除冷却
    await this.analyzeAndPlan()
    return this.lastAnalysis
  }
}

// ════════════════════════════════════════════
// 单例
// ════════════════════════════════════════════

/** 全局单例 */
export const sleepOrchestrator = new SleepOrchestrator()
