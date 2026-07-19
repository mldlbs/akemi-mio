/**
 * PlanBlogWritingAdapter — Wallpaper 算法 → Plan:为项目的技术博客内容设计
 * 写作到发布工作流 适配层
 *
 * ── 设计哲学 ──
 * 提取 Wallpaper 系统的核心算法模式，为「Plan:为项目的技术博客内容设计一套
 * 从写作到发布的完整工作流，包括内容规划、写作、审核、发布等环节」
 * 上下文实现兼容适配层。复用不追求 1:1 精确移植，
 * 而是保留算法核心逻辑并用 Plan 上下文的数据格式做输入输出转换。
 *
 * ── 复用的 Wallpaper 算法模式 ──
 *
 * 1. Composite Scoring Algorithm（来自 MemoryContextService）
 *    - 原始：behaviorScore * 0.4 + confidence * 0.3 + pinnedBonus + recencyBonus
 *    - 适配：contentDepth * 0.25 + codeQuality * 0.25 + readability * 0.20 +
 *            structuralQuality * 0.15 + seoRelevance * 0.10 + publishReadiness * 0.05
 *
 * 2. Plugin Adapter Pattern（来自 UserBehaviorPluginAdapter）
 *    - 将源系统（blog content evaluators）包装为标准化的契约接口
 *    - 输入输出数据类型转换（↔ normalized snapshot）
 *    - 可选的订阅/通知机制
 *
 * 3. Behavior Snapshot Normalization（来自 UserBehaviorPluginAdapter）
 *    - 将原始输入映射到受限的联合类型域
 *    - 数据完整和 default fallback
 *
 * ── 架构关系 ──
 *   Plan:为项目的技术博客内容设计工作流（调用方）
 *       ↓
 *   PlanBlogWritingAdapter (this class)
 *       ↓  delegates to
 *   BlogStage 枚举 + 写作习惯画像 (写作领域基础)
 *       ↓
 *   Wallpaper 算法模式复用（CompositeScore, Normalize, Adapter）
 *
 * ── 使用示例 ──
 * ```ts
 * import { planBlogWritingAdapter } from './agent/blog/PlanBlogWritingAdapter'
 *
 * const input = {
 *   content: '# 标题\n\n正文...',  // 博客内容
 *   topic: 'TypeScript 高级类型',
 *   platform: '博客园',
 * }
 * const result = planBlogWritingAdapter.assessContent(input)
 * // result.assessments[] — 各维度评估结果
 * // result.compositeScore — 整体复合得分
 * // result.severity — 综合严重程度
 * // result.issues — 发现的问题列表
 * ```
 */

import { log } from '../../logger/Logger'
import { BlogStage } from './types'

// ════════════════════════════════════════════════════════════════
//  领域类型 — 与 Wallpaper 的 WallpaperBehaviorSnapshot 对应
// ════════════════════════════════════════════════════════════════

/** 博客内容评估问题的严重程度（类比 Wallpaper 的 activityState: 'active'|'idle'|'away'） */
export type BlogIssueSeverity = 'critical' | 'major' | 'minor' | 'info'

/** 博客内容评估维度的类别（类比 Wallpaper 的 appCategory 分类） */
export type BlogQualityDimension =
  | 'content_depth'       // 内容深度 — 技术细节、概念解释透彻程度
  | 'code_quality'        // 代码质量 — 代码正确性、格式、可运行性
  | 'readability'         // 可读性 — 语言流畅度、AI 腔去除、阅读节奏
  | 'structural_quality'  // 结构质量 — 层级清晰、过渡自然、组织逻辑
  | 'seo_relevance'       // SEO 相关性 — 关键词覆盖、话题热度、元描述
  | 'publish_readiness'   // 发布就绪度 — 格式完整、链接有效、元数据齐全

/** 各维度的合规评分（类比 Wallpaper 的多维行为评分） */
export interface BlogDimensionScores {
  /** 内容深度 (0-1) — 技术细节、概念解释的透彻程度 */
  contentDepth: number
  /** 代码质量 (0-1) — 代码正确性、格式规范、可运行性 */
  codeQuality: number
  /** 可读性 (0-1) — 语言流畅度、AI 腔去除、阅读节奏 */
  readability: number
  /** 结构质量 (0-1) — 层级清晰、过渡自然、组织逻辑 */
  structuralQuality: number
  /** SEO 相关性 (0-1) — 关键词覆盖、话题热度、元描述完整性 */
  seoRelevance: number
  /** 发布就绪度 (0-1) — 格式完整、链接有效、元数据齐全 */
  publishReadiness: number
}

/** 单个评估问题条目（类比 Wallpaper 的 MemoryCardItem） */
export interface BlogWritingIssue {
  /** 问题 ID */
  id: string
  /** 所属维度 */
  dimension: BlogQualityDimension
  /** 严重程度 */
  severity: BlogIssueSeverity
  /** 问题描述 */
  description: string
  /** 建议改进方式 */
  suggestion: string
  /** 原文中被引用的段落/句子（截取） */
  excerpt?: string
  /** 置信度 (0-1) */
  confidence: number
}

/**
 * 内容评估快照（类比 Wallpaper 的 WallpaperBehaviorSnapshot）。
 * 包含某篇博客内容/某阶段的综合评估和建议。
 */
