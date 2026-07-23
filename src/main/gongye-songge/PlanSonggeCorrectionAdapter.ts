/**
 * PlanSonggeCorrectionAdapter — Wallpaper 算法 → Plan:修正工业颂歌19-27章 适配层
 *
 * ── 设计哲学 ──
 * 提取 Wallpaper 系统的核心算法模式，为「Plan:修正工业颂歌19-27章（按设计文档）」
 * 上下文实现兼容适配层。复用不追求 1:1 精确移植，而是保留算法核心逻辑并用
 * Plan 上下文的数据格式做输入输出转换。
 *
 * ── 复用的 Wallpaper 算法模式 ──
 *
 * 1. Composite Scoring Algorithm（来自 MemoryContextService）
 *    - 原始：behavioScore * 0.4 + confidence * 0.3 + pinnedBonus + recencyBonus
 *    - 适配：designDocMatch * 0.35 + styleConsistency * 0.25 +
 *            structuralAccuracy * 0.20 + contentQuality * 0.20
 *
 * 2. Plugin Adapter Pattern（来自 UserBehaviorPluginAdapter）
 *    - 将源系统（gongye-songge formatters）包装为标准化的契约接口
 *    - 输入输出数据类型转换（↔ normalized snapshot）
 *    - 可选的订阅/通知机制
 *
 * 3. Behavior Snapshot Normalization（来自 UserBehaviorPluginAdapter）
 *    - 将原始输入映射到受限的联合类型域
 *    - 数据完整和 default fallback
 *
 * ── 架构关系 ──
 *   Plan:修正工业颂歌19-27章（调用方）
 *       ↓
 *   SonggeCorrectionAdapter (this class)
 *       ↓  delegates to
 *   gongye-songge/formatters/WechatFormatter (基础排版格式化)
 *       ↓
 *   Wallpaper 算法模式复用（CompositeScore, Normalize, Adapter）
 *
 * ── 使用示例 ──
 * ```ts
 * import { songgeCorrectionAdapter } from './gongye-songge/PlanSonggeCorrectionAdapter'
 *
 * const input = {
 *   chapters: [...],        // 第19-27章原始文本
 *   designDoc: '...',       // 设计文档参考
 *   styleGuide: '工业颂歌公众号排版风格',
 * }
 * const result = songgeCorrectionAdapter.evaluateChapters(input)
 * // result.snapshots[] — 每章的合规评分和修正建议
 * // result.compositeScore — 整体复合得分
 * // result.severity — 综合严重程度
 * ```
 */

import { log } from '../logger/Logger'
import { eventBus } from '../core/EventBus'
import {
  formatBasic,
  detectFormatNeed,
  type WechatFormatOptions,
  type FormatResult,
} from './formatters'

// ════════════════════════════════════════════════════════════════
//  领域类型 — 与 Wallpaper 的 WallpaperBehaviorSnapshot 对应
// ════════════════════════════════════════════════════════════════

/** 章节修正问题的严重程度（类比 Wallpaper 的 activityState: 'active'|'idle'|'away'） */
export type CorrectionSeverity = 'critical' | 'major' | 'minor' | 'info'

/** 章节修正问题的类别（类比 Wallpaper 的 appCategory 分类） */
export type CorrectionCategory =
  | 'design_doc_deviation'  // 背离设计文档
  | 'style_inconsistency'   // 风格不一致
  | 'structural_error'      // 结构错误
  | 'content_quality'       // 内容质量问题
  | 'continuity_gap'        // 情节连续性缺失
  | 'formatting_issue'      // 排版格式问题

/** 各维度的合规评分（类比 Wallpaper 的多维行为评分） */
export interface DimensionScores {
  /** 设计文档符合度 (0-1) — 内容与设计文档的一致性 */
  designDocMatch: number
  /** 风格一致性 (0-1) — 是否符合工业颂歌公众号风格 */
  styleConsistency: number
  /** 结构准确性 (0-1) — 章节目录/段落结构/叙事流程 */
  structuralAccuracy: number
  /** 内容质量 (0-1) — 文笔/逻辑/信息密度 */
  contentQuality: number
  /** 情节连续性 (0-1) — 与前后章节的衔接 */
  continuityScore: number
}

