/**
 * UserBehaviorTtsContract — UserBehavior 对 TTS 的消费者合同
 *
 * ── 设计哲学 ──
 * 不再问"TTS 如何改进 UserBehavior"，而是问"UserBehavior 需要 TTS 以什么形态存在"。
 *
 * 本模块站在 UserBehavior 各子系统（BehaviorStateMachine、BehaviorEmotionDetector、
 * ContextualTtsAdvisor、UserContextClassifier、UserBehaviorService）的消费者视角，
 * 统一定义它们对 TTS 输出格式、响应速度和容错的要求。
 *
 * ── 架构转换 ──
 * Before: ChatExecutor 手动读取 6+ 行为源 → 逐层混合 rate/pitch → 推给 TtsService
 *         （TTS 不知道"为什么"，只收到混合后的参数）
 *
 * After:  UserBehavior 子系统集体声明 TTS 需求 → 聚合为 UserBehaviorTtsNeed →
 *         TtsService 接收需求并自主决定如何满足
 *         （TTS 知道"为什么"，可以自主优化）
 */

import type { BehaviorMode } from './UserBehaviorService'
import type { BehaviorEmotion, BehaviorMetrics, InteractionCadence, UserContext, InteractionContext, ContextClassificationResult } from '../tts/types'

// ═══════════════════════════════════════════════════
//  1. 消费者需求规格 — UserBehavior 需要 TTS 以什么形态存在
// ═══════════════════════════════════════════════════

/**
 * TTS 输出模式 — 消费者（UserBehavior 状态）需要的 TTS 输出形态。
 *
 * 每个模式对应具体的行为约束：
 * - silent:      行为状态判定不应发声（如用户离开、全屏视频、深夜休息）
 * - minimal:     行为状态需要精简输出（如多任务、专注编码）
 * - normal:      无特殊约束的标准输出
 * - expressive:  行为状态允许完整情感表达（如休闲、放松）
 * - gentle:      行为状态需要柔和输出（如用户焦躁、深夜、休息）
 * - efficient:   行为状态需要高效紧凑输出（如工作模式、急迫节奏）
 */
export type BehaviorTtsOutputMode =
  | 'silent'
  | 'minimal'
  | 'normal'
  | 'expressive'
  | 'gentle'
  | 'efficient'

/**
 * TTS 性能优先级 — 行为状态对延迟 vs 质量的要求。
 */
export type BehaviorTtsPriority =
  | 'latency'    // 低延迟优先（急迫节奏、多任务、工具执行中）
  | 'quality'    // 高质量优先（低频交互、休息时间）
  | 'balanced'   // 默认平衡

/**
 * TTS 容错要求 — 行为状态在 TTS 失败时的期望行为。
 * 消费者视角：不要因为 TTS 失败而影响主要对话流程。
 */
export type BehaviorTtsFaultTolerance =
  | 'silent'       // 静默失败，不阻塞对话（默认，适用于大多数场景）
  | 'retry_once'   // 可等待一次重试（非紧急场景）
  | 'fallback'     // 云失败回退本地（质量要求高的场景）

/**
 * 聚合的 TTS 需求 — UserBehavior 各子系统的集体声明。
 *
 * 重构前后对比：
 * Before: ChatExecutor 手动计算 voice/rate/pitch 的具体数值
 * After:  UserBehavior 声明"需要什么模式"，TtsService 决定"如何实现"
 */
export interface UserBehaviorTtsNeed {
  /** 输出模式 — 最严格的子系统决定最终模式 */
  outputMode: BehaviorTtsOutputMode
  /** 性能优先级 */
  priority: BehaviorTtsPriority
  /** 容错要求 */
  faultTolerance: BehaviorTtsFaultTolerance
  /** 是否需要暂停 TTS（静音整个播放） */
  pauseTts: boolean
  /** 语速微调建议（百分比，-50~+50，0=不指定） */
  rateSuggestion: number
  /** 音调微调建议（Hz，-20~+20，0=不指定） */
  pitchSuggestion: number
  /** 音量建议（0~1，0.85=默认） */
  volumeSuggestion: number
  /** 人类可读的原因描述（调试/日志用） */
  reason: string
  /** 触发此需求的子系统名称列表 */
  sources: string[]
}

/** 默认需求（无特殊行为约束时的标准值） */
export const DEFAULT_TTS_NEED: UserBehaviorTtsNeed = {
  outputMode: 'normal',
  priority: 'balanced',
  faultTolerance: 'silent',
  pauseTts: false,
  rateSuggestion: 0,
  pitchSuggestion: 0,
  volumeSuggestion: 0.85,
  reason: '默认（无行为约束）',
  sources: ['default'],
}

