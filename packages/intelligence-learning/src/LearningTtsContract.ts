/**
 * LearningTtsContract — Plan:TypeScript 对 TTS 的消费者合同
 *
 * ── 设计哲学 ──
 * 不再问「TTS 如何改进 Plan:TypeScript 高级类型学习计划」，
 * 而是问「Plan:TypeScript 高级类型学习计划 需要 TTS 以什么形态存在」。
 *
 * 本模块站在 Plan:TypeScript 学习计划执行器的消费者视角，
 * 定义它对 TTS 输出格式、响应速度和容错的要求。
 *
 * ── 架构转换 ──
 * Before: 各子系统手动混合文本→推给 TtsService（TTS 不知道"为什么"）
 *         ChatExecutor 收到学习事件→人工判断是否需要 TTS
 *         （学习计划不知道"TTS 如何满足我"，只产生事件）
 *
 * After:  Plan:TypeScript 声明对 TTS 的需求 → 聚合为 LearningTtsNeed →
 *         适配器将事件转换为结构化 TTS 内容
 *         （学习计划知道"我需要 TTS 以这种形态存在"）
 *
 * ── 对照 UserBehaviorTtsContract ──
 * UserBehaviorTtsContract 定义了 UserBehavior 子系统对 TTS 的行为需求
 *（输出音量、语速、是否静音），本合约定义的是学习内容对 TTS 的内容需求
 *（格式结构、延迟要求、容错策略）。两者互补而非重叠：
 *   - UserBehaviorTtsContract：「什么时候说、说多大声」
 *   - LearningTtsContract：「说什么格式、说多快、失败了怎么办」
 */

// ══════════════════════════════════════════
//  1. 学习内容 TTS 输出模式
// ══════════════════════════════════════════

/**
 * 学习内容类型 — Plan:TypeScript 产生的需要 TTS 播报的内容分类。
 *
 * 每个类型对应不同的 TTS 输出需求：
 * - teaching:      教学讲解 — 完整概念讲解、代码范例朗读
 * - progress:      进度报告 — 日/周学习进度汇总、掌握率播报
 * - feedback:      即时反馈 — 步骤完成、练习正确/错误的简短反馈
 * - explanation:   知识点解释 — ASR 查询匹配后返回的知识点说明
 * - code_reading:  代码朗读 — oral code 生成的代码，需要逐行朗读
 * - encouragement: 鼓励 — 里程碑达成、连续学习天数等积极反馈
 * - reminder:      提醒 — 学习计划提醒、复习提醒
 */
export type LearningContentType = 'teaching' | 'progress' | 'feedback' | 'explanation' | 'code_reading' | 'encouragement' | 'reminder'

/**
 * TTS 输出模式 — 学习内容需要的 TTS 输出形态。
 *
 * 每个模式定义语速、节奏和表现力的期望：
 * - full:    完整讲解 — 语速适中、抑扬顿挫、适合教学
 * - concise: 简明摘要 — 语速略快、紧凑高效
 * - quick:   快速反馈 — 短促直接、低延迟
 * - gradual: 渐进阅读 — 按行/分段停顿、便于跟随
 * - gentle:  柔和鼓励 — 语速放缓、语调温暖
 */
export type LearningTtsOutputMode = 'full' | 'concise' | 'quick' | 'gradual' | 'gentle'

/**
 * TTS 性能优先级 — 学习内容对延迟 vs 质量的要求。
 */
export type LearningTtsPriority =
  | 'latency' // 低延迟优先（反馈、提醒）
  | 'quality' // 高质量优先（教学讲解）
  | 'balanced' // 默认平衡（摘要、解释）

/**
 * TTS 容错要求 — 学习内容在 TTS 失败时的期望行为。
 */
export type LearningTtsFaultTolerance =
  | 'silent' // 静默失败，不阻塞（反馈、鼓励）
  | 'retry_once' // 可等待一次重试（知识点解释）
  | 'retry_always' // 必须成功（教学讲解，可降级为文本显示）

// ══════════════════════════════════════════
//  2. 学习 TTS 需求规格
// ══════════════════════════════════════════

/**
 * 结构化 TTS 内容 — 学习计划需要的 TTS 输出格式。
 *
 * 与普通文本播报不同，学习 TTS 内容带有丰富的元数据：
 * - primaryText:   主要播报文本（正文，需要 TTS 朗读的核心内容）
 * - secondaryText: 次要文本（可选，用于分段或附注）
 * - pausePositions: 建议停顿位置（字符索引数组，用于代码朗读分段）
 * - emphasis:      需要强调的词汇或短语列表
 * - codeSnippet:   可选的代码片段（用于代码朗读模式）
 * - conceptName:   关联知识点名称（让 TTS 发音更准确）
 * - category:      关联知识点分类
 * - masteryInfo:   掌握度信息（用于上下文感知播报）
 */
export interface LearningTtsContent {
  /** 主要播报文本 */
  primaryText: string
  /** 次要文本（可选，用于分段或附注，会跟在 primaryText 之后播报） */
  secondaryText?: string
  /** 建议停顿位置（字符索引数组，用于代码朗读时在关键位置停顿） */
  pausePositions?: number[]
  /** 需要强调的词汇/短语列表 */
  emphasis?: string[]
  /** 可选的代码片段（代码朗读模式使用） */
  codeSnippet?: string
  /** 关联知识点名称 */
  conceptName?: string
  /** 关联知识点分类 */
  category?: string
  /** 掌握度信息（用于上下文感知播报） */
  masteryInfo?: {
    /** 当前掌握度 0-100 */
    current: number
    /** 之前的掌握度（可选，用于展示变化） */
    previous?: number
    /** 目标掌握度 */
    target: number
  }
}

