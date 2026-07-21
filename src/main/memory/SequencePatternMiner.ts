/**
 * SequencePatternMiner — 序列模式挖掘模块
 *
 * ## 职责
 * 从多个数据源中挖掘用户操作序列模式，提供统一的语义匹配和置信度排序：
 * 1. InteractionTracker 话题序列 → 话题转移模式
 * 2. ProceduralMemory 显式保存的流程 → 显式模式
 * 3. TaskTemplateRegistry 自动挖掘的模板 → 自动模板模式
 *
 * ## 评分公式
 * combinedScore = 0.35 * similarity + 0.25 * frequency + 0.25 * successRate + 0.15 * recencyBoost
 *
 * ## 集成点
 * - MemoryService 构造时创建，注册为子服务
 * - AdaptiveOrchestrator 调用 matchPatterns() 获取匹配
 * - 定时分析：每次 recordInteraction() 后轻量触发
 */

import { log } from '../logger/Logger'
import { fallbackEmbed, cosineSimilarity } from './embedding'
import type { InteractionRecord } from './types'
import type { Procedure } from '../agent/ProceduralMemory'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 模式来源 */
export type PatternSource = 'mined_topic_sequence' | 'procedure' | 'task_template'

/** 挖掘出的序列模式 */
export interface SequencePattern {
  /** 唯一 ID */
  id: string
  /** 模式名称 */
  name: string
  /** 模式描述（何时适用） */
  description: string
  /** 建议步骤列表 */
  steps: string[]
  /** 触发关键词 */
  triggerKeywords: string[]
  /** 来源 */
  source: PatternSource
  /** 综合置信度 0-1 */
  confidence: number
  /** 出现/使用频率 */
  frequency: number
  /** 成功率 0-1 */
  successRate: number
  /** 上次使用时间戳 */
  lastUsedAt: number
  /** 成功次数 */
  successCount: number
  /** 失败次数 */
  failCount: number
  /** 嵌入向量（用于语义匹配） */
  embedding?: number[]
  /** 原始数据引用（用于溯源） */
  refId?: string
}

/** 模式匹配结果 */
export interface PatternMatch {
  pattern: SequencePattern
  /** 综合得分 0-1 */
  score: number
  /** 语义相似度 0-1 */
  similarity: number
  /** 匹配原因说明 */
  reason: string
}

/** 挖掘选项 */
export interface MiningOptions {
  /** 最小置信度阈值 */
  minConfidence?: number
  /** 语义相似度阈值 */
  minSimilarity?: number
  /** 返回 topK 条结果 */
  topK?: number
}

// ══════════════════════════════════════════
//  配置常量
// ══════════════════════════════════════════

const DEFAULT_MIN_CONFIDENCE = 0.15
const DEFAULT_MIN_SIMILARITY = 0.12
const DEFAULT_TOP_K = 5
const MIN_TOPIC_SEQUENCE_LENGTH = 2
const MAX_INTERACTIONS_FOR_MINING = 32
const RECENCY_HALF_LIFE_DAYS = 14
const FREQUENCY_BOOST_CAP = 50

// 评分权重
const WEIGHT_SIMILARITY = 0.35
const WEIGHT_FREQUENCY = 0.25
const WEIGHT_SUCCESS_RATE = 0.25
const WEIGHT_RECENCY = 0.15

// ══════════════════════════════════════════
//  SequencePatternMiner
// ══════════════════════════════════════════

export class SequencePatternMiner {
  /** 运行时缓存：所有已挖掘的模式 */
  private patterns: SequencePattern[] = []
  /** 是否已初始化 */
  private initialized = false
  /** 外部依赖：交互记录获取 */
  private getInteractions: () => InteractionRecord[]
  /** 外部依赖：流程记忆获取 */
  private getProcedures: () => Procedure[]
  /** 外部依赖：模板匹配函数 */
  private matchTemplates: ((query: string, topK: number) => Array<{ name: string; description: string; steps: string[]; score: number }>) | null = null

