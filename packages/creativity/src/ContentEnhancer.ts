import { log } from '@akemi-mio/core/logger/Logger'
import type { CreativitySource } from './types'

/**
 * 增强后的来源 — 在 CreativitySource 基础上扩展语义字段
 */
export interface EnhancedSource extends CreativitySource {
  /** 自动生成的摘要（1-3 句话） */
  summary?: string
  /** 提取的关键词（5-10 个） */
  keywords?: string[]
  /** 内容质量评分 0-100 */
  qualityScore?: number
  /** 内容结构复杂度 0-100 */
  structuralComplexity?: number
  /** 语义密度（有效信息占比） */
  semanticDensity?: number
}

interface FetchResult {
  content: string
  title?: string
  ok: boolean
}

/**
 * ContentEnhancer — 内容深度增强的核心模块
 *
 * 职责：
 * 1. 从 URL 抓取完整内容（带缓存和超时）
 * 2. 从原始文本提取摘要和关键词
 * 3. 计算真实的内容深度（语义分析，非简单长度）
 *
 * 设计原则：
 * - 纯函数式：不持有状态，每次调用独立
 * - 容错降级：抓取失败时保留原始内容，不阻塞创造力流程
 * - 轻量级：不引入外部依赖，使用原生 fetch + 正则分词
 */
export class ContentEnhancer {
  private fetchTimeoutMs: number
  private maxContentLength: number
  private cache: Map<string, { content: string; title?: string; at: number }>
  private cacheTtlMs: number

  constructor(options?: { fetchTimeoutMs?: number; maxContentLength?: number; cacheTtlMs?: number }) {
    this.fetchTimeoutMs = options?.fetchTimeoutMs ?? 8000
    this.maxContentLength = options?.maxContentLength ?? 50000
    this.cacheTtlMs = options?.cacheTtlMs ?? 60 * 60 * 1000 // 1 hour
    this.cache = new Map()
  }

  /**
   * 批量增强来源 — 主入口
   *
   * 对每个来源：
   * 1. 如果 content 中包含 URL，尝试抓取完整内容
   * 2. 基于最终内容生成摘要、关键词、质量评分
   * 3. 重新计算 sourceDepth（语义分析）
   */
  async enhance(sources: CreativitySource[]): Promise<EnhancedSource[]> {
    const enhanced: EnhancedSource[] = []

    for (const source of sources) {
      try {
        const result = await this.enhanceOne(source)
        enhanced.push(result)
      } catch (err: any) {
        log('WARN', 'content_enhancer_error', {
          source: source.name,
          error: String(err?.message ?? err),
        })
        // 降级：保留原始来源
        enhanced.push({
          ...source,
          summary: source.content,
          keywords: [],
          qualityScore: this.estimateQuality(source.content),
          sourceDepth: source.sourceDepth ?? this.classifyDepth(source.content),
        })
      }
    }

    log('INFO', 'content_enhancer_done', {
      input: sources.length,
      output: enhanced.length,
      withUrls: enhanced.filter((e) => e.keywords && e.keywords.length > 0).length,
    })

    return enhanced
  }

  /**
   * 增强单个来源
   */
  private async enhanceOne(source: CreativitySource): Promise<EnhancedSource> {
    const baseContent = source.fullContent ?? source.content
    const urls = this.extractUrls(baseContent)

    let enrichedContent = baseContent
    let fetchedTitle: string | undefined

    // 如果有 URL，尝试抓取
    if (urls.length > 0) {
      const fetched = await this.fetchAndExtract(urls[0])
      if (fetched.ok && fetched.content.length > enrichedContent.length) {
        enrichedContent = fetched.content
        fetchedTitle = fetched.title
      }
    }

    const summary = this.extractSummary(enrichedContent)
    const keywords = this.extractKeywords(enrichedContent)
    const qualityScore = this.estimateQuality(enrichedContent)
    const structuralComplexity = this.measureStructuralComplexity(enrichedContent)
    const semanticDensity = this.computeSemanticDensity(enrichedContent)
    const sourceDepth = this.classifyDepth(enrichedContent)

    return {
      ...source,
      name: fetchedTitle ? `${source.name} (${fetchedTitle.slice(0, 20)})` : source.name,
      fullContent: enrichedContent,
      sourceDepth,
      summary,
      keywords,
      qualityScore,
      structuralComplexity,
      semanticDensity,
    }
  }