// ═══════════════════════════════════════════════════
//  2. 从行为状态到 TTS 需求的映射
// ═══════════════════════════════════════════════════

// ── 2a. BehaviorMode → TTS output mode ──

/**
 * BehaviorStateMachine 模式 → TTS output mode 映射。
 *
 * 消费者视角（BehaviorStateMachine）：
 * - focus:        编码/深度专注 → 需要 TTS 最小干扰，精简输出
 * - multitasking: 多任务切换 → 需要 TTS 紧凑高效，快速响应
 * - break:        休息/空闲 → 允许 TTS 表现力丰富，完整情感
 */
const MODE_TO_OUTPUT_MODE: Record<BehaviorMode, { mode: BehaviorTtsOutputMode; reason: string }> = {
  focus: { mode: 'minimal', reason: '专注编码，精简输出' },
  multitasking: { mode: 'efficient', reason: '多任务操作，高效紧凑' },
  break: { mode: 'expressive', reason: '休息状态，允许表现力' },
}

// ── 2b. BehaviorEmotion → TTS 微调 ──

/**
 * BehaviorEmotionDetector 检测的用户实时情绪 → TTS 调整。
 *
 * 消费者视角：
 * - anxious: 用户焦躁 → 需要 TTS 轻柔、缓慢、安抚
 * - calm:    用户平静 → TTS 保持匹配，温暖中性
 * - focused: 用户专注 → TTS 高效清晰
 * - neutral: 无特殊 → 不调整
 */
const EMOTION_TO_NEED: Record<BehaviorEmotion, Partial<UserBehaviorTtsNeed> | null> = {
  anxious: {
    outputMode: 'gentle',
    rateSuggestion: -8,
    pitchSuggestion: -4,
    volumeSuggestion: 0.75,
    reason: '用户焦躁，轻柔安抚',
  },
  calm: {
    outputMode: 'normal',
    rateSuggestion: 0,
    pitchSuggestion: 2,
    reason: '用户平静，保持匹配',
  },
  focused: {
    outputMode: 'efficient',
    rateSuggestion: 5,
    pitchSuggestion: 4,
    reason: '用户专注，高效清晰',
  },
  neutral: null, // 不调整
}

// ── 2c. InteractionCadence → TTS priority ──

/**
 * ContextualTtsAdvisor 检测的交互节奏 → TTS 优先级。
 *
 * 消费者视角：
 * - rapid: 用户急迫交流 → TTS 必须低延迟，快速响应
 * - normal: 正常节奏 → 平衡模式
 * - low: 低频交流 → 可接受更高质量但更慢的合成
 */
const CADENCE_TO_PRIORITY: Record<InteractionCadence, { priority: BehaviorTtsPriority; reason: string }> = {
  rapid: { priority: 'latency', reason: '急迫节奏，低延迟优先' },
  normal: { priority: 'balanced', reason: '正常节奏' },
  low: { priority: 'quality', reason: '低频交流，可高质量合成' },
}

// ── 2d. UserContext → TTS output mode + volume ──

/**
 * UserContextClassifier 分类的用户情境 → TTS 需求。
 *
 * 消费者视角：
 * - work:    工作 → 高效专业，音量适中
 * - leisure: 休闲 → 温暖自然，可带表现力
 * - rest:    休息 → 轻柔安静，不打扰
 */
const CONTEXT_TO_NEED: Record<UserContext, Partial<UserBehaviorTtsNeed>> = {
  work: {
    outputMode: 'efficient',
    volumeSuggestion: 0.85,
    reason: '工作情境，高效输出',
  },
  leisure: {
    outputMode: 'expressive',
    volumeSuggestion: 0.9,
    reason: '休闲情境，允许表现力',
  },
  rest: {
    outputMode: 'gentle',
    volumeSuggestion: 0.7,
    reason: '休息情境，轻柔不打扰',
  },
}

// ── 2e. UserBehaviorService 状态 → pause/silent ──

/**
 * UserBehaviorService（窗口焦点/全屏/空闲）→ TTS 暂停需求。
 *
 * 消费者视角：
 * - 全屏播放视频/游戏 → 暂停 TTS（不要干扰用户媒体消费）
 * - 窗口失焦且非活跃 → 降低音量或暂停
 * - 长时间离开（away）→ 暂停 TTS（不要对空房间说话）
 */