/** 单个修正问题条目（类比 Wallpaper 的 MemoryCardItem） */
export interface CorrectionIssue {
  /** 问题 ID */
  id: string
  /** 所在章节号 (19-27) */
  chapterIndex: number
  /** 问题类别 */
  category: CorrectionCategory
  /** 严重程度 */
  severity: CorrectionSeverity
  /** 问题描述 */
  description: string
  /** 建议修正方式 */
  suggestion: string
  /** 原文中被引用的段落/句子 */
 原文引用?: string
  /** 置信度 (0-1) */
  confidence: number
}

/**
 * 章节修正快照（类比 Wallpaper 的 WallpaperBehaviorSnapshot）。
 * 包含某章的综合评估和修正建议。
 */
export interface ChapterCorrectionSnapshot {
  /** 章节号 (19-27) */
  chapterIndex: number
  /** 各维度评分 */
  scores: DimensionScores
  /** 复合评分 (0-1) */
  compositeScore: number
  /** 发现的修正问题列表 */
  issues: CorrectionIssue[]
  /** 严重程度（基于 compositeScore 映射） */
  severity: CorrectionSeverity
  /** 是否需要修正 */
  needsCorrection: boolean
  /** 格式化结果（如果进行了排版检查） */
  formatResult?: FormatResult | null
  /** 数据处理时间戳 */
  timestamp: number
}

/** 修正输入（类比 Wallpaper 的 EnrichedBehaviorState） */
export interface CorrectionInput {
  /** 第19-27章原始文本（按章节号索引，19..27） */
  chapters: Record<number, string>
  /** 设计文档参考文本 */
  designDoc: string
  /** 风格指南（可选，默认为工业颂歌公众号风格） */
  styleGuide?: string
  /** 排版选项（可选，传递给 formatter） */
  formatOptions?: Partial<WechatFormatOptions>
  /** 历史修正记录（可选，用于持续性评估） */
  previousCorrections?: string[]
}

/** 修正输出（类比 Wallpaper 的聚合数据推送） */
export interface CorrectionResult {
  /** 各章节快照 */
  snapshots: ChapterCorrectionSnapshot[]
  /** 整体复合评分 (0-1) */
  compositeScore: number
  /** 总问题数 */
  totalIssues: number
  /** 需要修正的章节数 */
  chaptersNeedingFix: number
  /** 综合严重程度 */
  severity: CorrectionSeverity
  /** 数据时间戳 */
  timestamp: number
  /** 错误信息（如果有） */
  error?: string
}

// ════════════════════════════════════════════════════════════════
//  提供者契约 — 类比 Wallpaper 的 IBehaviorProvider
// ════════════════════════════════════════════════════════════════

/**
 * 工业颂歌修正提供者契约。
 *
 * 类比 Wallpaper 的 IBehaviorProvider：
 * - IBehaviorProvider.getBehaviorSnapshot() → WallpaperBehaviorSnapshot
 * - ISonggeCorrectionProvider.evaluateChapters() → CorrectionResult
 *
 * 插件实现方（如 Plan:修正工业颂歌19-27章）通过此契约消费修正数据，
 * 不关心适配层的内部实现。
 */
export interface ISonggeCorrectionProvider {
  /** 提供者标识 */
  readonly name: string

  /**
   * 评估指定章节并生成修正建议。
   * @param input 修正输入（章节内容 + 设计文档 + 风格指南）
   * @returns 修正结果或 null（数据不足时返回 null）
   */
  evaluateChapters(input: CorrectionInput): CorrectionResult | null

  /**
   * 订阅修正结果就绪通知。
   * @param callback 新修正就绪时的回调
   * @returns 取消订阅函数
   */
  onCorrectionReady(callback: (result: CorrectionResult) => void): () => void
}

// ════════════════════════════════════════════════════════════════
//  复合评分算法 — 复用 Wallpaper MemoryContextService 的评分模式
// ════════════════════════════════════════════════════════════════