  // ── URL 抓取 ──────────────────────────────────────────────

  /**
   * 从文本中提取 URL
   */
  private extractUrls(text: string): string[] {
    const urlRegex = /https?:\/\/[^\s<>"')\]]+/gi
    const matches = text.match(urlRegex) ?? []
    // 过滤掉明显的图片/资源链接
    return matches.filter((u) => !/\.(png|jpg|jpeg|gif|svg|ico|css|js|woff|ttf)$/i.test(u) && u.length < 500)
  }

  /**
   * 抓取 URL 内容并提取纯文本
   */
  private async fetchAndExtract(url: string): Promise<FetchResult> {
    // 检查缓存
    const cached = this.cache.get(url)
    if (cached && Date.now() - cached.at < this.cacheTtlMs) {
      return { content: cached.content, title: cached.title, ok: true }
    }

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(this.fetchTimeoutMs),
        headers: {
          'User-Agent': 'Mio-ContentEnhancer/1.0',
          Accept: 'text/html,text/plain,*/*',
        },
      })

      if (!res.ok) {
        return { content: '', ok: false }
      }

      const contentType = res.headers.get('content-type') ?? ''
      const raw = await res.text()

      let content: string
      let title: string | undefined

      if (contentType.includes('html')) {
        const extracted = this.extractFromHtml(raw)
        content = extracted.text
        title = extracted.title
      } else {
        content = raw
        title = undefined
      }

      // 限制长度
      content = content.slice(0, this.maxContentLength)

      // 缓存
      this.cache.set(url, { content, title, at: Date.now() })

