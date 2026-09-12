/**
 * MemoryEvolutionBridge — Memory × Evolution 深度融合桥接器 (v2)
 *
 * 统一接口层，实现双向往来数据融合：
 * 1. Memory → Evolution：提供长时记忆上下文、用户兴趣画像、话题分布、任务状态、
 *    以及记忆驱动的进化优先级建议
 * 2. Evolution → Memory：存储进化结果（周期摘要/管道指标/洞察）到记忆系统，
 *    使用独立进化类型（evolution_insight/evolution_cycle）实现维度隔离；
 *    将进化发现的用户偏好持久化到用户画像
 *
 * 深度集成新增（v2）：
 * - 进化洞察作为独立记忆维度：evolution_insight/evolution_cycle 类型，可独立查询
 * - 记忆驱动进化优先级：分析记忆模式产生进化目标建议
 * - 跨域关联查询：同一话题在记忆和进化双维度的统一视图
 * - 事件驱动通知：重要记忆变化触发的进化系统回调
 * - VectorMemory / KnowledgeGraph 同步：进化洞察进入语义检索和知识图谱
 * - IMemoryPlugin 实现：通过 UnifiedMemoryQuery 可查询进化维度
 *
 * 设计目标：
 * - 消除信息孤岛，使 Evolution 能感知长期记忆和用户画像
 * - 使 Memory 能记录进化历史，供后续 LLM 推理引用
 * - 产生 1+1>2 的涌现效果：进化方向由记忆驱动，记忆内容因进化而丰富
 *
 * 风险控制：
 * - 耦合度：桥接器仅通过 MemoryService 公共 API 交互，不侵入内部实现
 * - 两个模块独立演进：桥接器层可在任一模块变更时单独更新
 * - 故障隔离：桥接器所有方法 catch 内部异常，不传播到调用方
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { MemoryService } from './MemoryService'
import type { PipelineMetrics } from '@akemi-mio/evolution/automation'
import type { InterestProfile } from './BehaviorWeightingService'
import type { UserProfileData } from './MemoryService'
import type { IMemoryPlugin, MemoryRetrievalResult } from './IMemoryPlugin'

// ═══════════════════════════════════════════════
//  类型定义
// ═══════════════════════════════════════════════

/** Memory → Evolution 方向的上下文封装 */
export interface EvolutionMemoryContext {
  /** 格式化长时记忆上下文（复用 getFormattedContext） */
  formattedContext: string
  /** 当前用户兴趣话题列表（去重） */
  interestTopics: string[]
  /** 用户画像摘要 */
  userProfileSummary: string
  /** 未完成任务上下文 */
  taskContext: string
  /** 兴趣分布原始数据（可选） */
  interestProfile?: InterestProfile
}

/** Evolution → Memory 方向的存储输入 */
export interface MemoryEvolutionResult {
  /** 进化周期摘要文本 */
  summary: string
  /** 管道指标（可能为空） */
  metrics: PipelineMetrics | null
  /** 是否成功 */
  success: boolean
  /** 进化洞察列表（可选，LLM 或管道产出的分析结论） */
  insights?: string[]
}

/**
 * 记忆驱动的进化优先级建议。
 * 由桥接器分析记忆模式生成，供 SelfEvolutionService 调整进化目标。
 */
export interface EvolutionPriority {
  /** 优先级领域标签 */
  topic: string
  /** 优先级得分 (0–1) */
  score: number
  /** 建议理由 */
  reason: string
  /** 关联的记忆条目数 */
  relatedEntryCount: number
  /** 建议的采集器类型 */
  suggestedCollector?: string
}

/**
 * 跨域关联查询结果：同一话题在记忆和进化双维度的统一视图。
 */
export interface MemoryEvolutionCorrelation {
  /** 查询话题 */
  topic: string
  /** 匹配的记忆条目 */
  memoryEntries: Array<{ content: string; confidence: number; timestamp: number }>
  /** 匹配的进化洞察 */
  evolutionInsights: Array<{ content: string; success: boolean; timestamp: number }>
  /** 关联强度 (0–1) */
  correlationStrength: number
  /** 分析结论 */
  conclusion: string
}