  constructor(deps: {
    getInteractions: () => InteractionRecord[]
    getProcedures?: () => Procedure[]
    matchTemplates?: (query: string, topK: number) => Array<{ name: string; description: string; steps: string[]; score: number }>
  }) {
    this.getInteractions = deps.getInteractions
    this.getProcedures = deps.getProcedures ?? (() => [])
    this.matchTemplates = deps.matchTemplates ?? null
  }

  /**
   * 设置外部依赖（ProceduralMemory），在初始化后注入。
   * 用于 AppRuntime 启动完成后注入实际数据源。
   */
  setProcedureProvider(provider: () => Procedure[]): void {
    this.getProcedures = provider
  }

  /**
   * 设置模板匹配函数（TaskTemplateRegistry），在初始化后注入。
   */
  setTemplateMatcher(matcher: (query: string, topK: number) => Array<{ name: string; description: string; steps: string[]; score: number }>): void {
    this.matchTemplates = matcher
  }

  // ══════════════════════════════════════════
  //  挖掘入口
  // ══════════════════════════════════════════

  /**
   * 执行一次完整的模式挖掘。
   * 从所有数据源提取模式并缓存。
   * 通常在系统初始化或定时触发时调用。
   */
  mine(): void {
    const t0 = Date.now()
    const mined: SequencePattern[] = []

    // 1. 从 InteractionTracker 挖掘话题序列模式
    mined.push(...this.mineTopicSequences())

    // 2. 从 ProceduralMemory 导入显式流程
    mined.push(...this.importProcedures())

    // 3. 从 TaskTemplateRegistry 导入模板
    mined.push(...this.importTemplates())

    // 去重：同名的保留综合置信度更高的
    const deduped = this.deduplicate(mined)

    this.patterns = deduped
    this.initialized = true

    log('INFO', 'sequence_pattern_miner.mined', {
      total: deduped.length,
      topicSequences: mined.filter((p) => p.source === 'mined_topic_sequence').length,
      procedures: mined.filter((p) => p.source === 'procedure').length,
      templates: mined.filter((p) => p.source === 'task_template').length,
      durationMs: Date.now() - t0,
    })
  }

  /** 确保已初始化，如未初始化则执行挖掘 */
  ensureMined(): void {
    if (!this.initialized) {
      this.mine()
    }
  }

  // ══════════════════════════════════════════
  //  模式匹配
  // ══════════════════════════════════════════

  /**
   * 基于语义匹配检索历史模式。
   * 对用户输入文本进行向量嵌入，与所有模式计算余弦相似度，
   * 按综合置信度排序返回 topK 条建议。
   */
  matchPatterns(query: string, options: MiningOptions = {}): PatternMatch[] {
    this.ensureMined()

    if (!query || query.length < 2) return []
    if (this.patterns.length === 0) return []

    const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE
    const minSimilarity = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY
    const topK = options.topK ?? DEFAULT_TOP_K

    const queryEmb = fallbackEmbed(query)
    const now = Date.now()

    // 对每个模式计算综合得分
    const scored = this.patterns
      .map((p) => {
        // 1) 语义相似度
        const similarity = p.embedding && p.embedding.length > 0
          ? cosineSimilarity(queryEmb, p.embedding)
          : this.textSimilarity(query, p)

        // 2) 触发词匹配 boost
        const keywordBoost = this.computeKeywordBoost(query, p.triggerKeywords)

        // 3) 频率因子
        const frequencyFactor = Math.min(1.0, p.frequency / FREQUENCY_BOOST_CAP)

        // 4) 成功率因子
        const successRate = p.successRate

        // 5) 新鲜度因子（基于 recency）
        const daysSinceUse = p.lastUsedAt > 0
          ? (now - p.lastUsedAt) / (1000 * 60 * 60 * 24)
          : 365
        const recencyBoost = Math.exp(-daysSinceUse / RECENCY_HALF_LIFE_DAYS)

        // 综合得分
        const effectiveSimilarity = Math.min(1.0, similarity + keywordBoost * 0.15)
        const score =
          WEIGHT_SIMILARITY * effectiveSimilarity +
          WEIGHT_FREQUENCY * frequencyFactor +
          WEIGHT_SUCCESS_RATE * successRate +
          WEIGHT_RECENCY * recencyBoost

        return { pattern: p, score, similarity, recencyBoost }
      })
      // 过滤：置信度 + 相似度双阈值
      .filter(
        (s) => s.pattern.confidence >= minConfidence && s.similarity >= minSimilarity,
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)

    return scored.map((s) => ({
      pattern: s.pattern,
      score: Number(s.score.toFixed(4)),
      similarity: Number(s.similarity.toFixed(4)),
      reason: this.buildReason(s),
    }))
  }