      return { content, title, ok: content.length > 0 }
    } catch {
      return { content: '', ok: false }
    }
  }

  /**
   * 从 HTML 中提取纯文本和标题
   */
  private extractFromHtml(html: string): { text: string; title?: string } {
    // 提取 title
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    const title = titleMatch?.[1]?.replace(/\s+/g, ' ').trim()

    // 移除 script/style/nav/header/footer
    let cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<header[\s\S]*?<\/header>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')

    // 移除 HTML 标签
    cleaned = cleaned.replace(/<[^>]+>/g, ' ')

    // 解码常见 HTML 实体
    cleaned = cleaned
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')

    // 合并空白
    cleaned = cleaned.replace(/\s+/g, ' ').trim()

    return { text: cleaned, title }
  }

  // ── 摘要提取 ──────────────────────────────────────────────

  /**
   * 从文本中提取摘要（最重要的 1-3 句话）
   */
  private extractSummary(text: string): string {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (clean.length === 0) return ''

    // 按句子分割（中英文标点）
    const sentences = clean
      .split(/(?<=[。！？.!?\n])\s*/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 5 && s.length <= 200)

    if (sentences.length === 0) {
      return clean.length > 150 ? `${clean.slice(0, 150)}…` : clean
    }

    // 对句子打分：位置靠前 + 包含关键词 = 更重要
    const scored = sentences.map((s, i) => {
      let score = 0
      // 位置权重：前 3 句更重要
      score += Math.max(0, 10 - i * 2)
      // 包含数字/百分比 = 可能是关键信息
      if (/\d+%|\d+\.\d+|\d+[\s]*(?:个|条|项|种)/.test(s)) score += 5
      // 包含冒号 = 可能是定义/解释
      if (/[：:]/.test(s)) score += 3
      // 长度适中
      if (s.length >= 20 && s.length <= 100) score += 2
      // 包含"是"/"为"/"指" = 定义句
      if (/是|为|指|表示|意味着/.test(s)) score += 4
      return { sentence: s, score }
    })

    scored.sort((a, b) => b.score - a.score)

    // 取 top 3，按原始顺序排列
    const top = scored.slice(0, 3).sort((a, b) => {
      const idxA = sentences.indexOf(a.sentence)
      const idxB = sentences.indexOf(b.sentence)
      return idxA - idxB
    })

    const summary = top
      .map((t) => t.sentence)
      .join(' ')
      .slice(0, 300)

    return summary
  }

  // ── 关键词提取 ──────────────────────────────────────────────

  /**
   * 从文本中提取关键词（TF 简化版）
   */
  private extractKeywords(text: string): string[] {
    const clean = text
      .replace(/https?:\/\/[^\s]+/g, ' ')
      .replace(/[^\w\u4e00-\u9fff\u3400-\u4dbf]+/g, ' ')
      .toLowerCase()

    if (clean.length === 0) return []

    // 中文：2-4 字组合
    const zhTokens: string[] = []
    const zhChars = clean.match(/[\u4e00-\u9fff\u3400-\u4dbf]{2,6}/g) ?? []
    for (const token of zhChars) {
      if (token.length >= 2 && token.length <= 4) {
        zhTokens.push(token)
      }
      // 也切出 2-gram
      if (token.length > 2) {
        for (let i = 0; i < token.length - 1; i++) {
          zhTokens.push(token.slice(i, i + 2))
        }
      }
    }

    // 英文：按空格分词
    const enTokens = clean.match(/[a-z][a-z0-9_-]{2,}/g) ?? []

    // 停用词过滤
    const stopWords = new Set([
      'the',
      'is',
      'are',
      'was',
      'were',
      'be',
      'been',
      'being',
      'have',
      'has',
      'had',
      'do',
      'does',
      'did',
      'will',
      'would',
      'could',
      'should',
      'may',
      'might',
      'shall',
      'can',
      'this',
      'that',
      'these',
      'those',
      'and',
      'or',
      'but',
      'if',
      'then',
      'for',
      'with',
      'from',
      'to',
      'in',
      'on',
      'at',
      'by',
      'of',
      '的',
      '了',
      '在',
      '是',
      '我',
      '有',
      '和',
      '就',
      '不',
      '人',
      '都',
      '一',
      '一个',
      '上',
      '也',
      '很',
      '到',
      '说',
      '要',
      '去',
      '你',
      '会',
      '着',
      '没有',
      '看',
      '好',
      '自己',
      '这',
      '他',
      '她',
      '它',
      '们',
      '那',
      '这个',
      '那个',
      '什么',
      '怎么',
      '可以',
      '没',
      '来',
      '对',
      '从',
      '把',
      '被',
      '让',
      '给',
      '能',
      '而',
      '还',
    ])

    const allTokens = [...zhTokens, ...enTokens].filter((t) => !stopWords.has(t) && t.length >= 2)

    // 词频统计
    const freq = new Map<string, number>()
    for (const t of allTokens) {
      freq.set(t, (freq.get(t) ?? 0) + 1)
    }

    // 按频率排序，取 top 8
    const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1])
    const keywords = sorted.slice(0, 8).map(([w]) => w)

    // 去重（子串去重：如果 "语音识别" 和 "语音" 都在，保留更长的）
    return this.deduplicateKeywords(keywords)
  }

  private deduplicateKeywords(keywords: string[]): string[] {
    const result: string[] = []
    for (const kw of keywords) {
      const isRedundant = result.some((existing) => existing.includes(kw) || kw.includes(existing))
      if (!isRedundant) {
        result.push(kw)
      }
      if (result.length >= 8) break
    }
    return result
  }

  // ── 内容质量评估 ──────────────────────────────────────────

  /**
   * 估算内容质量 0-100
   */
  private estimateQuality(text: string): number {
    if (!text || text.length === 0) return 0

    let score = 0

    // 长度评分（适中为佳）
    const len = text.length
    if (len >= 100 && len <= 2000) score += 25
    else if (len >= 50 && len < 100) score += 15
    else if (len > 2000 && len <= 5000) score += 20
    else if (len > 5000) score += 18
    else score += 5

    // 句子数量（信息量）
    const sentences = text.split(/[。！？.!?\n]+/).filter((s) => s.trim().length > 5)
    if (sentences.length >= 3) score += 20
    else if (sentences.length >= 1) score += 10

    // 包含结构化信息
    if (/\d+/.test(text)) score += 10 // 有数字
    if (/[：:]/.test(text)) score += 5 // 有定义/解释
    if (/["""']/.test(text)) score += 5 // 有引用
    if (/\n/.test(text)) score += 5 // 有多行结构

    // 信息密度：独特词占比
    const words = text
      .toLowerCase()
      .split(/[\s,，。.、：:]+/)
      .filter(Boolean)
    const unique = new Set(words)
    if (words.length > 0) {
      const ratio = unique.size / words.length
      score += Math.round(ratio * 20)
    }

    // 重复内容惩罚
    const lines = text.split('\n').filter((l) => l.trim().length > 0)
    const uniqueLines = new Set(lines.map((l) => l.trim()))
    if (lines.length > 3 && uniqueLines.size / lines.length < 0.5) {
      score -= 15
    }

    return Math.max(0, Math.min(100, score))
  }

  /**
   * 测量结构复杂度 0-100
   */
  private measureStructuralComplexity(text: string): number {
    if (!text || text.length === 0) return 0

    let complexity = 0

    // 层级结构
    const headings = (text.match(/^#{1,6}\s/gm) ?? []).length
    complexity += Math.min(20, headings * 4)

    // 列表/枚举
    const listItems = (text.match(/^[\s]*[-*•]\s/gm) ?? []).length
    complexity += Math.min(15, listItems * 2)

    // 代码/技术标记
    if (/```/.test(text)) complexity += 15
    if (/\b(?:function|class|interface|type|const|let|var|import|export)\b/.test(text)) {
      complexity += 10
    }

    // 嵌套深度（括号层级）
    let maxDepth = 0
    let depth = 0
    for (const ch of text) {
      if (ch === '(' || ch === '[' || ch === '{' || ch === '（' || ch === '【') {
        depth++
        maxDepth = Math.max(maxDepth, depth)
      } else if (ch === ')' || ch === ']' || ch === '}' || ch === '）' || ch === '】') {
        depth = Math.max(0, depth - 1)
      }
    }
    complexity += Math.min(15, maxDepth * 3)

    // 句子长度变化（表达复杂度）
    const sentences = text.split(/[。！？.!?\n]+/).filter((s) => s.trim().length > 0)
    if (sentences.length >= 2) {
      const lengths = sentences.map((s) => s.trim().length)
      const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length
      const variance = lengths.reduce((sum, l) => sum + (l - avg) ** 2, 0) / lengths.length
      complexity += Math.min(15, Math.round(Math.sqrt(variance) / 10))
    }

    return Math.max(0, Math.min(100, complexity))
  }

  /**
   * 计算语义密度（有效信息占比）0-1
   */
  private computeSemanticDensity(text: string): number {
    if (!text || text.length === 0) return 0

    const words = text.split(/[\s]+/).filter(Boolean)
    if (words.length === 0) return 0

    // 停用词比例
    const stopPatterns =
      /^(?:的|了|在|是|我|有|和|就|不|人|都|一|上|也|很|到|说|要|去|你|会|着|没有|看|好|自己|这|他|她|它|们|那|the|is|are|was|were|be|a|an|in|on|at|to|for|of|and|or|but|with|from|by|this|that|it|as|if|so|do|no|not|has|have|had)$/

    const meaningful = words.filter((w) => !stopPatterns.test(w.toLowerCase()))
    const density = meaningful.length / words.length

    // 句子越长且有意义词越多，密度越高
    const sentences = text.split(/[。！？.!?\n]+/).filter((s) => s.trim().length > 10)
    const longSentenceRatio = sentences.filter((s) => s.trim().length > 30).length / Math.max(1, sentences.length)

    return Math.round((density * 0.7 + longSentenceRatio * 0.3) * 100) / 100
  }

  // ── 深度分类（语义版） ──────────────────────────────────────

  /**
   * 基于语义分析的深度分类（替代简单长度判断）
   */
  private classifyDepth(text: string): 'shallow' | 'medium' | 'full' {
    if (!text || text.length === 0) return 'shallow'

    // 短内容直接归为 shallow（避免高密度短文本误判）
    if (text.length < 50) return 'shallow'

    const quality = this.estimateQuality(text)
    const complexity = this.measureStructuralComplexity(text)
    const density = this.computeSemanticDensity(text)

    // 综合评分
    const composite = quality * 0.4 + complexity * 0.3 + density * 100 * 0.3

    if (composite >= 55) return 'full'
    if (composite >= 30) return 'medium'
    return 'shallow'
  }
}

