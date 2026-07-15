/**
 * WritingQualityEvaluator — 文本质量评估器
 *
 * 对已改写的章节进行多维度质量评分：
 * 1. 语义连贯性（段落间主题一致性、过渡自然度）
 * 2. 关键词覆盖率（改写目标中的关键词在结果中的覆盖程度）
 * 3. 结构保留度（原章节结构框架的保留程度）
 * 4. 对话保留度（对话内容的忠实度）
 *
 * 纯本地分析，不调用 LLM，基于统计和规则。
 * 评分范围 0-100，越高越好。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { resolve, join, basename } from 'path'

// =============================================================================
// 类型定义
// =============================================================================

/** 各维度评分 */
export interface QualityDimensions {
  /** 语义连贯性 (0-100) */
  coherence: number
  /** 关键词覆盖率 (0-100) */
  keywordCoverage: number
  /** 结构保留度 (0-100) */
  structurePreservation: number
  /** 对话保留度 (0-100) */
  dialoguePreservation: number
}

/** 完整的质量评估结果 */
export interface QualityEvalResult {
  /** 综合评分 (0-100) */
  overall: number
  /** 各维度评分 */
  dimensions: QualityDimensions
  /** 评估的章节文件名 */
  chapterFile: string
  /** 章节标题 */
  chapterTitle: string
  /** 评估时间戳 */
  timestamp: number
  /** 分析详情文本 */
  details: string[]
  /** 改进建议 */
  suggestions: string[]
  /** 改写的目标关键词（如果提供） */
  targetKeywords?: string[]
}

/** 评估配置 */
export interface EvaluatorConfig {
  /** 章节目录路径（默认 docs/chapters） */
  chapterDir: string
  /** 是否启用详细日志 */
  verbose: boolean
}

// =============================================================================
// 常量
// =============================================================================

const DEFAULT_CHAPTER_DIR = resolve(process.cwd(), 'docs/chapters')
const PROJECT_ROOT = resolve(process.cwd())

/** 中文停用词（用于语义分析时过滤） */
const STOP_WORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着',
  '没有', '看', '好', '自己', '这', '他', '她', '它', '们', '那', '什么',
  '吗', '啊', '呢', '吧', '嗯', '哦', '喂', '哎', '呀', '嘛',
  '把', '被', '让', '给', '对', '从', '向', '在', '于', '以', '与',
  '但', '而', '或', '及', '如果', '因为', '所以', '虽然', '但是', '而且',
  '可以', '能够', '应该', '可能', '已经', '正在', '还是', '就是', '只是',
  '这个', '那个', '这些', '那些', '这里', '那里', '怎么', '怎样', '多么',
  '非常', '比较', '更加', '稍微', '几乎', '大约', '至少', '最多',
  '来', '去', '进', '出', '回', '过', '起', '开', '走', '跑', '跳',
])

// =============================================================================
// WritingQualityEvaluator
// =============================================================================

export class WritingQualityEvaluator {
  private config: EvaluatorConfig

  constructor(config?: Partial<EvaluatorConfig>) {
    this.config = {
      chapterDir: DEFAULT_CHAPTER_DIR,
      verbose: false,
      ...config,
    }
  }

  /**
   * 评估单个章节文件的质量
   *
   * @param chapterPath 章节文件路径
   * @param targetKeywords 改写目标关键词（可选）
   */
  evaluateChapter(
    chapterPath: string,
    targetKeywords?: string[],
  ): QualityEvalResult | null {
    const fullPath = resolve(PROJECT_ROOT, chapterPath)
    if (!existsSync(fullPath)) return null

    const content = this.readChapterContent(fullPath)
    if (!content) return null

    const { text, title } = content
    const dimensions = this.evaluateDimensions(text, targetKeywords)
    const overall = this.computeOverall(dimensions)
    const suggestions = this.generateSuggestions(dimensions)
    const details = this.buildDetails(dimensions, text)

    return {
      overall,
      dimensions,
      chapterFile: chapterPath,
      chapterTitle: title,
      timestamp: Date.now(),
      details,
      suggestions,
      targetKeywords,
    }
  }