function buildServiceStateNeed(state: BehaviorStateInput): Partial<UserBehaviorTtsNeed> | null {
  // 全屏 → 暂停 TTS（用户可能在观看视频/玩游戏）
  if (state.fullscreen) {
    return {
      outputMode: 'silent',
      pauseTts: true,
      reason: '全屏状态，暂停 TTS',
    }
  }

  // away → 暂停 TTS（用户已离开）
  if (state.activityState === 'away') {
    return {
      outputMode: 'silent',
      pauseTts: true,
      reason: '用户已离开，暂停 TTS',
    }
  }

  // 空闲 + break → 静音不打扰
  if (state.activityState === 'idle' && state.mode === 'break') {
    return {
      outputMode: 'silent',
      pauseTts: true,
      reason: '用户空闲休息，暂停 TTS',
    }
  }

  // idle 但未 break → 轻柔
  if (state.activityState === 'idle') {
    return {
      outputMode: 'gentle',
      volumeSuggestion: 0.6,
      reason: '用户短暂空闲，轻柔输出',
    }
  }

  return null
}

// ═══════════════════════════════════════════════════
//  3. 需求聚合器 — 合并各子系统的需求
// ═══════════════════════════════════════════════════

// ── 模式严格度排序（用于合并：严格度高的覆盖低的）──
const OUTPUT_MODE_STRICTNESS: Record<BehaviorTtsOutputMode, number> = {
  silent: 100,
  gentle: 80,
  minimal: 60,
  efficient: 40,
  normal: 20,
  expressive: 10,
}

/**
 * 合并多个 Partial<UserBehaviorTtsNeed> 为一个完整的 need。
 * 规则：pauseTts 任一为 true → true；outputMode 取严格度最高；
 * rate/pitch/volume 取平均值；sources 合并。
 */
function mergeNeeds(needs: Partial<UserBehaviorTtsNeed>[]): UserBehaviorTtsNeed {
  let current = { ...DEFAULT_TTS_NEED }
  const reasonParts: string[] = []
  const allSources: string[] = []

  for (const need of needs) {
    if (!need || Object.keys(need).length === 0) continue

    // pauseTts: 任一 true → 整体 true
    if (need.pauseTts) {
      current.pauseTts = true
    }

    // outputMode: 取严格度最高
    if (need.outputMode && OUTPUT_MODE_STRICTNESS[need.outputMode] > OUTPUT_MODE_STRICTNESS[current.outputMode]) {
      current.outputMode = need.outputMode
    }

    // priority: 最后设置的优先级（最严格的子系统通常是最后的）
    if (need.priority) {
      current.priority = need.priority
    }

    // faultTolerance: 同理
    if (need.faultTolerance) {
      current.faultTolerance = need.faultTolerance
    }

    // rateSuggestion/pitchSuggestion/volumeSuggestion: 取非零值（零 = 不指定）
    if (need.rateSuggestion && need.rateSuggestion !== 0) {
      current.rateSuggestion = need.rateSuggestion
    }
    if (need.pitchSuggestion && need.pitchSuggestion !== 0) {
      current.pitchSuggestion = need.pitchSuggestion
    }
    if (need.volumeSuggestion && need.volumeSuggestion > 0) {
      current.volumeSuggestion = need.volumeSuggestion
    }

    if (need.reason) reasonParts.push(need.reason)
    if (need.sources) allSources.push(...need.sources)
  }

  current.reason = reasonParts.length > 0 ? reasonParts.join('；') : DEFAULT_TTS_NEED.reason
  current.sources = allSources.length > 0 ? [...new Set(allSources)] : DEFAULT_TTS_NEED.sources

  return current
}

// ═══════════════════════════════════════════════════
//  4. 核心函数：从行为状态构建 TTS 需求
// ═══════════════════════════════════════════════════

/**
 * buildTtsNeed 接受的行为状态输入。
 *
 * 可以是完整的 EnrichedBehaviorState（来自 UserBehaviorService.getEnrichedState()），
 * 也可以是 ChatExecutor 从 EventBus + BehaviorStateMachine 构建的最小版本。
 * 仅使用 mode、activityState、fullscreen、focused 和 idleTimeMs 字段。
 */
export interface BehaviorStateInput {
  mode: BehaviorMode
  activityState: string
  fullscreen: boolean
  focused: boolean
  idleTimeMs: number
}