/**
 * 重要记忆变化事件类型。
 * 由 MemoryService 在关键状态变更时通过桥接器通知进化系统。
 */
export type MemoryChangeEvent =
  | { type: 'new_high_confidence_fact'; content: string; confidence: number }
  | { type: 'user_preference_changed'; key: string; value: string; category: string }
  | { type: 'repeated_correction_pattern'; topic: string; count: number }
  | { type: 'task_state_changed'; taskId: string; status: string }

/** 记忆变化事件回调签名 */
export type MemoryChangeCallback = (event: MemoryChangeEvent) => void

// ═══════════════════════════════════════════════
//  桥接器类
// ═══════════════════════════════════════════════

export class MemoryEvolutionBridge implements IMemoryPlugin {
  readonly name = 'evolution_bridge'

  private memoryService: MemoryService | null = null

  /** 记忆变化事件订阅者列表 */
  private changeSubscribers: MemoryChangeCallback[] = []

  constructor() {
    log('INFO', 'memory_evolution_bridge_v2_created')
  }

  /** 注入 MemoryService 引用（由 AppRuntime 在 Service Stage 调用） */
  setMemoryService(ms: MemoryService): void {
    this.memoryService = ms
    // 注册自身为 IMemoryPlugin，使进化洞察维度可通过 UnifiedMemoryQuery 查询
    try {
      ms.unifiedQuery.registerPlugin(this)
      log('INFO', 'memory_evolution_bridge_plugin_registered')
    } catch (err) {
      log('WARN', 'memory_evolution_bridge_plugin_register_failed', { error: String(err) })
    }
    log('INFO', 'memory_evolution_bridge_memory_attached')
  }

  /** 桥接器是否已就绪 */
  isReady(): boolean {
    return this.memoryService !== null
  }

  /** 获取底层 MemoryService 引用（供 SelfEvolutionService 只读访问） */
  getMemoryService(): MemoryService | null {
    return this.memoryService
  }

  // ════════════════════════════════════════════
  //  记忆变化事件系统
  // ════════════════════════════════════════════

  /**
   * 订阅记忆变化事件。
   * 当 MemoryService 发生重要变更时（新增高置信度事实、偏好变更等），
   * 订阅者（通常是 SelfEvolutionService）会收到通知。
   */
  subscribeMemoryChanges(callback: MemoryChangeCallback): () => void {
    this.changeSubscribers.push(callback)
    return () => {
      const idx = this.changeSubscribers.indexOf(callback)
      if (idx >= 0) this.changeSubscribers.splice(idx, 1)
    }
  }

  /**
   * 通知所有订阅者记忆发生了变化。
   * 由 MemoryService 在关键变更后调用。
   */
  notifyMemoryChanged(event: MemoryChangeEvent): void {
    if (this.changeSubscribers.length === 0) return
    log('INFO', 'memory_evolution_bridge_event', { type: event.type })
    for (const cb of this.changeSubscribers) {
      try {
        cb(event)
      } catch (err) {
        log('WARN', 'memory_evolution_bridge_subscriber_error', {
          error: String(err),
        })
      }
    }
  }

  // ════════════════════════════════════════════
  //  Memory → Evolution 方向
  // ════════════════════════════════════════════

  /**
   * 获取进化系统所需的长时记忆上下文。
   * 精简自 getFormattedContext，聚焦对进化决策有用的维度。
   */
  getEvolutionMemoryContext(): EvolutionMemoryContext {
    if (!this.memoryService) {
      return { formattedContext: '', interestTopics: [], userProfileSummary: '', taskContext: '' }
    }

    try {
      const ms = this.memoryService

      // 格式化长时记忆上下文
      const formattedContext = ms.getFormattedContext()

      // 从行为加权条目中提取用户近期关注话题
      const weighted = ms.getBehaviorWeightedEntries(undefined, 10)
      const allTopics = weighted.flatMap((e) => e.topics || [])
      const interestTopics = [...new Set(allTopics)].slice(0, 10)

      // 用户画像摘要
      const userProfileSummary = ms.getUserProfileContext()

      // 未完成任务上下文
      const taskContext = ms.getTaskStateContext()

      // 兴趣分布（可选）
      let interestProfile: InterestProfile | undefined
      try {
        interestProfile = ms.getCurrentInterestProfile()
      } catch {
        // 非关键路径，静默失败
      }

      return { formattedContext, interestTopics, userProfileSummary, taskContext, interestProfile }
    } catch (err) {
      log('WARN', 'memory_evolution_bridge_get_context_failed', { error: String(err) })
      return { formattedContext: '', interestTopics: [], userProfileSummary: '', taskContext: '' }
    }
  }