/**
 * 维度评分权重。
 * 对应 MemoryContextService 的评分权重：
 *   behaviorScore * 0.4 + confidence * 0.3 + pinnedBonus + recencyBonus
 *
 * 适配后权重：
 *   designDocMatch * 0.35 + styleConsistency * 0.25 +
 *   structuralAccuracy * 0.20 + contentQuality * 0.20
 */
const SCORE_WEIGHTS = {
  designDocMatch: 0.35,
  styleConsistency: 0.25,
  structuralAccuracy: 0.20,
  contentQuality: 0.20,
} as const

/** 连续性加分（类比 pinned bonus） */
const CONTINUITY_BONUS_WEIGHT = 0.10

/**
 * 复合评分计算器 — 适配自 Wallpaper MemoryContextService 的 composite score。
 *
 * 原始算法（MemoryContextService）：
 *   compositeScore = behaviorScore * 0.4 + confidence * 0.3 + pinnedBonus + recencyBonus
 *
 * 适配算法：
 *   complianceScore = designDocMatch * 0.35 + styleConsistency * 0.25 +
 *                     structuralAccuracy * 0.20 + contentQuality * 0.20 +
 *                     continuityScore * 0.10       ← 连续性加分
 *                     + chapterPositionBonus       ← 位置加分（类比 recencyBonus）
 *
 * 位置加分（类比 recencyBonus）：
 *   首尾章节（19、27）给予 +0.05 的位置加分，
 *   因为首尾章节的结构误差影响面更大
 */
function computeCompositeScore(scores: DimensionScores, chapterIndex: number): number {
  const baseScore =
    scores.designDocMatch * SCORE_WEIGHTS.designDocMatch +
    scores.styleConsistency * SCORE_WEIGHTS.styleConsistency +
    scores.structuralAccuracy * SCORE_WEIGHTS.structuralAccuracy +
    scores.contentQuality * SCORE_WEIGHTS.contentQuality +
    scores.continuityScore * CONTINUITY_BONUS_WEIGHT

  // chapterPositionBonus：类比 recencyBonus
  // 首章(19)和末章(27)结构影响面更大，给予位置加分
  const chapterPositionBonus = (chapterIndex === 19 || chapterIndex === 27) ? 0.05 : 0

  return Math.min(1, Math.max(0, baseScore + chapterPositionBonus))
}

/**
 * 复合评分 → 严重程度映射
 */
function computeSeverity(compositeScore: number, issueCount: number): CorrectionSeverity {
  if (compositeScore < 0.4 || issueCount >= 5) return 'critical'
  if (compositeScore < 0.6 || issueCount >= 3) return 'major'
  if (compositeScore < 0.8 || issueCount >= 1) return 'minor'
  return 'info'
}

// ════════════════════════════════════════════════════════════════
//  维度评估函数 — 类比 Wallpaper 的 normalizeMode/normalizeContext
// ════════════════════════════════════════════════════════════════

/**
 * 评估设计文档符合度。
 * 通过关键词匹配和长度比例估算章节内容与设计文档的一致性。
 *
 * 类比 UserBehaviorPluginAdapter.normalizeMode()：
 *   normalizeMode() 将 string 映射到受限的联合类型
 *   本函数将文本分析结果映射到 [0, 1] 评分区间
 */
function evaluateDesignDocMatch(chapterText: string, designDoc: string): number {
  if (!chapterText || !designDoc) return 0.5 // 默认中值

  const cleanText = chapterText.replace(/\s+/g, ' ').trim()
  const cleanDoc = designDoc.replace(/\s+/g, ' ').trim()

  // 提取设计文档的关键主题词
  const docWords = new Set(cleanDoc.split(/[\s,，。；;：:、]+/).filter(w => w.length >= 2))
  if (docWords.size === 0) return 0.5

  // 计算主题词在章节中的覆盖率
  let matchCount = 0
  for (const word of docWords) {
    if (cleanText.includes(word)) matchCount++
  }

  const coverage = matchCount / docWords.size

  // 长度比例也会影响：章节太短可能覆盖率低
  const lengthRatio = Math.min(1, chapterText.length / 500)

  // 综合评分：覆盖率 0.6 + 长度比例 0.4
  return Math.min(1, coverage * 0.6 + lengthRatio * 0.4)
}