export interface BlogContentAssessment {
  /** 评估目标标识（如阶段名、章节标题） */
  targetId: string
  /** 各维度评分 */
  scores: BlogDimensionScores
  /** 复合评分 (0-1) */
  compositeScore: number
  /** 发现的问题列表 */
  issues: BlogWritingIssue[]
  /** 严重程度（基于 compositeScore 映射） */
  severity: BlogIssueSeverity
  /** 是否需要改进 */
  needsImprovement: boolean
  /** 评估时间戳 */
  timestamp: number
}

/** 评估输入（类比 Wallpaper 的 EnrichedBehaviorState） */
export interface BlogAssessmentInput {
  /** 博客正文（Markdown 格式） */
  content: string
  /** 博客主题/标题 */
  topic?: string
  /** 目标发布平台 */
  platform?: string
  /** 目标受众描述 */
  targetAudience?: string
  /** 受众知识水平 */
  audienceLevel?: 'beginner' | 'intermediate' | 'advanced'
  /** 写作风格偏好 */
  style?: string
  /** 当前所处工作流阶段（可选，用于阶段就绪度评估） */
  currentStage?: BlogStage
  /** 用户反馈/修改意见（可选，用于后续轮次评估） */
  userFeedback?: string[]
  /** 文章字数范围建议（可选） */
  suggestedLength?: { min: number; max: number }
}

/** 评估输出（类比 Wallpaper 的聚合数据推送） */
export interface BlogAssessmentResult {
  /** 各评估快照 */
  assessments: BlogContentAssessment[]
  /** 整体复合评分 (0-1) */
  compositeScore: number
  /** 总问题数 */
  totalIssues: number
  /** 需要改进的评估目标数 */
  targetsNeedingImprovement: number
  /** 综合严重程度 */
  severity: BlogIssueSeverity
  /** 发布就绪状态 */
  publishReady: boolean
  /** 内容统计 */
  stats: {
    /** 总字符数 */
    charCount: number
    /** 估算字数（中文字符） */
    wordCount: number
    /** 代码块数量 */
    codeBlockCount: number
    /** 标题/章节数量 */
    sectionCount: number
    /** 预计阅读时间（分钟） */
    estimatedReadTimeMin: number
  }
  /** 评估时间戳 */
  timestamp: number
  /** 错误信息（如果有） */
  error?: string
}

// ════════════════════════════════════════════════════════════════
//  提供者契约 — 类比 Wallpaper 的 IBehaviorProvider
// ════════════════════════════════════════════════════════════════

/**
 * 博客写作评估提供者契约。
 *
 * 类比 Wallpaper 的 IBehaviorProvider：
 * - IBehaviorProvider.getBehaviorSnapshot() → WallpaperBehaviorSnapshot
 * - IBlogWritingProvider.assessContent() → BlogAssessmentResult
 *
 * 插件实现方（如 Plan:为项目的技术博客内容设计工作流）通过此契约消费评估数据，
 * 不关心适配层的内部实现。
 */
export interface IBlogWritingProvider {
  /** 提供者标识 */
  readonly name: string

  /**
   * 评估博客内容并生成多维质量评分和改进建议。
   * @param input 评估输入（博客正文 + 元信息）
   * @returns 评估结果或 null（数据不足时返回 null）
   */
  assessContent(input: BlogAssessmentInput): BlogAssessmentResult | null

  /**
   * 订阅评估结果就绪通知。
   * @param callback 新评估就绪时的回调
   * @returns 取消订阅函数
   */
  onAssessmentReady(callback: (result: BlogAssessmentResult) => void): () => void
}

// ════════════════════════════════════════════════════════════════
//  复合评分算法 — 复用 Wallpaper MemoryContextService 的评分模式
// ════════════════════════════════════════════════════════════════

/**
 * 维度评分权重。
 * 对应 MemoryContextService 的评分权重：
 *   behaviorScore * 0.4 + confidence * 0.3 + pinnedBonus + recencyBonus
 *
 * 适配后权重（技术博客场景）：
 *   contentDepth * 0.25 + codeQuality * 0.25 + readability * 0.20 +
 *   structuralQuality * 0.15 + seoRelevance * 0.10 + publishReadiness * 0.05
 *
 * 技术博客的核心是技术深度和代码质量，各占最高权重（0.25）。
 * 可读性次之（0.20），结构质量（0.15）支撑内容组织。
 * SEO（0.10）和发布就绪（0.05）作为锦上添花维度。
 */
const SCORE_WEIGHTS: Record<keyof BlogDimensionScores, number> = {
  contentDepth: 0.25,
  codeQuality: 0.25,
  readability: 0.20,
  structuralQuality: 0.15,
  seoRelevance: 0.10,
  publishReadiness: 0.05,
} as const

/** 发布就绪阈值：复合评分达到此值视为可发布 */
const PUBLISH_READY_THRESHOLD = 0.72

/**
 * 复合评分计算器 — 适配自 Wallpaper MemoryContextService 的 composite score。
 *
 * 原始算法（MemoryContextService）：
 *   compositeScore = behaviorScore * 0.4 + confidence * 0.3 + pinnedBonus + recencyBonus
 *
 * 适配算法：
 *   compositeScore = contentDepth * 0.25 + codeQuality * 0.25 +
 *                    readability * 0.20 + structuralQuality * 0.15 +
 *                    seoRelevance * 0.10 + publishReadiness * 0.05
 *                    + 篇幅加分（类比 pinnedBonus）
 *                    + 阶段对齐加分（类比 recencyBonus）
 *
 * 篇幅加分（类比 pinnedBonus）：
 *   技术博客建议 1500-4000 字，在此范围内给予 +0.03 加分，
 *   超出范围不扣分但也不加分。
 *
 * 阶段对齐加分（类比 recencyBonus）：
 *   如果当前内容符合所在工作流阶段的目标，给予 +0.02 加分。
 *   如初稿阶段侧重于"完成度"，润色阶段侧重于"可读性和格式"。
 */