  /**
   * 记忆驱动的进化优先级建议（v2 新增）。
   *
   * 分析记忆系统当前状态，识别出进化系统应优先关注的领域。
   * 分析维度：
   * 1. 高频不满信号话题（来自 MemoryAnalysisCollector 产生的记忆）
   * 2. 新出现的高置信度用户偏好
   * 3. 长时间未访问但高重要的记忆（可能被遗忘的优化点）
   * 4. 用户画像中的身份/风格变更（需进化系统适配）
   *
   * @param maxSuggestions 最多返回建议数
   * @returns 按得分降序排列的进化优先级列表
   */
  getTargetedEvolutionPriorities(maxSuggestions = 5): EvolutionPriority[] {
    if (!this.memoryService) return []

    try {
      const ms = this.memoryService
      const priorities: EvolutionPriority[] = []

      // 1. 扫描记忆中的不满信号 → 进化优先级
      const correctionEntries = ms
        .getEntries()
        .filter(
          (e) =>
            e.type === 'user_fact' &&
            (e.content.includes('不满') ||
              e.content.includes('纠正') ||
              e.content.includes('重复提问') ||
              e.content.includes('error_pattern') ||
              e.content.includes('short_response')),
        )
        .sort((a, b) => b.behaviorScore - a.behaviorScore)

      if (correctionEntries.length > 0) {
        // 聚类话题
        const topicCounts = new Map<string, number>()
        for (const e of correctionEntries) {
          const topics = e.topics || []
          for (const t of topics) {
            topicCounts.set(t, (topicCounts.get(t) || 0) + 1)
          }
        }
        const topTopic = [...topicCounts.entries()].sort((a, b) => b[1] - a[1])[0]
        if (topTopic) {
          priorities.push({
            topic: topTopic[0],
            score: Math.min(1, topTopic[1] / 5),
            reason: `记忆系统检测到 ${topTopic[1]} 条与「${topTopic[0]}」相关的用户不满/纠正信号，建议优先优化该领域`,
            relatedEntryCount: correctionEntries.length,
            suggestedCollector: 'memory-analysis',
          })
        }
      }

      // 2. 新出现的用户偏好变更 → 进化适配建议
      const recentPreferences = ms
        .getUserPreferences()
        .filter((p) => p.updatedAt > Date.now() - 7 * 24 * 60 * 60 * 1000) // 最近7天
        .sort((a, b) => b.updatedAt - a.updatedAt)

      if (recentPreferences.length > 0) {
        const topPref = recentPreferences[0]
        priorities.push({
          topic: `preference:${topPref.key}`,
          score: topPref.confidence * 0.8,
          reason: `用户画像新增偏好「${topPref.key}: ${topPref.value}」(置信度:${topPref.confidence})，建议进化系统评估是否需要适配`,
          relatedEntryCount: recentPreferences.length,
          suggestedCollector: 'behavior',
        })
      }

      // 3. 高置信度但长期未访问的记忆 → 可能被遗忘的重要事实
      const staleHighConfidence = ms
        .getEntries()
        .filter(
          (e) =>
            e.type === 'user_fact' &&
            e.confidence >= 0.8 &&
            e.tier !== 'permanent' &&
            e.lastAccessedAt > 0 &&
            Date.now() - e.lastAccessedAt > 7 * 24 * 60 * 60 * 1000,
        )
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 3)

      if (staleHighConfidence.length > 0) {
        priorities.push({
          topic: 'stale_important_memory',
          score: 0.5,
          reason: `有 ${staleHighConfidence.length} 条高置信度记忆长期未访问（如「${staleHighConfidence[0].content.slice(0, 40)}」），可能值得进化系统重新评估`,
          relatedEntryCount: staleHighConfidence.length,
        })
      }

      // 4. 进化洞察维度自身分析：高失败率进化周期话题
      const evolutionInsights = ms
        .getEntries()
        .filter((e) => e.type === 'evolution_insight')
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 10)