/**
 * 从完整的增强行为状态构建 UserBehaviorTtsNeed。
 *
 * 这是本合同的核心转换函数：汇总 UserBehavior 所有子系统的状态，
 * 输出一个聚合的 TTS 需求规格。TtsService 仅需消费此规格，
 * 不再需要逐层手动调用各分析器。
 *
 * @param enrichedState 从 UserBehaviorService.getEnrichedState() 获取（可选，无则跳过窗口/空闲检查）
 * @param emotion 从 BehaviorEmotionDetector.getEmotion() 获取（可选）
 * @param metrics 从 BehaviorEmotionDetector.getMetrics() 获取（可选）
 * @param cadence 从 ContextualTtsAdvisor.getRecommendation() 获取（可选）
 * @param context 从 UserContextClassifier.getClassification() 获取（可选）
 *
 * @returns 聚合的 UserBehaviorTtsNeed
 */
export function buildTtsNeed(
  enrichedState?: BehaviorStateInput | null,
  emotion?: { emotion: BehaviorEmotion; confidence: number } | null,
  metrics?: BehaviorMetrics | null,
  cadence?: { cadence: InteractionCadence; confidence: number } | null,
  context?: { context: UserContext; confidence: number } | null,
): UserBehaviorTtsNeed {
  const partials: Partial<UserBehaviorTtsNeed>[] = []

  // ── 源 1: BehaviorStateMachine 模式（权重最高） ──
  if (enrichedState) {
    const modeNeed = MODE_TO_OUTPUT_MODE[enrichedState.mode]
    if (modeNeed) {
      partials.push({
        outputMode: modeNeed.mode,
        priority: enrichedState.mode === 'multitasking' ? 'latency' : 'balanced',
        reason: modeNeed.reason,
        sources: ['BehaviorStateMachine'],
      })
    }
  }

  // ── 源 2: BehaviorEmotionDetector（情绪微调） ──
  if (emotion && emotion.confidence > 0.3) {
    const emotionNeed = EMOTION_TO_NEED[emotion.emotion]
    if (emotionNeed) {
      partials.push({
        ...emotionNeed,
        sources: ['BehaviorEmotionDetector'],
      })
    }
  }

  // ── 源 3: ContextualTtsAdvisor（节奏决定优先级） ──
  if (cadence && cadence.confidence > 0.2) {
    const cadenceSpec = CADENCE_TO_PRIORITY[cadence.cadence]
    if (cadenceSpec) {
      partials.push({
        priority: cadenceSpec.priority,
        reason: cadenceSpec.reason,
        sources: ['ContextualTtsAdvisor'],
      })
    }
  }

  // ── 源 4: UserContextClassifier（情境决定风格） ──
  if (context && context.confidence > 0.2) {
    const contextNeed = CONTEXT_TO_NEED[context.context]
    if (contextNeed) {
      partials.push({
        ...contextNeed,
        sources: ['UserContextClassifier'],
      })
    }
  }

  // ── 源 5: UserBehaviorService（窗口/全屏/离开状态，可选） ──
  if (enrichedState) {
    const serviceNeed = buildServiceStateNeed(enrichedState)
    if (serviceNeed) {
      partials.push({
        ...serviceNeed,
        sources: ['UserBehaviorService'],
      })
    }
  }

  // ── BehaviorMetrics 触发的额外调整（只在有 enrichedState 时启用） ──
  if (metrics && enrichedState) {
    // APM 极高 → 暗示用户很忙，倾向 minimal
    if (metrics.apm > 60 && enrichedState.mode === 'focus') {
      partials.push({
        outputMode: 'minimal',
        reason: '高 APM 专注模式，最小化输出',
        sources: ['BehaviorMetrics'],
      })
    }
    // 鼠标抖动高 + anxious → 增强 gentle 权重
    if (metrics.mouseJitter > 0.6 && emotion?.emotion === 'anxious') {
      partials.push({
        outputMode: 'gentle',
        rateSuggestion: -10,
        pitchSuggestion: -5,
        volumeSuggestion: 0.7,
        reason: '鼠标抖动高+焦躁，加强轻柔',
        sources: ['BehaviorMetrics'],
      })
    }
  }

  return mergeNeeds(partials)
}

/**
 * 快速判断给定的 TTS need 是否与默认值有实质性差异（用于防抖）。
 */
export function isNeedDifferent(a: UserBehaviorTtsNeed, b: UserBehaviorTtsNeed): boolean {
  return (
    a.outputMode !== b.outputMode ||
    a.priority !== b.priority ||
    a.pauseTts !== b.pauseTts ||
    a.faultTolerance !== b.faultTolerance ||
    a.rateSuggestion !== b.rateSuggestion ||
    a.pitchSuggestion !== b.pitchSuggestion ||
    Math.abs(a.volumeSuggestion - b.volumeSuggestion) > 0.05
  )
}