function computeCompositeScore(
  scores: BlogDimensionScores,
  input: BlogAssessmentInput,
): number {
  const baseScore =
    scores.contentDepth * SCORE_WEIGHTS.contentDepth +
    scores.codeQuality * SCORE_WEIGHTS.codeQuality +
    scores.readability * SCORE_WEIGHTS.readability +
    scores.structuralQuality * SCORE_WEIGHTS.structuralQuality +
    scores.seoRelevance * SCORE_WEIGHTS.seoRelevance +
    scores.publishReadiness * SCORE_WEIGHTS.publishReadiness

  // 篇幅加分（类比 pinnedBonus）
  const lengthBonus = computeLengthBonus(input.content)

  // 阶段对齐加分（类比 recencyBonus）
  const stageBonus = computeStageBonus(scores, input.currentStage)

  return Math.min(1, Math.max(0, baseScore + lengthBonus + stageBonus))
}

/**
 * 篇幅加分计算。
 * 技术博客推荐篇幅在 1500-4000 字（中文字符）之间。
 */
function computeLengthBonus(content: string): number {
  if (!content) return 0
  const chineseChars = (content.match(/[一-鿿]/g) || []).length
  if (chineseChars >= 1500 && chineseChars <= 4000) return 0.03
  if (chineseChars >= 800 && chineseChars <= 6000) return 0.01
  return 0
}

/**
 * 阶段对齐加分（类比 recencyBonus）。
 * 根据不同工作流阶段的目标，对相应维度给予加分。
 */
function computeStageBonus(
  scores: BlogDimensionScores,
  currentStage?: BlogStage,
): number {
  if (!currentStage) return 0

  // 不同阶段有不同的重点维度
  switch (currentStage) {
    case BlogStage.Outline:
      // 大纲阶段：结构质量最重要
      return scores.structuralQuality >= 0.8 ? 0.02 : 0
    case BlogStage.DraftWriting:
      // 初稿阶段：内容深度和结构并重
      return (scores.contentDepth >= 0.7 && scores.structuralQuality >= 0.6) ? 0.02 : 0
    case BlogStage.FinalPolish:
      // 润色阶段：可读性和发布就绪度
      return (scores.readability >= 0.75 && scores.publishReadiness >= 0.6) ? 0.02 : 0
    case BlogStage.PublishingPlan:
      // 发布规划：SEO 和发布就绪
      return (scores.seoRelevance >= 0.7 && scores.publishReadiness >= 0.8) ? 0.02 : 0
    default:
      return 0
  }
}

/**
 * 复合评分 → 严重程度映射
 */
function computeSeverity(compositeScore: number, issueCount: number): BlogIssueSeverity {
  if (compositeScore < 0.35 || issueCount >= 6) return 'critical'
  if (compositeScore < 0.55 || issueCount >= 3) return 'major'
  if (compositeScore < 0.75 || issueCount >= 1) return 'minor'
  return 'info'
}

// ════════════════════════════════════════════════════════════════
//  维度评估函数 — 类比 Wallpaper 的 normalizeMode/normalizeContext
// ════════════════════════════════════════════════════════════════

/**
 * 评估内容深度。
 * 检查技术概念解释的透彻程度、例子的丰富度、深度覆盖。
 *
 * 类比 UserBehaviorPluginAdapter.normalizeMode()：
 *   normalizeMode() 将 string 映射到受限的联合类型
 *   本函数将文本分析结果映射到 [0, 1] 评分区间
 */
