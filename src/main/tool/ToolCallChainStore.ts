/**
 * ToolCallChainStore — 工具调用链存储器
 *
 * ## 职责
 * 1. 跟踪当前任务上下文：用户意图 + 工具调用序列
 * 2. 每次工具调用时将调用上下文（用户需求、工具选择、结果）存入 Memory
 * 3. 在新任务启动时查询 Memory，基于相似历史推荐工具组合或参数预设
 * 4. 持久化完整链数据到 JSON 文件（跨会话保留）
 *
 * ## 生命周期
 *   setCurrentIntent(intent, category)
 *     → (多次) recordLink(toolName, args, result, success, durationMs)
 *     → finishChain(summary) / abandonChain()
 *
 * ## 数据流
 *   ChatExecutor.setCurrentIntent() → ToolCallChainStore
 *   ServerManager.callTool() → recordLink() → MemoryService.addEntry() (异步)
 *   ChatExecutor (chain completion) → finishChain() → 持久化
 *
 * ## 与 MemoryAwareInterceptor 的区别
 * - MemoryAwareInterceptor 记录单次工具调用摘要（无意图关联）
 * - ToolCallChainStore 记录完整工具调用链 + 用户意图关联（供跨任务推荐）
 */

import { log } from '../logger/Logger'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { getMemoryService } from './deps'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 单次工具调用在链中的记录 */
export interface ToolChainLink {
  toolName: string
  args: Record<string, any>
  result: string
  success: boolean
  durationMs: number
  timestamp: number
}

/** 已完成的工具调用链 */
export interface CompletedChain {
  /** 唯一标识 */
  id: string
  /** 用户原始需求文本 */
  userIntent: string
  /** 意图分类（从 classifyContent 获取） */
  category: string
  /** 工具调用列表 */
  toolCalls: ToolChainLink[]
  /** 工具序列（有序去重，如 ["grep", "read_file", "write_file"]） */
  toolSequence: string[]
  /** 常用参数预设（工具名 → 参数字典） */
  paramPresets: Record<string, Record<string, string>>
  /** 开始时间戳 */
  startedAt: number
  /** 完成时间戳 */
  completedAt: number
  /** 整体是否成功 */
  success: boolean
  /** 结果摘要 */
  summary: string
}

/** 工具调用链推荐结果 */
export interface ToolChainRecommendation {
  /** 匹配的源链 ID */
  sourceChainId: string
  /** 匹配的源意图 */
  sourceIntent: string
  /** 相似度评分 (0-1) */
  similarity: number
  /** 推荐的工具序列 */
  recommendedTools: string[]
  /** 推荐的参数预设 */
  paramPresets: Record<string, Record<string, string>>
  /** 该历史链是否成功 */
  wasSuccessful: boolean
  /** 匹配原因描述 */
  matchReason: string
}

/** 活跃链的状态摘要 */
export interface ActiveChainInfo {
  intent: string
  category: string
  linkCount: number
  elapsedMs: number
  toolSequence: string[]
}

// ══════════════════════════════════════════
//  配置常量
// ══════════════════════════════════════════

const DEFAULT_CONFIG = {
  /** 最大保留链数 */
  MAX_CHAINS: 500,
  /** 链数据文件路径（相对于 project root） */
  CHAIN_FILE: '.claude/tool_call_chains.json',
  /** 内存搜索最大结果数 */
  DEFAULT_SEARCH_LIMIT: 5,
  /** 推荐的最小相似度阈值 */
  MIN_SIMILARITY_THRESHOLD: 0.15,
  /** 工具序列最大长度（推荐时截断） */
  MAX_RECOMMENDED_TOOLS: 6,
  /** 存储到 Memory 时的置信度 */
  MEMORY_CONFIDENCE: 0.55,
}

// ══════════════════════════════════════════
//  ToolCallChainStore 实现
// ══════════════════════════════════════════

export class ToolCallChainStore {
  private config: typeof DEFAULT_CONFIG