  /**
   * 获取所有模式（用于管理、展示）
   */
  getAllPatterns(): SequencePattern[] {
    this.ensureMined()
    return [...this.patterns]
  }

  /** 获取已挖掘的模式数量 */
  getPatternCount(): number {
    return this.patterns.length
  }

  /**
   * 按 ID 获取模式
   */
  getPattern(id: string): SequencePattern | undefined {
    this.ensureMined()
    return this.patterns.find((p) => p.id === id)
  }

  /**
   * 更新模式的成功/失败计数
   */
  recordFeedback(id: string, success: boolean): void {
    const pattern = this.patterns.find((p) => p.id === id)
    if (!pattern) return

    if (success) {
      pattern.successCount++
    } else {
      pattern.failCount++
    }

    const total = pattern.successCount + pattern.failCount
    pattern.successRate = total > 0 ? pattern.successCount / total : 0
    pattern.frequency = total
    pattern.lastUsedAt = Date.now()

    // 更新置信度（随成功次数增加而提升）
    pattern.confidence = Math.min(0.98, pattern.confidence + (success ? 0.05 : -0.03))
    pattern.confidence = Math.max(0.05, pattern.confidence)

    // 重新计算嵌入（确保后续匹配准确）
    pattern.embedding = this.computePatternEmbedding(pattern)

    log('INFO', 'sequence_pattern.feedback', {
      id,
      success,
      newConfidence: pattern.confidence.toFixed(3),
      totalUses: total,
    })
  }

  // ══════════════════════════════════════════
  //  数据源挖掘
  // ══════════════════════════════════════════

  /** 从 InteractionTracker 挖掘话题序列模式 */
  private mineTopicSequences(): SequencePattern[] {
    const interactions = this.getInteractions()
    if (interactions.length < MIN_TOPIC_SEQUENCE_LENGTH) return []

    const patterns: SequencePattern[] = []
    const seen = new Set<string>()

    // 分析连续交互中的话题转移序列
    for (let i = 0; i < interactions.length - 1; i++) {
      const a = interactions[i]
      const b = interactions[i + 1]
      if (!a.topics || a.topics.length === 0) continue
      if (!b.topics || b.topics.length === 0) continue

      // 找到共同话题（保留话题）
      const common = a.topics.filter((t) => b.topics.includes(t))
      // 找到转移话题（a → b 新增的话题）
      const transitions = b.topics.filter((t) => !a.topics.includes(t))

      if (common.length === 0 && transitions.length === 0) continue

      // 生成模式名称
      const key = `topic:${common.join('+')}>${transitions.join('+')}`
      if (seen.has(key)) continue
      seen.add(key)

      const combinedTopics = [...new Set([...common, ...transitions])]
      if (combinedTopics.length === 0) continue

      const name = combinedTopics.slice(0, 3).join('、') + ' 相关操作'
      const triggerKeywords = [...new Set([...common, ...transitions])]

      patterns.push(this.createPattern({
        name,
        description: `用户在处理「${common.join('、')}」相关话题后，可能需要进行「${transitions.join('、')}」相关操作`,
        steps: [`分析当前 ${common.join('、')} 相关上下文`, `执行 ${transitions.join('、')} 相关操作`],
        triggerKeywords,
        source: 'mined_topic_sequence',
        confidence: 0.3, // 话题序列模式初始置信度较低
        frequency: 1,
        successRate: 0.5,
        lastUsedAt: interactions[i + 1].timestamp,
      }))
    }

    // 合并相同关键词的模式（提升置信度）
    return this.mergeSimilarPatterns(patterns)
  }