function evaluateContentDepth(
  content: string,
  topic?: string,
  audienceLevel?: string,
): number {
  if (!content) return 0.4
  if (content.length < 200) return 0.25 // 过短，深度不足

  let score = 0.5 // 基础分

  // 1. 技术术语密度（指标：技术词汇占比）
  const techTerms = [
    // 编程语言/框架
    'TypeScript', 'JavaScript', 'React', 'Vue', 'Angular', 'Node', 'Deno',
    'Python', 'Java', 'Rust', 'Go', 'C\\+\\+', 'Swift', 'Kotlin',
    // 技术概念
    'API', 'SDK', 'HTTP', 'TCP', 'JSON', 'GraphQL', 'REST', 'WebSocket',
    'async', 'await', 'Promise', 'callback', 'closure', 'prototype',
    'interface', 'type', 'class', 'module', 'decorator', 'middleware',
    'database', 'cache', 'queue', 'stream', 'event', 'hook', 'state',
    'component', 'render', 'mount', 'effect', 'memo', 'ref',
    'test', 'deploy', 'CI', 'CD', 'pipeline', 'config',
    'algorithm', 'pattern', 'architecture', 'dependency',
    'performance', 'optimization', 'memory', 'thread',
    // 中文技术词
    '函数', '对象', '数组', '字符串', '变量', '作用域',
    '异步', '同步', '回调', '闭包', '接口', '类', '模块',
    '组件', '渲染', '挂载', '状态', '属性', '方法',
    '编译', '运行时', '类型', '泛型', '枚举', '元组',
    '依赖', '注入', '配置', '部署', '测试', '调试',
    '性能', '优化', '内存', '线程', '并发', '缓存',
  ]

  const techPattern = new RegExp(techTerms.join('|'), 'gi')
  const techMatches = content.match(techPattern) || []
  const techDensity = techMatches.length / Math.max(1, content.length / 100)

  if (techDensity >= 2.0) score += 0.15
  else if (techDensity >= 1.0) score += 0.08
  else if (techDensity < 0.3) score -= 0.05 // 技术博客缺乏技术术语

  // 2. 有代码示例（技术深度的核心指标）
  const codeBlocks = content.match(/```[\s\S]*?```/g) || []
  const inlineCode = content.match(/`[^`]+`/g) || []

  if (codeBlocks.length >= 3) score += 0.15
  else if (codeBlocks.length >= 1) score += 0.08
  if (inlineCode.length >= 10) score += 0.05

  // 3. 有关键解释性模式（"因为…所以"、"意味着"、"本质上"等）
  const explanatoryPatterns = [
    /因为|所以|因此|这意味着|本质上|换句话说|具体来说|举例|例如|比如/,
    /也就是说|换言之|即|相当于|类比|从根本上|核心|关键在于/,
    /注意|重要|关键|区别|对比|优势|劣势|适用场景/,
  ]
  for (const p of explanatoryPatterns) {
    if (p.test(content)) { score += 0.03; break }
  }

  // 4. 引用外部资源（深度文章的标志）
  const hasReferences = /参考|引用|参见|参考文献|更多资源|延伸阅读/i.test(content)
  if (hasReferences) score += 0.04

  // 5. 与主题的相关度（如果提供了主题）
  if (topic) {
    const topicWords = topic.split(/[\s,，。、/]+/).filter(w => w.length >= 2)
    const topicHits = topicWords.filter(w => content.includes(w)).length
    const topicCoverage = topicHits / Math.max(1, topicWords.length)
    if (topicCoverage >= 0.7) score += 0.05
    else if (topicCoverage < 0.3) score -= 0.05
  }

  // 6. 受众适配（如果提供了受众水平）
  if (audienceLevel === 'beginner') {
    // 入门文章应有更多基础解释
    if (explanatoryPatterns.some(p => (content.match(p) || []).length >= 3)) score += 0.03
  } else if (audienceLevel === 'advanced') {
    // 进阶文章应有更高技术密度
    if (techDensity >= 3.0) score += 0.05
  }

  return Math.min(1, Math.max(0, score))
}

/**
 * 评估代码质量。
 * 检查代码块的存在性、格式规范性、完整性。
 */
function evaluateCodeQuality(content: string): number {
  if (!content) return 0.5

  const codeBlocks = content.match(/```(\w*)\n([\s\S]*?)```/g) || []
  if (codeBlocks.length === 0) {
    // 没有代码块不一定扣分（纯理论文章），但也不是加分项
    return 0.5
  }

  let score = 0.5

  // 1. 代码块有语言标识
  const blocksWithLang = codeBlocks.filter(b => /```\w+\n/.test(b))
  const langRatio = blocksWithLang.length / codeBlocks.length
  if (langRatio >= 0.8) score += 0.15
  else if (langRatio >= 0.5) score += 0.08

  // 2. 代码块长度合理（5-50 行最佳）
  const reasonableBlocks = codeBlocks.filter(b => {
    const lines = b.split('\n').filter(l => l.trim() && !l.startsWith('```')).length
    return lines >= 3 && lines <= 60
  })
  const reasonableRatio = reasonableBlocks.length / codeBlocks.length
  if (reasonableRatio >= 0.7) score += 0.10

  // 3. 有行内代码引用（在正文中对代码进行解释）
  const inlineCodes = content.match(/`[^`\n]+`/g) || []
  if (inlineCodes.length >= codeBlocks.length) score += 0.10

  // 4. 代码块前后有解释文本
  const sections = content.split(/```[\s\S]*?```/)
  const explainedBlocks = sections.filter((s, i) => {
    if (i === 0 || i >= sections.length) return false
    const prevText = sections[i - 1].trim()
    const nextText = sections[i + 1]?.trim() || ''
    return prevText.length > 20 || nextText.length > 20
  }).length
  if (explainedBlocks >= codeBlocks.length * 0.6) score += 0.10

  // 5. 代码块不太大（单个块不超过 100 行）
  const hasOversizedBlock = codeBlocks.some(b => {
    const lines = b.split('\n').filter(l => !l.startsWith('```')).length
    return lines > 100
  })
  if (hasOversizedBlock) score -= 0.05

  return Math.min(1, Math.max(0, score))
}

/**
 * 评估可读性。
 * 检查语言流畅度、AI 腔去除、阅读节奏控制。
 */