  // 当前活跃链
  private _currentIntent = ''
  private _currentCategory = ''
  private _currentLinks: ToolChainLink[] = []
  private _chainStartTime = 0

  // 已完成的链（内存 + 持久化）
  private completedChains: CompletedChain[] = []

  // 持久化路径
  private persistPath: string
  private _loaded = false

  constructor(config?: Partial<typeof DEFAULT_CONFIG>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.persistPath = join(process.cwd(), this.config.CHAIN_FILE)
  }

  // ══════════════════════════════════════════
  //  公共属性
  // ══════════════════════════════════════════

  /** 当前用户意图 */
  get currentIntent(): string {
    return this._currentIntent
  }

  /** 当前意图分类 */
  get currentCategory(): string {
    return this._currentCategory
  }

  /** 是否正在追踪活跃链 */
  get hasActiveChain(): boolean {
    return this._currentIntent.length > 0 && this._chainStartTime > 0
  }

  /** 当前链的工具调用次数 */
  get currentLinkCount(): number {
    return this._currentLinks.length
  }

  // ══════════════════════════════════════════
  //  持久化
  // ══════════════════════════════════════════

  private ensureLoaded(): void {
    if (this._loaded) return
    try {
      if (existsSync(this.persistPath)) {
        const raw = readFileSync(this.persistPath, 'utf-8')
        const data = JSON.parse(raw)
        if (Array.isArray(data)) {
          this.completedChains = data
          log('INFO', 'tool_chain_store_loaded', {
            count: this.completedChains.length,
            path: this.config.CHAIN_FILE,
          })
        }
      }
    } catch (err: any) {
      log('WARN', 'tool_chain_store_load_failed', { error: err.message })
      this.completedChains = []
    }
    this._loaded = true
  }

  private persist(): void {
    try {
      const dir = join(process.cwd(), '.claude')
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(this.persistPath, JSON.stringify(this.completedChains), 'utf-8')
    } catch (err: any) {
      log('WARN', 'tool_chain_store_persist_failed', { error: err.message })
    }
  }

  // ══════════════════════════════════════════
  //  活跃链管理
  // ══════════════════════════════════════════

  /**
   * 设置当前用户意图，开始追踪新的工具调用链。
   * 如果已有活跃链且意图不同，自动完成旧链。
   *
   * @param intent 用户需求的原始文本
   * @param category 意图分类（可选，来自 classifyContent）
   */
  setCurrentIntent(intent: string, category?: string): void {
    // 如果已有活跃链且意图不同，先完成旧链
    if (this.hasActiveChain && this._currentIntent !== intent) {
      this.finishChain('(自动完成：新意图开始)')
    }

    this._currentIntent = intent
    this._currentCategory = category || 'general'
    this._currentLinks = []
    this._chainStartTime = Date.now()

    log('INFO', 'tool_chain_intent_set', {
      intent: intent.slice(0, 80),
      category: this._currentCategory,
    })
  }

  /**
   * 记录一次工具调用到当前链。
   * 同时将调用上下文（用户需求、工具选择、结果）写入 Memory。
   *
   * @param toolName 工具名
   * @param args 工具参数
   * @param result 调用结果文本
   * @param success 是否成功
   * @param durationMs 调用耗时
   */
  recordLink(
    toolName: string,
    args: Record<string, any>,
    result: string,
    success: boolean,
    durationMs: number,
  ): void {
    // 如果没有活跃链，不记录（静默跳过）
    if (!this.hasActiveChain) return

    const link: ToolChainLink = {
      toolName,
      args: { ...args },
      result: result.slice(0, 500),
      success,
      durationMs,
      timestamp: Date.now(),
    }

    this._currentLinks.push(link)

    log('INFO', 'tool_chain_link_recorded', {
      tool: toolName,
      chainLength: this._currentLinks.length,
      success,
      durationMs,
    })

    // ★ 将调用上下文写入 Memory（供跨任务语义搜索）
    this.storeLinkToMemory(toolName, args, result, success)
  }