/**
 * 评估风格一致性。
 * 检查章节文本是否包含工业颂歌公众号风格特征。
 *
 * 类比 UserBehaviorPluginAdapter.normalizeContext() 的枚举映射。
 */
function evaluateStyleConsistency(chapterText: string): number {
  if (!chapterText) return 0.5

  const styleIndicators = [
    // 工业颂歌公众号风格特征
    { pattern: /【.*?】/, weight: 0.15 },   // 标题/重点标记风格
    { pattern: /•/, weight: 0.10 },          // 列表符号
    { pattern: /┃/, weight: 0.15 },          // 引用标记
    { pattern: /〖.*?〗/, weight: 0.10 },     // 强调标记
    { pattern: /\n\n/, weight: 0.10 },        // 段落间距
    { pattern: /^\s*╔═/, weight: 0.15, multiline: true },  // 标题框
    { pattern: /✅|📱|📝/, weight: 0.10 },   // emoji 标记
    { pattern: /---\s*\n/, weight: 0.05 },   // 分隔线
    { pattern: /《.*?》/, weight: 0.10 },    // 书名号引用
  ]

  let score = 0.5 // 基础分
  for (const indicator of styleIndicators) {
    if (indicator.multiline) {
      if (indicator.pattern.test(chapterText)) score += indicator.weight
    } else {
      const matches = chapterText.match(indicator.pattern)
      if (matches && matches.length > 0) {
        score += indicator.weight * Math.min(1, matches.length / 3)
      }
    }
  }

  return Math.min(1, score)
}

/**
 * 评估结构准确性。
 * 检查章节是否有合理的段落划分、标题结构和叙事流程。
 */