function evaluateReadability(content: string): number {
  if (!content) return 0.5
  if (content.length < 100) return 0.4

  let score = 0.5

  // 1. AI 腔检测（减分项）
  const aiPhrases = [
    /值得注意的是/,
    /显而易见/,
    /需要指出的是/,
    /毋庸置疑/,
    /不可否认/,
    /众所周知/,
    /在这个数字化时代/,
    /命运的齿轮/,
    /不得不说/,
    /值得一提的是/,
    /我们需要注意/,
    /我们可以看到/,
    /正如我们之前提到的/,
    /总的来说/,
    /综上所述/,
  ]
  const aiHitCount = aiPhrases.filter(p => p.test(content)).length
  if (aiHitCount >= 3) score -= 0.15
  else if (aiHitCount >= 1) score -= 0.05

  // 2. 空洞副词检测（减分项）
  const emptyAdverbs = [
    /非常(地|之)?/,
    /极其/,
    /十分/,
    /很(大|小|多|少|好|坏)/g,
    /超级/,
    /特别(地)?/,
  ]
  const adverbCount = emptyAdverbs.reduce((sum, p) => {
    const matches = content.match(p)
    return sum + (matches ? matches.length : 0)
  }, 0)
  if (adverbCount >= 5) score -= 0.08
  else if (adverbCount >= 2) score -= 0.03

  // 3. 句式多样性（加分项）
  // 检查句子长度分布是否有变化
  const sentences = content.split(/[。！？.!?]/).filter(s => s.trim().length > 5)
  if (sentences.length >= 5) {
    const lengths = sentences.map(s => s.length)
    const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length
    const variance = lengths.reduce((sum, l) => sum + (l - avg) ** 2, 0) / lengths.length
    const stdDev = Math.sqrt(variance)
    // 标准差大说明句式长度有变化，阅读节奏好
    if (stdDev >= 15) score += 0.08
    else if (stdDev >= 8) score += 0.04
  }

  // 4. 段落划分（加分项）
  const paragraphs = content.split(/\n\s*\n/).filter(p => p.trim())
  if (paragraphs.length >= 5 && paragraphs.length <= 30) score += 0.07
  else if (paragraphs.length < 3) score -= 0.05

  // 5. 列表/要点使用（加分项）
  const hasLists = /^\s*[-*]\s/m.test(content) || /^\s*\d+\.\s/m.test(content)
  if (hasLists) score += 0.05

  // 6. 过渡词使用（加分项）
  const transitionWords = [
    /首先|其次|最后|另外|此外|同时|与此(同时|相反)/,
    /然而|但是|不过|虽然|尽管|即使/,
    /例如|比如|举例来说/,
    /因此|所以|于是|从而/,
    /总之|概括|总结/,
  ]
  for (const p of transitionWords) {
    if (p.test(content)) { score += 0.02; break }
  }

  return Math.min(1, Math.max(0, score))
}

/**
 * 评估结构质量。
 * 检查标题层级、组织逻辑、内容流。
 */