  /**
   * 完成当前工具调用链。
   * 将完整链数据持久化，并写入 Memory 摘要。
   *
   * @param summary 任务结果摘要
   */
  finishChain(summary: string): void {
    if (!this.hasActiveChain) return

    const now = Date.now()
    const toolSequence = this.buildToolSequence()
    const paramPresets = this.buildParamPresets()

    const chain: CompletedChain = {
      id: this.generateChainId(),
      userIntent: this._currentIntent,
      category: this._currentCategory,
      toolCalls: [...this._currentLinks],
      toolSequence,
      paramPresets,
      startedAt: this._chainStartTime,
      completedAt: now,
      success: this._currentLinks.every((l) => l.success) || this._currentLinks.length === 0,
      summary: summary.slice(0, 300),
    }

    this.ensureLoaded()
    this.completedChains.push(chain)

    // 超出上限时轮转最旧链
    if (this.completedChains.length > this.config.MAX_CHAINS) {
      const excess = this.completedChains.length - this.config.MAX_CHAINS
      this.completedChains.splice(0, excess)
    }

    this.persist()

    // ★ 存储链摘要到 Memory（语义可搜索）
    this.storeChainToMemory(chain)

    log('INFO', 'tool_chain_completed', {
      chainId: chain.id,
      intent: this._currentIntent.slice(0, 60),
      toolCount: this._currentLinks.length,
      toolSequence: toolSequence.join(' → '),
      success: chain.success,
    })

    this.resetActiveChain()
  }

  /**
   * 放弃当前链（不存储）。
   * 通常在发生未恢复的错误时调用。
   */
  abandonChain(): void {
    if (!this.hasActiveChain) return

    log('INFO', 'tool_chain_abandoned', {
      intent: this._currentIntent.slice(0, 60),
      linkCount: this._currentLinks.length,
    })

    this.resetActiveChain()
  }

  /**
   * 获取当前活跃链的信息摘要。
   */
  getActiveChainInfo(): ActiveChainInfo | null {
    if (!this.hasActiveChain) return null

    return {
      intent: this._currentIntent,
      category: this._currentCategory,
      linkCount: this._currentLinks.length,
      elapsedMs: Date.now() - this._chainStartTime,
      toolSequence: this.buildToolSequence(),
    }
  }

  // ══════════════════════════════════════════
  //  搜索与推荐
  // ══════════════════════════════════════════

  /**
   * 搜索与给定意图相似的历史工具调用链。
   * 使用关键词匹配计算相似度（轻量、无需 embedding 服务）。
   *
   * @param query 用户意图文本
   * @param limit 最大返回数
   * @returns 按相似度降序排列的链列表
   */
  searchSimilar(query: string, limit?: number): CompletedChain[] {
    this.ensureLoaded()
    const maxResults = limit || this.config.DEFAULT_SEARCH_LIMIT

    if (this.completedChains.length === 0 || !query) return []

    const queryLower = query.toLowerCase()
    const queryTokens = this.tokenize(queryLower)

    // 如果没有有效查询词，返回最近链
    if (queryTokens.length === 0) {
      return [...this.completedChains]
        .sort((a, b) => b.completedAt - a.completedAt)
        .slice(0, maxResults)
    }

    // 为每个链计算相似度
    const scored = this.completedChains
      .map((chain) => {
        const score = this.computeSimilarity(queryLower, queryTokens, chain)
        return { chain, score }
      })
      .filter((s) => s.score > this.config.MIN_SIMILARITY_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)

    return scored.map((s) => s.chain)
  }