/**
 * LearningTtsNeed — Plan:TypeScript 对 TTS 的聚合需求声明。
 *
 * 站在消费者视角，一次 TTS 播报包含：
 * - contentType:   这是什么类型的学习内容
 * - outputMode:    需要什么形态的 TTS 输出
 * - priority:      延迟还是质量更重要
 * - faultTolerance: TTS 失败时如何处理
 * - content:       需要播报的具体内容（结构化的）
 * - reason:        为什么需要这次 TTS 播报
 */
export interface LearningTtsNeed {
  /** 学习内容类型 */
  contentType: LearningContentType
  /** TTS 输出模式 */
  outputMode: LearningTtsOutputMode
  /** 性能优先级 */
  priority: LearningTtsPriority
  /** 容错要求 */
  faultTolerance: LearningTtsFaultTolerance
  /** 结构化 TTS 内容 */
  content: LearningTtsContent
  /** 人类可读的原因描述 */
  reason: string
}

// ══════════════════════════════════════════
//  3. 内容类型 → TTS 需求映射表
// ══════════════════════════════════════════

/**
 * 内容类型 → 默认 TTS 需求映射。
 *
 * 定义了每种学习内容类型对 TTS 的期望输出模式、优先级和容错策略。
 * 可作为 TtsService 调整参数的参考基线。
 */
export const CONTENT_TYPE_TTS_NEED_MAP: Record<
  LearningContentType,
  { outputMode: LearningTtsOutputMode; priority: LearningTtsPriority; faultTolerance: LearningTtsFaultTolerance }
> = {
  /** 教学讲解 — 关注质量，必须成功 */
  teaching: {
    outputMode: 'full',
    priority: 'quality',
    faultTolerance: 'retry_always',
  },
  /** 进度报告 — 简要即可，可容忍失败 */
  progress: {
    outputMode: 'concise',
    priority: 'balanced',
    faultTolerance: 'silent',
  },
  /** 即时反馈 — 快速响应优先 */
  feedback: {
    outputMode: 'quick',
    priority: 'latency',
    faultTolerance: 'silent',
  },
  /** 知识点解释 — 完整清晰，容忍一次重试 */
  explanation: {
    outputMode: 'full',
    priority: 'balanced',
    faultTolerance: 'retry_once',
  },
  /** 代码朗读 — 渐进式，关注质量 */
  code_reading: {
    outputMode: 'gradual',
    priority: 'quality',
    faultTolerance: 'retry_once',
  },
  /** 鼓励 — 柔和温暖，可容忍失败 */
  encouragement: {
    outputMode: 'gentle',
    priority: 'balanced',
    faultTolerance: 'silent',
  },
  /** 提醒 — 快速直接 */
  reminder: {
    outputMode: 'quick',
    priority: 'latency',
    faultTolerance: 'silent',
  },
}

// ══════════════════════════════════════════
//  4. 输出模式 → TTS 参数映射
// ══════════════════════════════════════════

/**
 * TTS 输出模式 → 基本参数映射。
 *
 * 为 TtsService 提供每种模式的语速/音调/音量参考基线。
 * 实际参数可被 UserBehaviorTtsContract 的调整覆盖（行为需求权重更高）。
 */
export interface LearningTtsModeParams {
  /** 人类可读标签 */
  label: string
  /** 语速调整（百分比，相对当前 baseline）*/
  rateDelta: number
  /** 音调调整（Hz，相对当前 baseline）*/
  pitchDelta: number
  /** 音量建议（0-1）*/
  volumeSuggestion: number
  /** 模式描述 */
  description: string
}

/** 输出模式 → TTS 参数映射表 */
export const LEARNING_OUTPUT_MODE_PARAMS: Record<LearningTtsOutputMode, LearningTtsModeParams> = {
  full: {
    label: '教学·完整',
    rateDelta: 0,
    pitchDelta: 0,
    volumeSuggestion: 0.85,
    description: '完整讲解，语速适中，抑扬顿挫',
  },
  concise: {
    label: '摘要·简洁',
    rateDelta: 8,
    pitchDelta: 3,
    volumeSuggestion: 0.85,
    description: '简明摘要，语速略快，紧凑高效',
  },
  quick: {
    label: '反馈·快速',
    rateDelta: 12,
    pitchDelta: 5,
    volumeSuggestion: 0.85,
    description: '快速反馈，短促直接',
  },
  gradual: {
    label: '代码·渐进',
    rateDelta: -5,
    pitchDelta: 0,
    volumeSuggestion: 0.85,
    description: '代码朗读，逐行停顿，便于跟随',
  },
  gentle: {
    label: '鼓励·柔和',
    rateDelta: -5,
    pitchDelta: -3,
    volumeSuggestion: 0.8,
    description: '柔和鼓励，语速放缓，语调温暖',
  },
}

// ══════════════════════════════════════════
//  5. 内容类型 → 语速/音调权重映射（供路由参考）
// ══════════════════════════════════════════

/**
 * 内容类型的语速/音调权重。
 * qualityWeight 越高越倾向云端 TTS（更高表现力），
 * latencyWeight 越高越倾向本地 TTS（更低延迟）。
 */
export function getContentTypeRoutingWeights(contentType: LearningContentType): { qualityWeight: number; latencyWeight: number } {
  const need = CONTENT_TYPE_TTS_NEED_MAP[contentType]
  switch (need.priority) {
    case 'quality':
      return { qualityWeight: 0.8, latencyWeight: 0.2 }
    case 'latency':
      return { qualityWeight: 0.2, latencyWeight: 0.8 }
    case 'balanced':
    default:
      return { qualityWeight: 0.5, latencyWeight: 0.5 }
  }
}
