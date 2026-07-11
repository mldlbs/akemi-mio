/**
 * MemoryEvolutionBridge — Memory × Evolution 深度融合桥接器
 *
 * 统一接口层，实现双向往来数据融合：
 * 1. Memory → Evolution：提供长时记忆上下文、用户兴趣画像、话题分布、任务状态
 * 2. Evolution → Memory：存储进化结果（周期摘要/管道指标/洞察）到记忆系统；
 *                       将进化发现的用户偏好持久化到用户画像
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

import { MemoryService } from './MemoryService'
import type { PipelineMetrics } from '../evolution/automation'
import type { InterestProfile } from './BehaviorWeightingService'
import type { UserProfileData } from './MemoryService'
import { log } from '../logger/Logger'

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

// ═══════════════════════════════════════════════
//  桥接器类
// ═══════════════════════════════════════════════

export class MemoryEvolutionBridge {
  private memoryService: MemoryService | null = null

  constructor() {
    log('INFO', 'memory_evolution_bridge_created')
  }

  /** 注入 MemoryService 引用（由 AppRuntime 在 Service Stage 调用） */
  setMemoryService(ms: MemoryService): void {
    this.memoryService = ms
    log('INFO', 'memory_evolution_bridge_memory_attached')
  }

  /** 桥接器是否已就绪 */
  isReady(): boolean {
    return this.memoryService !== null
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
      const allTopics = weighted.flatMap(e => e.topics || [])
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

  // ════════════════════════════════════════════
  //  Evolution → Memory 方向
  // ════════════════════════════════════════════

  /**
   * 将进化周期结果存储到记忆系统。
   * 存储方式：
   *   1. 进化周期主摘要 → `user_fact` 类型，semi 层级
   *   2. 管道指标摘要 → `user_fact` 类型，ephemeral 层级
   *   3. 进化洞察 → `user_fact` 类型，semi 层级（最多 3 条）
   */
  storeEvolutionResult(result: MemoryEvolutionResult): void {
    if (!this.memoryService) return

    try {
      const ms = this.memoryService
      const timestamp = new Date().toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      })
      const statusIcon = result.success ? '✅' : '⚠️'

      // 1. 进化周期主摘要
      const summaryContent = `【进化周期 ${timestamp}】${statusIcon} ${result.summary.slice(0, 200)}`
      ms.addFact(summaryContent, result.success ? 0.7 : 0.5, { tier: 'semi' })

      // 2. 管道指标摘要
      if (result.metrics) {
        const m = result.metrics
        const metricsContent = `【进化管道】采集${m.totalCollected}个问题，修复${m.totalFixed}个，失败${m.totalFailed}个，队列剩余${m.queueSize}个`
        ms.addFact(metricsContent, 0.6, { tier: 'ephemeral' })
      }

      // 3. 进化洞察
      if (result.insights && result.insights.length > 0) {
        for (const insight of result.insights.slice(0, 3)) {
          ms.addFact(`【进化洞察】${insight.slice(0, 300)}`, 0.65, { tier: 'semi' })
        }
      }

      log('INFO', 'memory_evolution_result_stored', {
        success: result.success,
        insights: result.insights?.length ?? 0,
      })
    } catch (err) {
      log('WARN', 'memory_evolution_store_result_failed', { error: String(err) })
    }
  }

  /**
   * 将进化系统发现的用户偏好持久化到 MemoryService 的用户画像。
   *
   * @param data 偏好数据
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
   * 组合画像、任务状态、兴趣话题和进化历史，供 PreProcess 使用。
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

      // 从记忆中检索最近的进化周期记录
      const recentEvolutionEntries = this.memoryService
        .getEntries()
        .filter(e => e.type === 'user_fact' && e.content.includes('【进化周期'))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 5)

      if (recentEvolutionEntries.length > 0) {
        parts.push('')
        parts.push('【近期进化记录（来自记忆系统）】')
        for (const e of recentEvolutionEntries) {
          parts.push('- ' + e.content.slice(0, 150))
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
        .filter(e => e.type === 'user_fact' && e.content.includes('【进化周期'))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 5)

      if (entries.length === 0) return '暂无历史进化记录。'

      return [
        '---',
        '【近期进化历史（从记忆系统）】',
        ...entries.map(e => '- ' + e.content.slice(0, 150)),
        '---',
      ].join('\n')
    } catch {
      return '读取进化历史失败。'
    }
  }
}

/** 模块级桥接器单例 */
export const memoryEvolutionBridge = new MemoryEvolutionBridge()