  /**
   * 获取工具组合推荐。
   * 基于与给定意图最相似的历史链，推荐工具序列和参数预设。
   *
   * @param intent 当前用户意图
   * @returns 推荐列表（按相似度降序）
   */
  getRecommendations(intent: string): ToolChainRecommendation[] {
    const similar = this.searchSimilar(intent)
    if (similar.length === 0) return []

    const queryTokens = this.tokenize(intent.toLowerCase())
    const recommendations: ToolChainRecommendation[] = []

    for (const chain of similar) {
      const score = this.computeSimilarity(
        intent.toLowerCase(),
        queryTokens,
        chain,
      )

      // 提取匹配关键词作为原因
      const matchReason = this.buildMatchReason(intent, chain)

      recommendations.push({
        sourceChainId: chain.id,
        sourceIntent: chain.userIntent,
        similarity: score,
        recommendedTools: chain.toolSequence.slice(
          0,
          this.config.MAX_RECOMMENDED_TOOLS,
        ),
        paramPresets: chain.paramPresets,
        wasSuccessful: chain.success,
        matchReason,
      })
    }

    return recommendations
  }

  /**
   * 获取格式化的推荐文本，适合注入系统 prompt 或对话上下文。
   *
   * @param intent 当前用户意图
   * @returns 格式化推荐文本（空字符串表示无推荐）
   */
  getFormattedRecommendations(intent: string): string {
    const recommendations = this.getRecommendations(intent)
    if (recommendations.length === 0) return ''

    const parts: string[] = ['【历史工具模式参考】']
    parts.push('根据类似的历史任务，以下是常用的工具组合：')
    parts.push('')

    for (let i = 0; i < Math.min(recommendations.length, 3); i++) {
      const rec = recommendations[i]
      const tools = rec.recommendedTools.join(' → ')
      const status = rec.wasSuccessful ? '✓ 成功' : '✗ 失败'
      const reason = rec.matchReason
      const intentPreview = rec.sourceIntent.slice(0, 60)

      parts.push(`  ${i + 1}. 相似任务「${intentPreview}」(${status})`)
      parts.push(`     工具路径: ${tools}`)
      if (reason) parts.push(`     匹配: ${reason}`)

      // 如果有参数预设，推荐
      const presetCount = Object.keys(rec.paramPresets).length
      if (presetCount > 0) {
        const presetExamples: string[] = []
        for (const [toolName, params] of Object.entries(rec.paramPresets)) {
          const paramStr = Object.entries(params)
            .map(([k, v]) => `${k}="${v}"`)
            .join(', ')
          if (paramStr) {
            presetExamples.push(`${toolName}(${paramStr})`)
          }
        }
        if (presetExamples.length > 0) {
          parts.push(`     参考参数: ${presetExamples.join('; ')}`)
        }
      }
      parts.push('')
    }

    parts.push('（以上是基于历史相似任务的自动推荐，仅供参考）')

    return parts.join('\n')
  }

  // ══════════════════════════════════════════
  //  统计与维护
  // ══════════════════════════════════════════