function evaluateStructuralAccuracy(chapterText: string): number {
  if (!chapterText) return 0.5

  const lines = chapterText.split('\n').filter(l => l.trim())
  const paragraphs = chapterText.split(/\n\s*\n/).filter(p => p.trim())

  let score = 0.5

  // 段落数合理（10-30段）
  const paraCount = paragraphs.length
  if (paraCount >= 10 && paraCount <= 30) score += 0.15
  else if (paraCount >= 5 && paraCount <= 40) score += 0.08

  // 有标题结构
  const hasTitle = /^(#|【)/m.test(chapterText)
  if (hasTitle) score += 0.10

  // 平均段落长度合理（50-300字）
  const avgParaLen = paragraphs.reduce((s, p) => s + p.length, 0) / Math.max(1, paraCount)
  if (avgParaLen >= 50 && avgParaLen <= 300) score += 0.10
  else if (avgParaLen >= 20 && avgParaLen <= 500) score += 0.05

  // 行数合理
  if (lines.length >= 20 && lines.length <= 200) score += 0.10

  // 没有过长的不分段文本
  const maxLineLen = Math.max(...lines.map(l => l.length))
  if (maxLineLen < 200) score += 0.05

  return Math.min(1, score)
}

/**
 * 评估内容质量。
 * 通过文本特征判断文笔质量。
 */
function evaluateContentQuality(chapterText: string): number {
  if (!chapterText) return 0.5
  if (chapterText.length < 100) return 0.3 // 过短

  let score = 0.5

  // 足够的字数
  if (chapterText.length >= 2000) score += 0.15
  else if (chapterText.length >= 1000) score += 0.08

  // 词汇丰富度（不同词的比例）
  const words = chapterText.split(/[\s,，。；;：:、！!？?…—\n]+/).filter(w => w.length > 0)
  const uniqueWords = new Set(words)
  const diversity = uniqueWords.size / Math.max(1, words.length)
  if (diversity >= 0.4) score += 0.10
  else if (diversity >= 0.25) score += 0.05

  // 有对话/引语
  if (chapterText.includes('"') || chapterText.includes('"') || chapterText.includes('「') || chapterText.includes('』')) {
    score += 0.05
  }

  // 有修辞手法（排比、反问等）
  const rhetoricPatterns = [/[？!！]/, /不.*不/, /越.*越/, /既.*又/, /一.*一/]
  for (const p of rhetoricPatterns) {
    if (p.test(chapterText)) { score += 0.03; break }
  }

  return Math.min(1, score)
}

/**
 * 评估情节连续性。
 * 检查章节首尾是否有承接关系。
 *
 * 类比 Wallpaper 的 recencyBonus 时间衰减逻辑：
 *   连续性不佳 → 评分降低（类似长时间不访问的衰减）
 */
function evaluateContinuityScore(
  chapterText: string,
  chapterIndex: number,
  allChapters: Record<number, string>,
): number {
  let score = 0.7 // 默认中高

  // 如果不是首章(19)，检查是否有与上一章衔接的线索
  if (chapterIndex > 19 && allChapters[chapterIndex - 1]) {
    const prevChapter = allChapters[chapterIndex - 1]
    const prevLastLines = prevChapter.split('\n').filter(l => l.trim()).slice(-5).join(' ')
    const currentFirstLines = chapterText.split('\n').filter(l => l.trim()).slice(0, 5).join(' ')

    // 检查是否有共同的关键词/实体（连续性指标）
    const prevEntities = prevLastLines.split(/[\s,，。；;：:、！!？?…—]+/).filter(w => w.length >= 2)
    const currentEntities = currentFirstLines.split(/[\s,，。；;：:、！!？?…—]+/).filter(w => w.length >= 2)

    const overlap = prevEntities.filter(e => currentEntities.includes(e)).length
    const maxEntities = Math.max(prevEntities.length, currentEntities.length)

    if (overlap >= 3 && maxEntities > 0) {
      score = Math.min(1, score + 0.2)
    } else if (overlap === 0 && maxEntities > 5) {
      score = Math.max(0, score - 0.3)
    } else {
      score += overlap / Math.max(1, maxEntities) * 0.2
    }
  }

  return Math.min(1, Math.max(0, score))
}

// ════════════════════════════════════════════════════════════════
//  Issue 检测 — 类比 Wallpaper 的 issue/event 检测机制
// ════════════════════════════════════════════════════════════════

let issueIdCounter = 0

function nextIssueId(): string {
  return `corr_${Date.now()}_${++issueIdCounter}`
}

/**
 * 检测章节中的修正问题。
 * 返回问题列表和置信度。
 *
 * 类比 Wallpaper 的 EventBus 事件订阅机制：
 *   订阅多个事件 → 检测状态变化 → 生成通知
 *   本函数：检查多个维度 → 检测问题 → 生成修正条目
 */
function detectIssues(
  chapterText: string,
  chapterIndex: number,
  scores: DimensionScores,
): CorrectionIssue[] {
  const issues: CorrectionIssue[] = []

  // 1. 设计文档偏离
  if (scores.designDocMatch < 0.5) {
    issues.push({
      id: nextIssueId(),
      chapterIndex,
      category: 'design_doc_deviation',
      severity: scores.designDocMatch < 0.3 ? 'critical' : 'major',
      description: `章节内容与设计文档一致性不足（评分: ${(scores.designDocMatch * 100).toFixed(0)}%）`,
      suggestion: '根据设计文档调整章节主题和关键内容，确保核心议题覆盖完整',
      confidence: 0.7 + scores.designDocMatch * 0.2,
    })
  }

  // 2. 风格不一致
  if (scores.styleConsistency < 0.5) {
    issues.push({
      id: nextIssueId(),
      chapterIndex,
      category: 'style_inconsistency',
      severity: scores.styleConsistency < 0.3 ? 'major' : 'minor',
      description: `未充分使用工业颂歌公众号排版风格（评分: ${(scores.styleConsistency * 100).toFixed(0)}%）`,
      suggestion: '添加标题框╔═、引用标记┃，并使用【】包裹重点内容',
      confidence: 0.65,
    })
  }

  // 3. 结构问题
  if (scores.structuralAccuracy < 0.5) {
    issues.push({
      id: nextIssueId(),
      chapterIndex,
      category: 'structural_error',
      severity: scores.structuralAccuracy < 0.3 ? 'critical' : 'major',
      description: `章节结构不够清晰（评分: ${(scores.structuralAccuracy * 100).toFixed(0)}%）`,
      suggestion: '添加标题层级、合理分段（10-30段），确保叙事流程清晰',
      confidence: 0.6,
    })
  }

  // 4. 内容质量问题
  if (scores.contentQuality < 0.5) {
    issues.push({
      id: nextIssueId(),
      chapterIndex,
      category: 'content_quality',
      severity: scores.contentQuality < 0.3 ? 'critical' : 'major',
      description: `内容质量待提升（评分: ${(scores.contentQuality * 100).toFixed(0)}%）`,
      suggestion: '增加篇幅（建议2000字以上），丰富词汇和修辞手法',
      confidence: 0.55,
    })
  }

  // 5. 连续性缺失
  if (scores.continuityScore < 0.5) {
    issues.push({
      id: nextIssueId(),
      chapterIndex,
      category: 'continuity_gap',
      severity: scores.continuityScore < 0.3 ? 'major' : 'minor',
      description: `与前后章节的衔接不够自然（评分: ${(scores.continuityScore * 100).toFixed(0)}%）`,
      suggestion: '在章节首尾增加承接句，引用前章的关键事件或人物',
      confidence: 0.6,
    })
  }

  return issues
}

// ════════════════════════════════════════════════════════════════
//  SonggeCorrectionAdapter — 核心适配器类
// ════════════════════════════════════════════════════════════════

/**
 * SonggeCorrectionAdapter — 实现 ISonggeCorrectionProvider 契约。
 *
 * 类比 UserBehaviorPluginAdapter：
 *   - UserBehaviorPluginAdapter 包装 UserBehaviorService → WallpaperBehaviorSnapshot
 *   - SonggeCorrectionAdapter 包装 WechatFormatter → ChapterCorrectionSnapshot
 *
 * 内部使用 Wallpaper 算法模式：
 *   1. Composite Scoring（来自 MemoryContextService）
 *   2. Normalization（来自 UserBehaviorPluginAdapter.normalize*）
 *   3. Subscription/Notification（来自 UserBehaviorPluginAdapter.onBehaviorChange）
 */
export class SonggeCorrectionAdapter implements ISonggeCorrectionProvider {
  readonly name = 'songge-correction-adapter'

  /** 订阅者集合（类比 UserBehaviorPluginAdapter.subscribers） */
  private subscribers = new Set<(result: CorrectionResult) => void>()

  /** 最近一次修正结果缓存 */
  private lastResult: CorrectionResult | null = null

  /**
   * 评估章节并生成修正快照。
   *
   * 类比 UserBehaviorPluginAdapter.getBehaviorSnapshot()：
   *   - 收集源数据（UserBehavior state → chapter + designDoc）
   *   - 转换为标准化格式（WallpaperBehaviorSnapshot → ChapterCorrectionSnapshot）
   *   - 应用评分算法（composite score）
   */
  evaluateChapters(input: CorrectionInput): CorrectionResult | null {
    try {
      const { chapters, designDoc, formatOptions } = input

      if (!chapters || Object.keys(chapters).length === 0) {
        log('WARN', 'songge_correction_empty_input')
        return null
      }

      const snapshots: ChapterCorrectionSnapshot[] = []
      let totalIssues = 0
      let chaptersNeedingFix = 0

      // 遍历第19-27章
      for (let i = 19; i <= 27; i++) {
        const chapterText = chapters[i]
        if (!chapterText) {
          log('DEBUG', 'songge_correction_skip_chapter', { chapterIndex: i })
          continue
        }

        // 1. 多维度评分（Wallpaper 算法核心 — 复用 MemoryContextService 评分模式）
        const scores: DimensionScores = {
          designDocMatch: evaluateDesignDocMatch(chapterText, designDoc),
          styleConsistency: evaluateStyleConsistency(chapterText),
          structuralAccuracy: evaluateStructuralAccuracy(chapterText),
          contentQuality: evaluateContentQuality(chapterText),
          continuityScore: evaluateContinuityScore(chapterText, i, chapters),
        }

        // 2. 复合评分（MemoryContextService 权重算法适配）
        const compositeScore = computeCompositeScore(scores, i)

        // 3. 问题检测
        const issues = detectIssues(chapterText, i, scores)

        // 4. 检查排版格式（复用 WechatFormatter）
        const formatResult = this.checkFormatting(chapterText, formatOptions)

        // 5. 构建快照
        const severity = computeSeverity(compositeScore, issues.length)
        const needsCorrection = compositeScore < 0.75 || issues.length > 0

        snapshots.push({
          chapterIndex: i,
          scores,
          compositeScore,
          issues,
          severity,
          needsCorrection,
          formatResult,
          timestamp: Date.now(),
        })

        totalIssues += issues.length
        if (needsCorrection) chaptersNeedingFix++
      }

      if (snapshots.length === 0) {
        log('WARN', 'songge_correction_no_chapters', { available: Object.keys(chapters) })
        return null
      }

      // 6. 计算整体评分
      const avgScore = snapshots.reduce((s, ss) => s + ss.compositeScore, 0) / snapshots.length
      const overallSeverity = computeSeverity(avgScore, totalIssues)

      const result: CorrectionResult = {
        snapshots,
        compositeScore: avgScore,
        totalIssues,
        chaptersNeedingFix,
        severity: overallSeverity,
        timestamp: Date.now(),
      }

      this.lastResult = result

      log('INFO', 'songge_correction_evaluated', {
        chapters: snapshots.length,
        totalIssues,
        avgScore: avgScore.toFixed(3),
        severity: overallSeverity,
        needsFix: chaptersNeedingFix,
      })

      return result
    } catch (err: any) {
      log('WARN', 'songge_correction_evaluate_failed', { error: String(err) })
      return {
        snapshots: [],
        compositeScore: 0,
        totalIssues: 0,
        chaptersNeedingFix: 0,
        severity: 'info',
        timestamp: Date.now(),
        error: String(err),
      }
    }
  }

  /**
   * 订阅修正结果通知（类比 UserBehaviorPluginAdapter.onBehaviorChange）。
   */
  onCorrectionReady(callback: (result: CorrectionResult) => void): () => void {
    this.subscribers.add(callback)
    return () => this.subscribers.delete(callback)
  }

  /**
   * 通知所有订阅者（类比 UserBehaviorPluginAdapter.notify）。
   * 当外部数据源推送新数据时调用。
   * 同时通过 EventBus 广播 'songge.correction.ready' 事件供 Plan 订阅。
   */
  notify(result: CorrectionResult): void {
    this.lastResult = result
    for (const cb of this.subscribers) {
      try {
        cb(result)
      } catch {
        // 单个订阅者失败不影响其他订阅者
      }
    }
    // 通过 EventBus 广播给所有感兴趣的 Plan
    eventBus.emit('songge.correction.ready', {
      version: 1,
      compositeScore: result.compositeScore,
      totalIssues: result.totalIssues,
      chaptersNeedingFix: result.chaptersNeedingFix,
      severity: result.severity,
      timestamp: result.timestamp,
    })
  }

  /** 获取缓存的最近一次修正结果 */
  getLastResult(): CorrectionResult | null {
    return this.lastResult
  }

  /** 重置缓存 */
  clearCache(): void {
    this.lastResult = null
  }

  // ════════════════════════════════════════════════════════════
  //  内部方法
  // ════════════════════════════════════════════════════════════

  /**
   * 检查章节的排版格式。
   * 复用 WechatFormatter 的 detectFormatNeed 和 formatBasic。
   *
   * 类比 UserBehaviorPluginAdapter 对 UserBehavior 的代理调用。
   */
  private checkFormatting(
    chapterText: string,
    options?: Partial<WechatFormatOptions>,
  ): FormatResult | null {
    try {
      const detection = detectFormatNeed(chapterText)
      if (!detection.needsFormat) return null

      return formatBasic(chapterText, {
        publishReady: true,
        sentenceDensity: 'normal',
        paragraphSpacing: 'normal',
        ...options,
      })
    } catch {
      return null
    }
  }
}

// ════════════════════════════════════════════════════════════════
//  单例
// ════════════════════════════════════════════════════════════════

/** 全局单例（类比 agentWallpaperBridge / voiceContinuationService） */
export const songgeCorrectionAdapter = new SonggeCorrectionAdapter()