  /**
   * 评估最近改动过的章节
   *
   * @param count 返回最近 N 个章节
   * @param targetKeywords 改写目标关键词
   */
  evaluateRecentChapters(
    count: number = 3,
    targetKeywords?: string[],
  ): QualityEvalResult[] {
    if (!existsSync(this.config.chapterDir)) return []

    const results: QualityEvalResult[] = []
    try {
      const entries = readdirSync(this.config.chapterDir)
        .filter((e) => e.endsWith('.md'))
        .map((e) => join(this.config.chapterDir, e))
        .filter((p) => statSync(p).isFile())
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs) // 最近修改的优先
        .slice(0, count)

      for (const entry of entries) {
        const relPath = this.toRelPath(entry)
        const result = this.evaluateChapter(relPath, targetKeywords)
        if (result) results.push(result)
      }
    } catch {
      // 目录不可读时返回空
    }

    return results
  }

  /**
   * 批量评估指定目录下所有章节
   */
  evaluateAllChapters(targetKeywords?: string[]): QualityEvalResult[] {
    if (!existsSync(this.config.chapterDir)) return []

    const results: QualityEvalResult[] = []
    try {
      const entries = readdirSync(this.config.chapterDir)
        .filter((e) => e.endsWith('.md'))
        .map((e) => join(this.config.chapterDir, e))
        .filter((p) => statSync(p).isFile())

      for (const entry of entries) {
        const relPath = this.toRelPath(entry)
        const result = this.evaluateChapter(relPath, targetKeywords)
        if (result) results.push(result)
      }
    } catch {
      // 目录不可读时返回空
    }

    return results
  }

  // ===========================================================================
  // 内部评估方法
  // ===========================================================================

  /** 读取章节文件内容，去除 frontmatter */
  private readChapterContent(filePath: string): { text: string; title: string } | null {
    try {
      let content = readFileSync(filePath, 'utf-8')
      let title = basename(filePath, '.md')

      if (content.startsWith('---')) {
        const endIdx = content.indexOf('---', 3)
        if (endIdx > 0) {
          const frontmatter = content.slice(3, endIdx).trim()
          const titleMatch = frontmatter.match(/^title:\s*(.+)$/m)
          if (titleMatch) title = titleMatch[1].trim()
          content = content.slice(endIdx + 3).trim()
        }
      }

      return { text: content, title }
    } catch {
      return null
    }
  }

  /** 将绝对路径转为项目相对路径 */
  private toRelPath(absPath: string): string {
    const rel = absPath.replace(PROJECT_ROOT.replace(/\\/g, '/'), '').replace(/^[/\\]/, '')
    return rel.replace(/\\/g, '/')
  }

  /** 评估所有维度的质量 */
  private evaluateDimensions(
    text: string,
    targetKeywords?: string[],
  ): QualityDimensions {
    const coherence = this.evaluateCoherence(text)
    const keywordCoverage = this.evaluateKeywordCoverage(text, targetKeywords)
    const structurePreservation = this.evaluateStructure(text)
    const dialoguePreservation = this.evaluateDialogue(text)

    return { coherence, keywordCoverage, structurePreservation, dialoguePreservation }
  }

  // ── 维度 1: 语义连贯性 ──

  /**
   * 评估语义连贯性
   *
   * 方法：
   * - 计算相邻段落的词重叠率（段落间的主题延续性）
   * - 分析段落长度变化的平滑度（预示自然过渡）
   * - 统计话题断裂点比例
   */
  private evaluateCoherence(text: string): number {
    const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 50)
    if (paragraphs.length < 2) return 60 // 章节太短，默认中等分

    let totalOverlap = 0
    let transitionCount = 0
    let abruptTransitions = 0

    for (let i = 1; i < paragraphs.length; i++) {
      const prevWords = this.extractContentWords(paragraphs[i - 1])
      const currWords = this.extractContentWords(paragraphs[i])
      if (prevWords.length === 0 || currWords.length === 0) continue

      // 计算词重叠率
      const prevSet = new Set(prevWords)
      const overlap = currWords.filter((w) => prevSet.has(w)).length
      const overlapRatio = overlap / Math.max(currWords.length, 1)
      totalOverlap += overlapRatio
      transitionCount++

      // 检测突兀过渡：重叠率极低
      if (overlapRatio < 0.05) abruptTransitions++
    }

    if (transitionCount === 0) return 60

    // 平均段落间词重叠率
    const avgOverlap = totalOverlap / transitionCount
    const abruptRatio = abruptTransitions / transitionCount

    // 评分公式：期望中等偏高的重叠（太高中文重复多，太低则话题跳跃）
    let score = 50

    // 重叠率评分 (0.1-0.3 最佳)
    if (avgOverlap >= 0.1 && avgOverlap <= 0.3) score += 25
    else if (avgOverlap > 0.05 && avgOverlap < 0.4) score += 15
    else if (avgOverlap <= 0.05) score -= 10 // 各段落几乎没有关联
    else score += 5 // 重叠偏高但可接受

    // 突兀过渡惩罚
    if (abruptRatio > 0.3) score -= 15
    else if (abruptRatio > 0.15) score -= 5

    // 段落数量奖励（足够多段落才可能有丰富的内容结构）
    if (paragraphs.length >= 5) score += 5
    else if (paragraphs.length >= 3) score += 2

    return Math.max(0, Math.min(100, Math.round(score)))
  }

  // ── 维度 2: 关键词覆盖率 ──

  /**
   * 评估关键词覆盖率
   *
   * 计算改写目标中的关键词在文本中的出现情况
   */
  private evaluateKeywordCoverage(
    text: string,
    targetKeywords?: string[],
  ): number {
    if (!targetKeywords || targetKeywords.length === 0) {
      return 70 // 无目标关键词，默认良好
    }

    const lowerText = text.toLowerCase()
    let totalWeight = 0
    let coveredWeight = 0

    for (const kw of targetKeywords) {
      const lowerKw = kw.toLowerCase()
      const weight = 1.0
      totalWeight += weight

      // 检查关键词是否出现
      const count = (lowerText.match(new RegExp(this.escapeRegex(lowerKw), 'g')) || []).length
      if (count > 0) {
        // 多次出现给予额外权重，但不超过 1.5 倍
        coveredWeight += weight * Math.min(1 + (count - 1) * 0.1, 1.5)
      }
    }

    if (totalWeight === 0) return 70

    return Math.round((coveredWeight / totalWeight) * 100)
  }

  // ── 维度 3: 结构保留度 ──

  /**
   * 评估结构保留度
   *
   * 分析章节的标题层级、场景分隔符、段落分布
   */
  private evaluateStructure(text: string): number {
    const lines = text.split('\n')

    // 检查是否有章节标题和场景分隔
    const headings = lines.filter((l) => /^#{1,6}\s/.test(l.trim()))
    const sceneBreaks = lines.filter((l) => /^---\s*$|^\*\*\*\s*$/.test(l.trim()))
    const hasFrontmatter = text.startsWith('---')

    let score = 60

    // 有章节标题 = 结构良好
    if (headings.length >= 2) score += 15
    else if (headings.length === 1) score += 8

    // 有场景分隔 = 结构丰富
    if (sceneBreaks.length >= 2) score += 10
    else if (sceneBreaks.length === 1) score += 5

    // 段落数量适中（太少或太多都不好）
    const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0)
    if (paragraphs.length >= 5 && paragraphs.length <= 50) score += 10
    else if (paragraphs.length > 50) score += 3 // 太长但可接受
    else if (paragraphs.length < 3) score -= 10 // 太短

    // 有 frontmatter = 规范化
    if (hasFrontmatter) score += 5

    return Math.max(0, Math.min(100, Math.round(score)))
  }

  // ── 维度 4: 对话保留度 ──

  /**
   * 评估对话保留度
   *
   * 分析文本中对话标记（引号、括号）的使用情况。
   * 对话占比过低或过高都不好（参考值 15%-40%）
   */
  private evaluateDialogue(text: string): number {
    const lines = text.split('\n').filter((l) => l.trim().length > 0)
    if (lines.length === 0) return 50

    // 检测对话行：包含中文引号的行
    const dialogueMarkers = /[「」『』""""]/
    const dialogueLines = lines.filter((l) => dialogueMarkers.test(l))
    const dialogueRatio = dialogueLines.length / lines.length

    let score = 50

    // 对话比例适中最好
    if (dialogueRatio >= 0.15 && dialogueRatio <= 0.4) score += 25
    else if (dialogueRatio >= 0.1 && dialogueRatio <= 0.5) score += 15
    else if (dialogueRatio > 0.5) {
      score += 5 // 对话偏多但可接受
    } else {
      // 对话偏少
      if (dialogueRatio > 0.05) score += 5
      else score -= 10 // 几乎没有对话（如果是叙事类则不减分）
    }

    // 对话行分布均匀度（对话行应在章节中均匀分布）
    if (dialogueLines.length >= 4) {
      // 计算对话行间隔的变异系数
      const indices = lines.map((l, i) => ({ line: l, idx: i }))
        .filter((l) => dialogueMarkers.test(l.line))
        .map((l) => l.idx)

      if (indices.length >= 2) {
        const gaps: number[] = []
        for (let i = 1; i < indices.length; i++) {
          gaps.push(indices[i] - indices[i - 1])
        }
        const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length
        if (avgGap > 0) {
          const variance = gaps.reduce((sum, g) => sum + Math.pow(g - avgGap, 2), 0) / gaps.length
          const cv = Math.sqrt(variance) / avgGap
          // 变异系数越小越均匀
          if (cv <= 0.8) score += 10
          else if (cv <= 1.2) score += 5
        }
      }
    }

    return Math.max(0, Math.min(100, Math.round(score)))
  }

  // ===========================================================================
  // 辅助方法
  // ===========================================================================

  /** 提取文本中的实词（去停用词、标点） */
  private extractContentWords(text: string): string[] {
    // 移除标点符号，保留中文字符和字母
    const cleaned = text.replace(/[，。！？、；：""''「」『』（）【】《》\s\n\r\t.,!?;:'"()\[\]{}<>/\\|`~@#$%^&*\-=+]/g, ' ')
    const words = cleaned
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !STOP_WORDS.has(w))
    return words
  }

  /** 转义正则表达式特殊字符 */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  /** 计算综合评分 */
  private computeOverall(dimensions: QualityDimensions): number {
    // 权重分配
    const weights = {
      coherence: 0.35,
      keywordCoverage: 0.25,
      structurePreservation: 0.20,
      dialoguePreservation: 0.20,
    }
    return Math.round(
      dimensions.coherence * weights.coherence +
      dimensions.keywordCoverage * weights.keywordCoverage +
      dimensions.structurePreservation * weights.structurePreservation +
      dimensions.dialoguePreservation * weights.dialoguePreservation,
    )
  }

  /** 生成改进建议 */
  private generateSuggestions(dimensions: QualityDimensions): string[] {
    const suggestions: string[] = []

    if (dimensions.coherence < 60) {
      suggestions.push('语义连贯性偏低：建议增加段落间的过渡句，确保各段落之间有自然的主题延续。')
    }
    if (dimensions.keywordCoverage < 50 && dimensions.keywordCoverage >= 0) {
      suggestions.push('关键词覆盖不足：检查改写目标中的核心关键词是否在文中充分使用。')
    }
    if (dimensions.structurePreservation < 60) {
      suggestions.push('结构保留度偏低：建议添加章节标题或场景分隔符来增强结构清晰度。')
    }
    if (dimensions.dialoguePreservation < 50) {
      suggestions.push('对话比例偏低：如果适合该章节风格，可考虑增加对话内容丰富节奏。')
    }
    if (dimensions.dialoguePreservation > 70 && dimensions.coherence > 70) {
      suggestions.push('整体质量良好，可适度增加改写强度以提升表达多样性。')
    }

    if (suggestions.length === 0) {
      suggestions.push('各维度评分良好，保持当前改写策略。')
    }

    return suggestions
  }

  /** 构建分析详情文本 */
  private buildDetails(
    dimensions: QualityDimensions,
    text: string,
  ): string[] {
    const lines: string[] = []
    const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0)
    const totalChars = text.length

    lines.push(`📊 文本统计：${totalChars}字, ${paragraphs.length}段`)
    lines.push('')

    if (dimensions.coherence >= 70) {
      lines.push('✅ 语义连贯性良好 - 段落间过渡自然')
    } else if (dimensions.coherence >= 50) {
      lines.push('🟡 语义连贯性一般 - 部分段落过渡较突兀')
    } else {
      lines.push('🔴 语义连贯性需改善 - 段落间缺乏主题延续')
    }

    if (dimensions.keywordCoverage >= 70) {
      lines.push('✅ 关键词覆盖充分')
    } else if (dimensions.keywordCoverage >= 50) {
      lines.push('🟡 关键词覆盖一般')
    } else {
      lines.push('🔴 关键词覆盖不足')
    }

    return lines
  }
}