  /** 获取高频工具列表 */
  getFrequentTools(limit = 10): Array<{ toolName: string; count: number }> {
    this.ensureLoaded()
    const toolCounts = new Map<string, number>()

    for (const chain of this.completedChains) {
      for (const tool of chain.toolSequence) {
        toolCounts.set(tool, (toolCounts.get(tool) || 0) + 1)
      }
    }

    return Array.from(toolCounts.entries())
      .map(([toolName, count]) => ({ toolName, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
  }

  /** 获取已完成的链数量 */
  get completedCount(): number {
    this.ensureLoaded()
    return this.completedChains.length
  }

  /** 清除所有链数据（用于测试或重置） */
  clear(): void {
    this.completedChains = []
    this.resetActiveChain()
    this.persist()
    log('INFO', 'tool_chain_store_cleared')
  }

  // ══════════════════════════════════════════
  //  内部：Memory 存储
  // ══════════════════════════════════════════

  /**
   * 将单次工具调用写入 Memory（供语义搜索）。
   * 格式: [tool_chain] 用户需求: {intent} → 工具: {toolName}({args}) → {success/fail}: {result}
   */
  private storeLinkToMemory(
    toolName: string,
    args: Record<string, any>,
    result: string,
    success: boolean,
  ): void {
    try {
      const ms = getMemoryService()
      if (!ms) return

      const status = success ? '成功' : '失败'
      const argSummary = Object.entries(args)
        .filter(([, v]) => typeof v === 'string' && v.length > 0)
        .map(([k, v]) => `${k}=${(v as string).slice(0, 40)}`)
        .join(', ')

      const content = `[tool_chain] 需求: ${this._currentIntent.slice(0, 100)} → 工具: ${toolName}(${argSummary}) → ${status}: ${result.slice(0, 80)}`

      const structuredData = JSON.stringify({
        source: 'tool_chain',
        intent: this._currentIntent.slice(0, 200),
        category: this._currentCategory,
        toolName,
        args: this.sanitizeArgs(args),
        success,
        linkIndex: this._currentLinks.length,
        timestamp: Date.now(),
      })

      ms.addEntry(
        'interaction',
        content,
        success ? this.config.MEMORY_CONFIDENCE : this.config.MEMORY_CONFIDENCE * 0.6,
        {
          tier: 'ephemeral',
          structuredData,
        },
      )

      // 每 5 条持久化一次
      if (this._currentLinks.length % 5 === 0) {
        ms.flush()
      }
    } catch (err: any) {
      log('WARN', 'tool_chain_memory_store_failed', { tool: toolName, error: err.message })
    }
  }

  /**
   * 将完整的链摘要写入 Memory。
   * 用于语义搜索：「与某意图相似的链」。
   */
  private storeChainToMemory(chain: CompletedChain): void {
    try {
      const ms = getMemoryService()
      if (!ms) return

      const toolSequence = chain.toolSequence.join(' → ')
      const status = chain.success ? '成功' : '部分失败'
      const content = `[tool_chain_summary] 需求: ${chain.userIntent.slice(0, 80)} | 工具链: ${toolSequence} | 结果: ${status} | 摘要: ${chain.summary.slice(0, 100)}`

      const structuredData = JSON.stringify({
        source: 'tool_chain_summary',
        chainId: chain.id,
        intent: chain.userIntent.slice(0, 200),
        category: chain.category,
        toolSequence: chain.toolSequence,
        toolCount: chain.toolCalls.length,
        success: chain.success,
        completedAt: chain.completedAt,
        summary: chain.summary.slice(0, 300),
      })

      ms.addEntry('interaction', content, this.config.MEMORY_CONFIDENCE, {
        tier: 'semi',
        structuredData,
      })

      ms.flush()
    } catch (err: any) {
      log('WARN', 'tool_chain_memory_summary_failed', { chainId: chain.id, error: err.message })
    }
  }

  // ══════════════════════════════════════════
  //  内部：相似度计算
  // ══════════════════════════════════════════

  /**
   * 将文本分词为关键词列表。
   */
  private tokenize(text: string): string[] {
    const words = text
      .toLowerCase()
      .split(/[\s,，。、；：！？\n\r\t\/\\()（）\[\]【】{}"'「」]+/)
      .filter((w) => w.length >= 2)

    // 去重
    return [...new Set(words)]
  }

  /**
   * 计算意图文本与历史链的相似度。
   * 基于关键词重叠率 + 分类匹配 + 工具序列权重。
   */
  private computeSimilarity(
    queryLower: string,
    queryTokens: string[],
    chain: CompletedChain,
  ): number {
    if (queryTokens.length === 0) return 0

    const intentLower = chain.userIntent.toLowerCase()
    const intentTokens = this.tokenize(intentLower)

    // 1. 关键词重叠率（Jaccard 相似度）
    const intersection = queryTokens.filter((t) => intentTokens.includes(t))
    const union = new Set([...queryTokens, ...intentTokens])
    const keywordScore = union.size > 0
      ? intersection.length / union.size
      : 0

    // 2. 分类匹配加分
    const categoryBonus =
      chain.category === this._currentCategory && chain.category !== 'general'
        ? 0.15
        : 0

    // 3. 直接子串匹配加分
    const substringBonus =
      intentLower.includes(queryLower) || queryLower.includes(intentLower)
        ? 0.2
        : 0

    // 4. 完整包含某关键词精确匹配
    const exactBonus = intersection.some((t) =>
      intentLower.includes(t) && queryLower.includes(t),
    )
      ? 0.1
      : 0

    // 综合评分（上限 1.0）
    const score = Math.min(keywordScore + categoryBonus + substringBonus + exactBonus, 1.0)

    return Math.round(score * 100) / 100
  }

  /**
   * 构建匹配原因描述。
   */
  private buildMatchReason(currentIntent: string, chain: CompletedChain): string {
    const queryLower = currentIntent.toLowerCase()
    const intentLower = chain.userIntent.toLowerCase()
    const queryTokens = this.tokenize(queryLower)
    const intentTokens = this.tokenize(intentLower)

    const common = queryTokens.filter((t) => intentTokens.includes(t))

    if (common.length > 0) {
      return `关键词匹配: ${common.slice(0, 5).join(', ')}`
    }

    if (intentLower.includes(queryLower) || queryLower.includes(intentLower)) {
      return '文本内容相似'
    }

    if (chain.category === this._currentCategory && chain.category !== 'general') {
      return `同类任务(${chain.category})`
    }

    return '最近使用过'
  }

  // ══════════════════════════════════════════
  //  内部：工具方法
  // ══════════════════════════════════════════

  /**
   * 从当前链接构建有序去重的工具序列。
   */
  private buildToolSequence(): string[] {
    const seen = new Set<string>()
    const sequence: string[] = []
    for (const link of this._currentLinks) {
      if (!seen.has(link.toolName)) {
        seen.add(link.toolName)
        sequence.push(link.toolName)
      }
    }
    return sequence
  }

  /**
   * 从当前链接构建参数预设。
   * 对同一工具多次调用，取最常用的参数值。
   */
  private buildParamPresets(): Record<string, Record<string, string>> {
    const toolParamValues = new Map<
      string,
      Map<string, Map<string, number>>
    >()

    for (const link of this._currentLinks) {
      if (!toolParamValues.has(link.toolName)) {
        toolParamValues.set(link.toolName, new Map())
      }
      const paramMap = toolParamValues.get(link.toolName)!

      for (const [key, value] of Object.entries(link.args)) {
        if (key.startsWith('_')) continue
        if (typeof value !== 'string' || value.length > 100) continue

        if (!paramMap.has(key)) {
          paramMap.set(key, new Map())
        }
        const valueCounts = paramMap.get(key)!
        const strVal = String(value)
        valueCounts.set(strVal, (valueCounts.get(strVal) || 0) + 1)
      }
    }

    const presets: Record<string, Record<string, string>> = {}
    for (const [toolName, paramMap] of toolParamValues) {
      presets[toolName] = {}
      for (const [param, valueCounts] of paramMap) {
        // 选择出现次数最多的值
        let bestValue = ''
        let bestCount = 0
        for (const [value, count] of valueCounts) {
          if (count > bestCount) {
            bestValue = value
            bestCount = count
          }
        }
        if (bestValue) {
          presets[toolName][param] = bestValue
        }
      }
    }

    return presets
  }

  /**
   * 净化参数（移除冗长值、敏感字段），用于存储到 Memory。
   */
  private sanitizeArgs(args: Record<string, any>): Record<string, any> {
    const sanitized: Record<string, any> = {}
    for (const [key, value] of Object.entries(args)) {
      if (key.startsWith('_')) continue
      if (typeof value === 'string') {
        sanitized[key] = value.slice(0, 100)
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        sanitized[key] = value
      }
    }
    return sanitized
  }

  /**
   * 生成唯一链 ID。
   */
  private generateChainId(): string {
    const ts = Date.now().toString(36)
    const rand = Math.random().toString(36).slice(2, 6)
    return `chain_${ts}_${rand}`
  }

  /**
   * 重置活跃链状态。
   */
  private resetActiveChain(): void {
    this._currentIntent = ''
    this._currentCategory = ''
    this._currentLinks = []
    this._chainStartTime = 0
  }
}

// ══════════════════════════════════════════
//  全局单例
// ══════════════════════════════════════════

export const toolCallChainStore = new ToolCallChainStore()