  /** 从 ProceduralMemory 导入显式流程 */
  private importProcedures(): SequencePattern[] {
    try {
      const procedures = this.getProcedures()
      if (!procedures || procedures.length === 0) return []

      return procedures.map((p) => {
        const total = p.successCount + p.failCount
        const successRate = total > 0 ? p.successCount / total : 0.5
        const embedding = p.embedding && p.embedding.length > 0 ? p.embedding : this.computePatternEmbedding({
          name: p.name,
          description: p.description,
          steps: p.steps,
          triggerKeywords: p.triggerKeywords,
        } as SequencePattern)

        return this.createPattern({
          id: `proc_${p.id}`,
          name: p.name,
          description: p.description,
          steps: p.steps,
          triggerKeywords: p.triggerKeywords,
          source: 'procedure',
          confidence: Math.max(0.5, successRate), // 显式流程置信度较高
          frequency: total,
          successRate,
          lastUsedAt: p.updatedAt,
          successCount: p.successCount,
          failCount: p.failCount,
          embedding,
          refId: p.id,
        })
      })
    } catch {
      return []
    }
  }

  /** 从 TaskTemplateRegistry 导入自动挖掘的模板 */
  private importTemplates(): SequencePattern[] {
    if (!this.matchTemplates) return []

    try {
      // 使用空匹配获取所有活跃模板（通过通用匹配）
      const templates = this.matchTemplates('', 20)
      if (!templates || templates.length === 0) return []

      return templates.map((t, idx) => {
        const embedding = this.computePatternEmbedding({
          name: t.name,
          description: t.description,
          steps: t.steps,
          triggerKeywords: [],
        } as SequencePattern)

        return this.createPattern({
          id: `tpl_${idx}_${Date.now()}`,
          name: t.name,
          description: t.description,
          steps: t.steps,
          triggerKeywords: t.description ? [t.description.slice(0, 20)] : [],
          source: 'task_template',
          confidence: t.score,
          frequency: Math.max(1, Math.round(t.score * 10)),
          successRate: t.score,
          lastUsedAt: Date.now(),
          embedding,
        })
      })
    } catch {
      return []
    }
  }

  // ══════════════════════════════════════════
  //  工具方法
  // ══════════════════════════════════════════