function evaluateStructuralQuality(content: string): number {
  if (!content) return 0.5

  let score = 0.5

  // 1. 标题层级（加分项）
  const headings = content.match(/^#{1,4}\s+.+/gm) || []
  if (headings.length >= 3 && headings.length <= 20) score += 0.12
  else if (headings.length >= 1) score += 0.05
  else score -= 0.10 // 技术博客应有标题结构

  // 2. 多级标题（加分项）
  const h1Count = (content.match(/^#\s+.+/gm) || []).length
  const h2Count = (content.match(/^##\s+.+/gm) || []).length
  const h3Count = (content.match(/^###\s+.+/gm) || []).length

  if (h2Count >= 2 && (h3Count >= 1 || h1Count >= 1)) score += 0.08
  else if (h2Count >= 1) score += 0.03

  // 3. 内容—标题匹配（检查标题后内容是否足够）
  if (headings.length > 0) {
    const sections = content.split(/^#{1,4}\s+.+$/m).filter(s => s.trim())
    const thinSections = sections.filter(s => s.length < 100).length
    const thinRatio = thinSections / Math.max(1, sections.length)
    if (thinRatio > 0.5) score -= 0.08 // 太多简短章节
    else if (thinRatio === 0) score += 0.05
  }

  // 4. 引入和结论（加分项）
  const hasIntro = /^(#|##)\s*.*(介绍|概述|前言|背景|引言|开始)/im.test(content)
  const hasConclusion = /^(#|##)\s*.*(总结|结论|回顾|结尾|结语|小结|展望)/im.test(content)
  if (hasIntro) score += 0.05
  if (hasConclusion) score += 0.05

  // 5. 段落一致性
  const paragraphs = content.split(/\n\s*\n/).filter(p => p.trim())
  if (paragraphs.length > 0) {
    const avgParaLen = paragraphs.reduce((s, p) => s + p.length, 0) / paragraphs.length
    // 段落长度在 50-400 字之间比较合理
    if (avgParaLen >= 50 && avgParaLen <= 400) score += 0.05
    else if (avgParaLen > 800) score -= 0.03 // 段落过长
  }

  return Math.min(1, Math.max(0, score))
}

/**
 * 评估 SEO 相关性和话题热度。
 * 检查关键词覆盖、标题优化、元描述完整性。
 */
function evaluateSEORelevance(
  content: string,
  topic?: string,
  platform?: string,
): number {
  if (!content) return 0.5

  let score = 0.5

  // 1. 标题中有关键词（加分项）
  const firstLine = content.split('\n')[0] || ''
  const titleMatch = firstLine.match(/^#\s+(.+)/)
  if (titleMatch) {
    const title = titleMatch[1]
    // 标题长度 10-30 字最佳
    if (title.length >= 10 && title.length <= 30) score += 0.08
    else if (title.length > 40) score -= 0.03

    // 如果提供了主题，检查标题是否包含主题关键词
    if (topic) {
      const topicWords = topic.split(/[\s,，。、/]+/).filter(w => w.length >= 2)
      const titleHasTopic = topicWords.some(w => title.includes(w))
      if (titleHasTopic) score += 0.08
    }
  } else {
    score -= 0.05 // 没有标题
  }

  // 2. 关键词在正文中的分布（加分项）
  if (topic) {
    const topicWords = topic.split(/[\s,，。、/]+/).filter(w => w.length >= 2)
    if (topicWords.length > 0) {
      // 检查关键词是否在文章前中后部分都有出现
      const third = Math.floor(content.length / 3)
      const parts = [
        content.slice(0, third),
        content.slice(third, 2 * third),
        content.slice(2 * third),
      ]
      const coverage = parts.filter(p => topicWords.some(w => p.includes(w))).length
      if (coverage >= 3) score += 0.08
      else if (coverage >= 2) score += 0.04
    }
  }

  // 3. 元描述/摘要（加分项）
  const hasExcerpt = />\s*摘要|<summary>|<!--\s*(more|excerpt|description)/i.test(content)
  if (hasExcerpt) score += 0.05

  // 4. 平台适配（加分项）
  if (platform) {
    const platformKeywords: Record<string, string[]> = {
      '博客园': ['博客园', 'cnblogs'],
      'CSDN': ['CSDN', 'csdn'],
      '知乎': ['知乎', 'zhihu'],
      '掘金': ['掘金', 'juejin'],
      '公众号': ['公众号', '微信'],
    }
    const keywords = platformKeywords[platform]
    if (keywords && keywords.some(k => content.includes(k))) {
      score += 0.03
    }
  }

  // 5. 标签/分类（加分项）
  const hasTags = /tags?|标签|分类|categories?|keywords?/i.test(content)
  if (hasTags) score += 0.05

  // 6. 内链和外链（加分项）
  const links = content.match(/\[.+?\]\(.+?\)/g) || []
  if (links.length >= 2 && links.length <= 10) score += 0.05
  else if (links.length > 15) score -= 0.03 // 链接过多

  return Math.min(1, Math.max(0, score))
}

/**
 * 评估发布就绪度。
 * 检查格式完整性、链接有效性、元数据、发布前检查项。
 */
function evaluatePublishReadiness(
  content: string,
  platform?: string,
): number {
  if (!content) return 0.4

  let score = 0.5

  // 1. 基本格式完整性
  const hasTitle = /^#\s+.+/m.test(content)
  const hasBody = content.replace(/^#\s+.+/m, '').trim().length > 200

  if (hasTitle && hasBody) score += 0.10
  else if (!hasTitle) score -= 0.10

  // 2. 图片 alt 文本检查
  const images = content.match(/!\[.*?\]\(.+?\)/g) || []
  const imagesWithAlt = images.filter(img => !/!\[\\s*\]/.test(img)).length
  if (images.length > 0 && imagesWithAlt === images.length) score += 0.05
  else if (images.length > imagesWithAlt) score -= 0.03

  // 3. 链接完整性
  const brokenLinks = content.match(/\[.+?\]\(\)/g) || []
  if (brokenLinks.length > 0) score -= 0.08

  // 4. 平台特定格式
  if (platform) {
    // 公众号需要导语
    if (platform === '公众号' || platform === '微信公众号') {
      const hasLead = content.split('\n').filter(l => l.trim()).length > 10
        && content.length > 800
      if (hasLead) score += 0.05
      else score -= 0.03
    }
  }

  // 5. 无占位符
  const placeholders = /TODO|FIXME|XXX|待定|待补充|TBD|placeholder/i
  if (placeholders.test(content)) score -= 0.10

  // 6. 版权/署名信息（加分项）
  const hasCopyright = /原创|版权|作者|转载请注明|转载|原文链接/i.test(content)
  if (hasCopyright) score += 0.03

  return Math.min(1, Math.max(0, score))
}

// ════════════════════════════════════════════════════════════════
//  Issue 检测 — 类比 Wallpaper 的 issue/event 检测机制
// ════════════════════════════════════════════════════════════════

let issueIdCounter = 0

function nextIssueId(): string {
  return `bw_${Date.now()}_${++issueIdCounter}`
}

/**
 * 检测博客内容中的质量问题和改进建议。
 * 返回问题列表和置信度。
 *
 * 类比 Wallpaper 的 EventBus 事件订阅机制：
 *   订阅多个事件 → 检测状态变化 → 生成通知
 *   本函数：检查多个维度 → 检测问题 → 生成改进条目
 */
function detectIssues(
  content: string,
  scores: BlogDimensionScores,
): BlogWritingIssue[] {
  const issues: BlogWritingIssue[] = []

  // 1. 内容深度不足
  if (scores.contentDepth < 0.5) {
    issues.push({
      id: nextIssueId(),
      dimension: 'content_depth',
      severity: scores.contentDepth < 0.3 ? 'critical' : 'major',
      description: `技术深度不足（评分: ${(scores.contentDepth * 100).toFixed(0)}%）— 技术概念解释不够透彻或缺乏代码示例`,
      suggestion: '增加技术细节、代码示例和原理分析。确保每个技术概念都有充分的背景说明和实际用例',
      confidence: 0.7 + scores.contentDepth * 0.2,
    })
  }

  // 2. 代码质量问题
  if (scores.codeQuality < 0.5) {
    issues.push({
      id: nextIssueId(),
      dimension: 'code_quality',
      severity: scores.codeQuality < 0.3 ? 'critical' : 'major',
      description: `代码质量待提升（评分: ${(scores.codeQuality * 100).toFixed(0)}%）— 代码块缺少语言标识、长度不当或缺少正文解释`,
      suggestion: '为每个代码块添加语言标识（如 ```typescript），确保代码块长度适中（5-60行），并在代码前后添加解释性文字',
      confidence: 0.65,
    })
  }

  // 3. 可读性问题
  if (scores.readability < 0.5) {
    issues.push({
      id: nextIssueId(),
      dimension: 'readability',
      severity: scores.readability < 0.3 ? 'critical' : 'major',
      description: `可读性待提升（评分: ${(scores.readability * 100).toFixed(0)}%）— 存在 AI 腔、句式单调或段落过长`,
      suggestion: '去除"值得注意的是""显而易见"等 AI 套话，交替长短句控制阅读节奏，合理分段（每段 3-8 句）',
      confidence: 0.6,
    })
  }

  // 4. 结构问题
  if (scores.structuralQuality < 0.5) {
    issues.push({
      id: nextIssueId(),
      dimension: 'structural_quality',
      severity: scores.structuralQuality < 0.3 ? 'critical' : 'major',
      description: `文章结构不够清晰（评分: ${(scores.structuralQuality * 100).toFixed(0)}%）— 缺少标题层级、引入或结论`,
      suggestion: '使用多级标题（## / ###）组织内容，确保有开头引入和最终总结，每个章节有足够的正文支撑',
      confidence: 0.6,
    })
  }

  // 5. SEO 优化不足
  if (scores.seoRelevance < 0.5) {
    issues.push({
      id: nextIssueId(),
      dimension: 'seo_relevance',
      severity: scores.seoRelevance < 0.3 ? 'major' : 'minor',
      description: `SEO 优化不足（评分: ${(scores.seoRelevance * 100).toFixed(0)}%）— 标题关键词不够、缺少元描述或标签`,
      suggestion: '优化标题使其包含核心关键词（10-30字），在文章首段和结尾段复用关键词，添加标签和分类信息',
      confidence: 0.55,
    })
  }

  // 6. 发布就绪问题
  if (scores.publishReadiness < 0.5) {
    issues.push({
      id: nextIssueId(),
      dimension: 'publish_readiness',
      severity: scores.publishReadiness < 0.3 ? 'critical' : 'major',
      description: `发布就绪度不足（评分: ${(scores.publishReadiness * 100).toFixed(0)}%）— 存在占位符、空链接或缺失元数据`,
      suggestion: '清理 TODO/FIXME 占位符，补全空链接（[]()），添加版权/原创声明，确认平台格式要求',
      confidence: 0.7,
    })
  }

  // 7. 特定场景建议（非问题，而是改进建议）
  if (scores.contentDepth >= 0.7 && scores.contentDepth < 0.85) {
    issues.push({
      id: nextIssueId(),
      dimension: 'content_depth',
      severity: 'minor',
      description: '内容深度良好，可考虑增加对比分析或性能数据进一步提升',
      suggestion: '添加与其他方案的对比表格，或补充性能基准测试数据，增强文章的说服力',
      confidence: 0.5,
    })
  }

  // 8. 代码块数量建议
  const codeBlocks = content.match(/```[\s\S]*?```/g) || []
  if (codeBlocks.length === 0 && scores.codeQuality >= 0.5) {
    // 没有代码块的理论文章，给出可选建议
    issues.push({
      id: nextIssueId(),
      dimension: 'code_quality',
      severity: 'info',
      description: '文章未包含代码块',
      suggestion: '如果文章涉及技术实现，建议添加可运行的代码示例来增强说服力',
      confidence: 0.4,
    })
  }

  return issues
}

// ════════════════════════════════════════════════════════════════
//  内容统计
// ════════════════════════════════════════════════════════════════

/**
 * 统计内容基本指标。
 */
function computeContentStats(content: string): BlogAssessmentResult['stats'] {
  const charCount = content.length
  const chineseChars = (content.match(/[一-鿿]/g) || []).length
  const codeBlocks = content.match(/```[\s\S]*?```/g) || []
  const headings = content.match(/^#{1,4}\s+.+/gm) || []
  const wordsPerMinute = 300 // 中文阅读速度
  const estimatedReadTimeMin = Math.max(1, Math.round(chineseChars / wordsPerMinute))

  return {
    charCount,
    wordCount: chineseChars,
    codeBlockCount: codeBlocks.length,
    sectionCount: headings.length,
    estimatedReadTimeMin,
  }
}

// ════════════════════════════════════════════════════════════════
//  PlanBlogWritingAdapter — 核心适配器类
// ════════════════════════════════════════════════════════════════

/**
 * PlanBlogWritingAdapter — 实现 IBlogWritingProvider 契约。
 *
 * 类比 UserBehaviorPluginAdapter：
 *   - UserBehaviorPluginAdapter 包装 UserBehaviorService → WallpaperBehaviorSnapshot
 *   - PlanBlogWritingAdapter 包装 BlogStage 枚举 + 评估函数 → BlogContentAssessment
 *
 * 内部使用 Wallpaper 算法模式：
 *   1. Composite Scoring（来自 MemoryContextService）
 *   2. Normalization（来自 UserBehaviorPluginAdapter.normalize*）
 *   3. Subscription/Notification（来自 UserBehaviorPluginAdapter.onBehaviorChange）
 */
export class PlanBlogWritingAdapter implements IBlogWritingProvider {
  readonly name = 'plan-blog-writing-adapter'

  /** 订阅者集合（类比 UserBehaviorPluginAdapter.subscribers） */
  private subscribers = new Set<(result: BlogAssessmentResult) => void>()

  /** 最近一次评估结果缓存 */
  private lastResult: BlogAssessmentResult | null = null

  /**
   * 评估博客内容并生成多维质量评分和改进建议。
   *
   * 类比 UserBehaviorPluginAdapter.getBehaviorSnapshot()：
   *   - 收集源数据（UserBehavior state → blog content + metadata）
   *   - 转换为标准化格式（WallpaperBehaviorSnapshot → BlogContentAssessment）
   *   - 应用评分算法（composite score）
   */
  assessContent(input: BlogAssessmentInput): BlogAssessmentResult | null {
    try {
      const { content, topic, platform, audienceLevel, currentStage } = input

      if (!content || content.trim().length === 0) {
        log('WARN', 'blog_writing_assessment_empty_input')
        return null
      }

      // 1. 多维度评分（Wallpaper 算法核心 — 复用 MemoryContextService 评分模式）
      const scores: BlogDimensionScores = {
        contentDepth: evaluateContentDepth(content, topic, audienceLevel),
        codeQuality: evaluateCodeQuality(content),
        readability: evaluateReadability(content),
        structuralQuality: evaluateStructuralQuality(content),
        seoRelevance: evaluateSEORelevance(content, topic, platform),
        publishReadiness: evaluatePublishReadiness(content, platform),
      }

      // 2. 复合评分（MemoryContextService 权重算法适配）
      const compositeScore = computeCompositeScore(scores, input)

      // 3. 问题检测
      const issues = detectIssues(content, scores)

      // 4. 构建评估快照
      const targetId = currentStage ? `stage:${currentStage}` : (topic || 'content')
      const severity = computeSeverity(compositeScore, issues.length)
      const needsImprovement = compositeScore < 0.72 || issues.some(i => i.severity === 'critical' || i.severity === 'major')

      const assessment: BlogContentAssessment = {
        targetId,
        scores,
        compositeScore,
        issues,
        severity,
        needsImprovement,
        timestamp: Date.now(),
      }

      // 5. 计算统计信息
      const stats = computeContentStats(content)

      // 6. 发布就绪判断
      const publishReady = compositeScore >= PUBLISH_READY_THRESHOLD && !issues.some(i => i.severity === 'critical')

      const result: BlogAssessmentResult = {
        assessments: [assessment],
        compositeScore,
        totalIssues: issues.length,
        targetsNeedingImprovement: needsImprovement ? 1 : 0,
        severity,
        publishReady,
        stats,
        timestamp: Date.now(),
      }

      this.lastResult = result

      log('INFO', 'blog_writing_assessment_completed', {
        targetId,
        compositeScore: compositeScore.toFixed(3),
        severity,
        totalIssues: issues.length,
        publishReady,
        charCount: stats.charCount,
        estimatedReadTimeMin: stats.estimatedReadTimeMin,
      })

      return result
    } catch (err: any) {
      log('WARN', 'blog_writing_assessment_failed', { error: String(err) })
      return {
        assessments: [],
        compositeScore: 0,
        totalIssues: 0,
        targetsNeedingImprovement: 0,
        severity: 'info',
        publishReady: false,
        stats: {
          charCount: 0,
          wordCount: 0,
          codeBlockCount: 0,
          sectionCount: 0,
          estimatedReadTimeMin: 0,
        },
        timestamp: Date.now(),
        error: String(err),
      }
    }
  }

  /**
   * 订阅评估结果通知（类比 UserBehaviorPluginAdapter.onBehaviorChange）。
   */
  onAssessmentReady(callback: (result: BlogAssessmentResult) => void): () => void {
    this.subscribers.add(callback)
    return () => this.subscribers.delete(callback)
  }

  /**
   * 通知所有订阅者（类比 UserBehaviorPluginAdapter.notify）。
   * 当外部数据源推送新评估时调用。
   */
  notify(result: BlogAssessmentResult): void {
    this.lastResult = result
    for (const cb of this.subscribers) {
      try {
        cb(result)
      } catch {
        // 单个订阅者失败不影响其他订阅者
      }
    }
  }

  /** 获取缓存的最近一次评估结果 */
  getLastResult(): BlogAssessmentResult | null {
    return this.lastResult
  }

  /** 重置缓存 */
  clearCache(): void {
    this.lastResult = null
  }

  // ════════════════════════════════════════════════════════════
  //  便捷查询方法
  // ════════════════════════════════════════════════════════════

  /**
   * 快速检查博客内容是否达到发布就绪标准。
   * 便捷方法，适用于工作流门控决策。
   */
  isPublishReady(input: BlogAssessmentInput): boolean {
    const result = this.assessContent(input)
    return result?.publishReady ?? false
  }

  /**
   * 获取指定维度的详细评估文本描述。
   * 适用于注入 LLM prompt 的场景。
   */
  getDimensionFeedback(scores: BlogDimensionScores): string {
    const lines: string[] = ['【博客质量多维评估】']

    const dimensionLabels: Record<keyof BlogDimensionScores, string> = {
      contentDepth: '内容深度',
      codeQuality: '代码质量',
      readability: '可读性',
      structuralQuality: '结构质量',
      seoRelevance: 'SEO相关性',
      publishReadiness: '发布就绪度',
    }

    for (const [key, label] of Object.entries(dimensionLabels)) {
      const score = scores[key as keyof BlogDimensionScores]
      const bar = this.renderScoreBar(score)
      const status = score >= 0.8 ? '✅' : score >= 0.6 ? '⚠️' : '❌'
      lines.push(`${status} ${label}: ${(score * 100).toFixed(0)}分 ${bar}`)
    }

    return lines.join('\n')
  }

  /**
   * 渲染评分进度条（纯文本）。
   */
  private renderScoreBar(score: number, length: number = 10): string {
    const filled = Math.round(score * length)
    const empty = length - filled
    return '█'.repeat(filled) + '░'.repeat(empty)
  }
}

// ════════════════════════════════════════════════════════════════
//  单例
// ════════════════════════════════════════════════════════════════

/** 全局单例（类比 songgeCorrectionAdapter / agentWallpaperBridge） */
export const planBlogWritingAdapter = new PlanBlogWritingAdapter()