      const failedInsights = evolutionInsights.filter((e) => e.content.includes('⚠️') || e.confidence < 0.5)
      if (failedInsights.length >= 3) {
        priorities.push({
          topic: 'evolution_quality',
          score: Math.min(1, failedInsights.length / 10),
          reason: `近期进化周期失败/异常率较高（${failedInsights.length}/${evolutionInsights.length}），建议检查进化系统健康状态`,
          relatedEntryCount: failedInsights.length,
        })
      }

      return priorities.sort((a, b) => b.score - a.score).slice(0, maxSuggestions)
    } catch (err) {
      log('WARN', 'memory_evolution_get_priorities_failed', { error: String(err) })
      return []
    }
  }

  // ════════════════════════════════════════════
  //  Evolution → Memory 方向 (增强)
  // ════════════════════════════════════════════

  /**
   * 将进化周期结果存储到记忆系统（v2 增强版）。
   *
   * 存储方式（v2 改进：使用独立进化类型）：
   *   1. 进化周期摘要 → `evolution_cycle` 类型，semi 层级
   *      用于追踪进化系统整体运行状态
   *   2. 管道指标 → `evolution_cycle` 类型结构化数据
   *      包含详细指标，可被下游分析查询
   *   3. 进化洞察 → `evolution_insight` 类型，semi 层级（最多 3 条）
   *      独立维度，可通过 UnifiedMemoryQuery 检索
   *   4. 语义检索同步 → 同步到 VectorMemory（如可用）
   *   5. 知识图谱同步 → 同步到 KnowledgeGraph（如可用）
   */
  storeEvolutionResult(result: MemoryEvolutionResult): void {
    if (!this.memoryService) return

    try {
      const ms = this.memoryService
      const timestamp = Date.now()
      const timeLabel = new Date(timestamp).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
      const statusIcon = result.success ? '✅' : '⚠️'

      // 1. 进化周期主记录（evolution_cycle 类型）
      const cycleContent = `【进化周期 ${timeLabel}】${statusIcon} ${result.summary.slice(0, 200)}`
      ms.addEntry('evolution_cycle', cycleContent, result.success ? 0.7 : 0.5, { tier: 'semi' })

      // 2. 管道指标 → 作为 evolution_cycle 的结构化数据附加
      if (result.metrics) {
        const m = result.metrics
        const metricsContent = `【进化管道】采集${m.totalCollected}个问题，修复${m.totalFixed}个，失败${m.totalFailed}个，队列剩余${m.queueSize}个`
        // 作为 evolution_cycle 类型记录，附加结构化指标数据
        ms.addEntry('evolution_cycle', metricsContent, 0.6, {
          tier: 'ephemeral',
          structuredData: JSON.stringify({
            type: 'pipeline_metrics',
            collected: m.totalCollected,
            fixed: m.totalFixed,
            failed: m.totalFailed,
            queueSize: m.queueSize,
            timestamp,
          }),
        })
      }

      // 3. 进化洞察 → evolution_insight 类型（独立维度）
      if (result.insights && result.insights.length > 0) {
        for (const insight of result.insights.slice(0, 3)) {
          const insightContent = `【进化洞察】${insight.slice(0, 300)}`
          ms.addEntry('evolution_insight', insightContent, 0.65, { tier: 'semi' })
        }
      }

      // 4. 同步到 VectorMemory（通过 MemoryService 的 addEntry 间接触发）
      //    MemoryService.addEntry 对 user_fact 类型会自动同步到 vector/knowledgeGraph
      //    但 evolution_insight/evolution_cycle 不会自动同步。
      //    这里额外添加到 vector 和知识图谱
      this.syncEvolutionInsightToVectorAndKG(result, statusIcon)

      log('INFO', 'memory_evolution_result_stored_v2', {
        success: result.success,
        insights: result.insights?.length ?? 0,
      })
    } catch (err) {
      log('WARN', 'memory_evolution_store_result_failed', { error: String(err) })
    }
  }

  /**
   * 将进化洞察同步到 VectorMemory 和 KnowledgeGraph。
   * 使进化产生的分析结论可以通过语义检索和知识查询访问。
   */
  private syncEvolutionInsightToVectorAndKG(result: MemoryEvolutionResult, statusIcon: string): void {
    if (!this.memoryService) return

    try {
      const ms = this.memoryService

      // 同步主摘要到 VectorMemory
      if (result.summary) {
        const vectorContent = `【进化摘要】${statusIcon} ${result.summary.slice(0, 300)}`
        ms.vector.store(vectorContent, result.success ? 0.7 : 0.5, 'user_fact')
      }

      // 同步洞察到 KnowledgeGraph
      if (result.insights && result.insights.length > 0) {
        for (const insight of result.insights.slice(0, 3)) {
          const kgContent = `【进化洞察】${insight.slice(0, 300)}`
          ms.knowledgeGraph.ingest(kgContent, 0.65)
        }
      }

      // 同步管道指标到 KnowledgeGraph（如果有问题数 > 0）
      if (result.metrics && result.metrics.totalCollected > 0) {
        const m = result.metrics
        const metricContent = [
          `【进化管道统计】`,
          `采集: ${m.totalCollected}`,
          `修复: ${m.totalFixed}`,
          `失败: ${m.totalFailed}`,
          `队列: ${m.queueSize}`,
          `状态: ${statusIcon}`,
        ].join(' | ')
        ms.knowledgeGraph.ingest(metricContent, 0.6)
      }
    } catch (err) {
      log('WARN', 'memory_evolution_sync_vector_kg_failed', { error: String(err) })
    }
  }

  /**
   * 将进化系统发现的用户偏好持久化到 MemoryService 的用户画像。
   */
  storeUserPreference(data: {
    key: string
    value: string
    confidence: number
    category: UserProfileData['category']
    source: string
  }): void {
    if (!this.memoryService) return

    try {
      this.memoryService.saveUserPreference({
        key: data.key,
        value: data.value,
        confidence: data.confidence,
        category: data.category,
        source: `evolution:${data.source}`,
        updatedAt: Date.now(),
      })
      log('INFO', 'memory_evolution_preference_stored', {
        key: data.key,
        category: data.category,
        confidence: data.confidence,
      })
    } catch (err) {
      log('WARN', 'memory_evolution_store_preference_failed', { error: String(err) })
    }
  }

  // ════════════════════════════════════════════
  //  高级集成 API
  // ════════════════════════════════════════════

  /**
   * 获取用于进化分析/管道的增强上下文。
   * 组合画像、任务状态、兴趣话题、进化历史和优先级建议，供 PreProcess 使用。
   */
  getEnhancedAnalysisContext(): string {
    if (!this.memoryService) return ''

    try {
      const ctx = this.getEvolutionMemoryContext()
      const parts: string[] = []

      if (ctx.userProfileSummary) {
        parts.push(ctx.userProfileSummary)
      }

      if (ctx.taskContext) {
        parts.push(ctx.taskContext)
      }

      if (ctx.interestTopics.length > 0) {
        parts.push(`【用户近期关注话题】${ctx.interestTopics.join('、')}`)
      }

      // 从记忆中检索最近的进化周期记录（evolution_cycle 类型）
      const recentEvolutionEntries = this.memoryService
        .getEntries()
        .filter((e) => e.type === 'evolution_cycle' && e.content.includes('【进化周期'))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 5)

      if (recentEvolutionEntries.length > 0) {
        parts.push('')
        parts.push('【近期进化记录（来自记忆系统）】')
        for (const e of recentEvolutionEntries) {
          parts.push('- ' + e.content.slice(0, 150))
        }
      }

      // 附加记忆驱动的进化优先级建议（v2 新增）
      const priorities = this.getTargetedEvolutionPriorities(3)
      if (priorities.length > 0) {
        parts.push('')
        parts.push('【记忆驱动的进化优先级建议】')
        for (const p of priorities) {
          parts.push(`- [${p.topic}] 得分:${p.score.toFixed(2)} — ${p.reason}`)
        }
      }

      return parts.join('\n')
    } catch (err) {
      log('WARN', 'memory_evolution_get_enhanced_context_failed', { error: String(err) })
      return ''
    }
  }

  /** 获取记忆系统中记录的进化历史摘要文本 */
  getEvolutionHistoryFromMemory(): string {
    if (!this.memoryService) return '暂无历史进化记录。'

    try {
      const entries = this.memoryService
        .getEntries()
        .filter((e) => (e.type === 'evolution_cycle' || e.type === 'user_fact') && e.content.includes('【进化周期'))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 5)

      if (entries.length === 0) return '暂无历史进化记录。'

      return ['---', '【近期进化历史（从记忆系统）】', ...entries.map((e) => '- ' + e.content.slice(0, 150)), '---'].join('\n')
    } catch {
      return '读取进化历史失败。'
    }
  }

  // ════════════════════════════════════════════
  //  跨域关联查询 (v2 新增)
  // ════════════════════════════════════════════

  /**
   * 跨域关联查询：同一话题在记忆和进化双维度的统一视图。
   *
   * 同时查询：
   * - Memory 维度：user_fact、user_profile 中和话题相关的条目
   * - Evolution 维度：evolution_insight、evolution_cycle 中和话题相关的条目
   *
   * 结果包含关联强度分析和结论建议。
   *
   * @param topic 要查询的话题
   * @returns 跨域关联结果，或 null（无数据）
   */
  queryMemoryEvolutionCorrelation(topic: string): MemoryEvolutionCorrelation | null {
    if (!this.memoryService || !topic.trim()) return null

    try {
      const ms = this.memoryService
      const topicLower = topic.toLowerCase()

      // 1. 匹配记忆条目（user_fact + user_profile）
      const memoryEntries = ms
        .getEntries()
        .filter(
          (e) =>
            (e.type === 'user_fact' || e.type === 'user_profile') &&
            (e.content.toLowerCase().includes(topicLower) ||
              (e.topics && e.topics.some((t: string) => t.toLowerCase().includes(topicLower)))),
        )
        .sort((a, b) => b.behaviorScore - a.behaviorScore)
        .slice(0, 10)
        .map((e) => ({
          content: e.content.slice(0, 200),
          confidence: e.confidence,
          timestamp: e.createdAt,
        }))

      // 2. 匹配进化洞察（evolution_insight + evolution_cycle）
      const evolutionInsights = ms
        .getEntries()
        .filter(
          (e) =>
            (e.type === 'evolution_insight' || e.type === 'evolution_cycle') &&
            (e.content.toLowerCase().includes(topicLower) ||
              (e.topics && e.topics.some((t: string) => t.toLowerCase().includes(topicLower)))),
        )
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 10)
        .map((e) => ({
          content: e.content.slice(0, 200),
          success: e.confidence >= 0.6,
          timestamp: e.createdAt,
        }))

      if (memoryEntries.length === 0 && evolutionInsights.length === 0) return null

      // 3. 计算关联强度
      const correlationStrength = this.computeCorrelationStrength(
        memoryEntries.length,
        evolutionInsights.length,
        memoryEntries.reduce((s, e) => s + e.confidence, 0) / Math.max(memoryEntries.length, 1),
        evolutionInsights.reduce((s, e) => s + (e.success ? 1 : 0), 0) / Math.max(evolutionInsights.length, 1),
      )

      // 4. 生成分析结论
      const conclusion = this.buildCorrelationConclusion(topic, memoryEntries.length, evolutionInsights.length, correlationStrength)

      return {
        topic,
        memoryEntries,
        evolutionInsights,
        correlationStrength,
        conclusion,
      }
    } catch (err) {
      log('WARN', 'memory_evolution_correlation_query_failed', { error: String(err) })
      return null
    }
  }

  /** 计算记忆-进化关联强度 */
  private computeCorrelationStrength(memCount: number, evoCount: number, avgMemConfidence: number, evoSuccessRate: number): number {
    // 维度1：覆盖度 - 两个维度都有数据
    const coverage = Math.min(1, (memCount > 0 ? 0.5 : 0) + (evoCount > 0 ? 0.5 : 0))

    // 维度2：质量 - 置信度和成功率
    const quality = avgMemConfidence * 0.5 + evoSuccessRate * 0.5

    // 维度3：数据量 - 丰富度
    const richness = Math.min(1, (memCount + evoCount) / 20)

    return coverage * 0.4 + quality * 0.4 + richness * 0.2
  }

  /** 生成关联分析结论文本 */
  private buildCorrelationConclusion(topic: string, memCount: number, evoCount: number, strength: number): string {
    if (memCount === 0 && evoCount > 0) {
      return `话题「${topic}」仅有进化系统层面的记录（${evoCount}条），记忆系统尚未沉淀相关内容。建议关注进化对该话题的分析是否已反馈到实际对话体验。`
    }
    if (evoCount === 0 && memCount > 0) {
      return `话题「${topic}」在记忆系统中有 ${memCount} 条记录，但进化系统尚未对该话题进行过分析。建议考虑将「${topic}」纳入进化分析范围。`
    }
    if (strength >= 0.7) {
      return `话题「${topic}」在记忆和进化双维度均有丰富记录（记忆${memCount}条/进化${evoCount}条），关联强度高。进化系统已对该话题进行了有效覆盖，建议持续监测。`
    }
    if (strength >= 0.4) {
      return `话题「${topic}」在双维度均有记录但关联强度一般（记忆${memCount}条/进化${evoCount}条）。可能进化对该话题的分析还不够深入，或记忆沉淀不够充分。建议增加该话题的进化分析频次。`
    }
    return `话题「${topic}」在记忆和进化系统的关联较弱（强度:${strength.toFixed(2)}）。建议先确认该话题是否需要跨系统关注。`
  }

  // ════════════════════════════════════════════
  //  IMemoryPlugin 接口实现
  // ════════════════════════════════════════════

  /**
   * 通过 IMemoryPlugin 接口检索进化洞察。
   * 使进化维度可通过 UnifiedMemoryQuery 统一查询。
   *
   * @param query 查询文本
   * @param topK 返回结果数
   */
  async retrieve(query: string, topK: number = 5): Promise<MemoryRetrievalResult[]> {
    if (!this.memoryService) return []

    try {
      const lowerQuery = query.toLowerCase()
      const entries = this.memoryService
        .getEntries()
        .filter(
          (e) =>
            (e.type === 'evolution_insight' || e.type === 'evolution_cycle') &&
            (query === '' || e.content.toLowerCase().includes(lowerQuery)),
        )
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, topK)
        .map((e) => ({
          content: e.content.slice(0, 300),
          score: e.confidence,
          source: this.name,
          metadata: {
            type: e.type,
            tier: e.tier,
            timestamp: e.createdAt,
          },
          timestamp: e.createdAt,
        }))

      return entries
    } catch {
      return []
    }
  }

  /**
   * 获取格式化上下文（IMemoryPlugin 接口）。
   * 返回近期进化洞察列表，用于注入 system prompt。
   */
  getContext(_query?: string): string {
    if (!this.memoryService) return ''

    try {
      const evolutionEntries = this.memoryService
        .getEntries()
        .filter((e) => e.type === 'evolution_insight')
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 5)

      if (evolutionEntries.length === 0) return ''

      const parts: string[] = ['---', '【进化洞察摘要】', '以下是从自进化系统最近的分析中提取的洞察（只读）：']
      for (const e of evolutionEntries) {
        parts.push('- ' + e.content.slice(0, 150))
      }
      parts.push('---')
      return parts.join('\n')
    } catch {
      return ''
    }
  }

  /** 清理资源（IMemoryPlugin 接口） */
  dispose(): void {
    this.changeSubscribers = []
    this.memoryService = null
    log('INFO', 'memory_evolution_bridge_disposed')
  }
}

/** 模块级桥接器单例 */
export const memoryEvolutionBridge = new MemoryEvolutionBridge()