  /** 创建模式对象 */
  private createPattern(data: {
    id?: string
    name: string
    description: string
    steps: string[]
    triggerKeywords: string[]
    source: PatternSource
    confidence: number
    frequency: number
    successRate: number
    lastUsedAt: number
    successCount?: number
    failCount?: number
    embedding?: number[]
    refId?: string
  }): SequencePattern {
    const pattern: SequencePattern = {
      id: data.id ?? `sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: data.name,
      description: data.description,
      steps: data.steps,
      triggerKeywords: data.triggerKeywords,
      source: data.source,
      confidence: data.confidence,
      frequency: data.frequency,
      successRate: data.successRate,
      lastUsedAt: data.lastUsedAt,
      successCount: data.successCount ?? 0,
      failCount: data.failCount ?? 0,
      embedding: data.embedding,
      refId: data.refId,
    }
    if (!pattern.embedding) {
      pattern.embedding = this.computePatternEmbedding(pattern)
    }
    return pattern
  }

  /** 计算模式的嵌入向量 */
  private computePatternEmbedding(pattern: { name: string; description: string; steps: string[]; triggerKeywords: string[] }): number[] {
    const text = [
      pattern.name,
      pattern.description,
      ...pattern.steps,
      ...pattern.triggerKeywords,
    ].join(' ')
    return fallbackEmbed(text)
  }

  /** 基于文本关键词的简单相似度（当无嵌入时使用） */
  private textSimilarity(query: string, pattern: SequencePattern): number {
    const q = query.toLowerCase()
    let matches = 0
    const checks = [
      pattern.name.toLowerCase(),
      pattern.description.toLowerCase(),
      ...pattern.triggerKeywords.map((t) => t.toLowerCase()),
      ...pattern.steps.map((s) => s.toLowerCase()),
    ]
    for (const text of checks) {
      if (q.length >= 3 && text.includes(q)) matches += 2
      else {
        const qWords = q.split(/\s+/)
        for (const word of qWords) {
          if (word.length >= 2 && text.includes(word)) matches += 1
        }
      }
    }
    const maxPossible = checks.length * 2 + 1
    return Math.min(1.0, matches / maxPossible)
  }

  /** 计算触发词匹配提升 */
  private computeKeywordBoost(query: string, keywords: string[]): number {
    if (!keywords || keywords.length === 0) return 0
    const q = query.toLowerCase()
    let matchCount = 0
    for (const kw of keywords) {
      if (q.includes(kw.toLowerCase())) matchCount++
    }
    return keywords.length > 0 ? matchCount / keywords.length : 0
  }

  /** 合并相似模式（相同关键词 → 提升置信度） */
  private mergeSimilarPatterns(patterns: SequencePattern[]): SequencePattern[] {
    if (patterns.length <= 1) return patterns

    const merged: SequencePattern[] = []
    const used = new Set<string>()

    for (let i = 0; i < patterns.length; i++) {
      if (used.has(patterns[i].id)) continue

      let base = patterns[i]
      const similar: SequencePattern[] = [base]

      for (let j = i + 1; j < patterns.length; j++) {
        if (used.has(patterns[j].id)) continue
        const overlap = base.triggerKeywords.filter((t) =>
          patterns[j].triggerKeywords.includes(t),
        ).length
        if (overlap > 0) {
          similar.push(patterns[j])
          used.add(patterns[j].id)
        }
      }

      if (similar.length > 1) {
        // 合并：取最优步骤集，累加频率，提升置信度
        const avgConfidence = similar.reduce((s, p) => s + p.confidence, 0) / similar.length
        const totalFrequency = similar.reduce((s, p) => s + p.frequency, 0)
        const bestLastUsed = Math.max(...similar.map((p) => p.lastUsedAt))
        const allKeywords = [...new Set(similar.flatMap((p) => p.triggerKeywords))]

        base = this.createPattern({
          name: base.name,
          description: base.description,
          steps: base.steps,
          triggerKeywords: allKeywords,
          source: 'mined_topic_sequence',
          confidence: Math.min(0.7, avgConfidence + 0.1 * (similar.length - 1)),
          frequency: totalFrequency,
          successRate: 0.55,
          lastUsedAt: bestLastUsed,
        })
      }

      merged.push(base)
      used.add(patterns[i].id)
    }

    return merged
  }

  /** 去重：同名模式保留置信度更高的 */
  private deduplicate(patterns: SequencePattern[]): SequencePattern[] {
    const map = new Map<string, SequencePattern>()
    for (const p of patterns) {
      const key = p.name
      const existing = map.get(key)
      if (!existing || p.confidence > existing.confidence) {
        map.set(key, p)
      }
    }
    return Array.from(map.values())
  }

  /** 生成匹配原因说明 */
  private buildReason(s: { pattern: SequencePattern; score: number; similarity: number; recencyBoost: number }): string {
    const parts: string[] = []
    if (s.similarity > 0.5) parts.push('语义高度匹配')
    else if (s.similarity > 0.3) parts.push('语义部分匹配')
    else parts.push('触发词匹配')
    if (s.pattern.frequency > 5) parts.push(`已使用${s.pattern.successCount + s.pattern.failCount}次`)
    if (s.recencyBoost > 0.5) parts.push('近期使用过')
    return parts.join('，')
  }
}
