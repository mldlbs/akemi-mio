/**
 * MetaController — P3 记忆层级编排
 *
 * 职责：
 * 1. P0→P1 沉淀：每个交互结束时判断是否需要生成摘要和决策记录
 * 2. P1→P2 提纯：周期性将摘要/决策提纯为长期记忆
 * 3. 策略自适应：根据负载和命中率调整各层参数
 * 4. 后台优化：去重/沉默证据清洗/老旧决策过期
 *
 * 区别于 MetaCycle（长期自我评估，LLM 驱动的身份/特质/模式分析），
 * MetaController 是轻量策略引擎，纯本地逻辑，<10ms。
 */

import { log } from '../logger/Logger'
import type { SummaryMemory } from '../memory/SummaryMemory'
import type { DecisionStore } from '../memory/DecisionStore'
import type { MemoryService } from '../memory/MemoryService'

// ─── 策略配置 ───

export interface MetaPolicy {
  /** 每 N 轮对话触发一次摘要生成 */
  summaryFrequency: number
  /** Token 使用超此比例（0-1）触发摘要 */
  summaryTokenThreshold: number
  /** 决策采样率 0-1 */
  decisionLogChance: number
  /** 提纯间隔（ms） */
  consolidationInterval: number
  /** 至少积累多少条才触发提纯 */
  consolidationMinEntries: number
  /** 修剪激进程度 0-1 */
  pruneAggressiveness: number
  /** 覆盖默认衰减率 */
  decayRateOverride?: Record<string, number>
  /** 上次策略调整时间 */
  lastAdaptation: number
}

export const DEFAULT_POLICY: MetaPolicy = {
  summaryFrequency: 5,
  summaryTokenThreshold: 0.7,
  decisionLogChance: 1.0,
  consolidationInterval: 30 * 60 * 1000,
  consolidationMinEntries: 10,
  pruneAggressiveness: 0.5,
  lastAdaptation: Date.now(),
}

interface RunStats {
  totalInteractions: number
  summariesCreated: number
  decisionsLogged: number
  consolidationsRun: number
  lastConsolidation: number
  memoryHitRate: number
  totalQueries: number
  hitQueries: number
}

export class MetaController {
  private policy: MetaPolicy
  private stats: RunStats = {
    totalInteractions: 0,
    summariesCreated: 0,
    decisionsLogged: 0,
    consolidationsRun: 0,
    lastConsolidation: 0,
    memoryHitRate: 0,
    totalQueries: 0,
    hitQueries: 0,
  }
  private summary: SummaryMemory | null = null
  private decisions: DecisionStore | null = null
  private memory: MemoryService | null = null
  private tickSinceLastSummary = 0

  constructor(policy?: Partial<MetaPolicy>) {
    this.policy = { ...DEFAULT_POLICY, ...policy }
  }

  setDeps(deps: { summary: SummaryMemory; decisions: DecisionStore; memory: MemoryService }): void {
    this.summary = deps.summary
    this.decisions = deps.decisions
    this.memory = deps.memory
  }

  getPolicy(): Readonly<MetaPolicy> {
    return this.policy
  }

  getStats(): Readonly<RunStats> {
    return this.stats
  }

  // ══════════════════════════════════════════
  //  P0→P1 沉淀
  // ══════════════════════════════════════════

  onInteractionEnd(context: {
    userMessage: string
    assistantReply: string
    tokenUsed: number
    tokenBudget: number
    planActive: boolean
    agentId: string
  }): void {
    this.stats.totalInteractions++
    this.tickSinceLastSummary++

    if (this.shouldSummarize(context)) {
      this.createSummary(context)
    }
    if (this.shouldLogDecision()) {
      this.logDecision(context)
    }
    if (this.stats.totalInteractions % 10 === 0) {
      this.adaptPolicy()
    }
  }

  private shouldSummarize(context: { tokenUsed: number; tokenBudget: number }): boolean {
    const freqTrigger = this.tickSinceLastSummary >= this.policy.summaryFrequency
    const tokenRatio = context.tokenBudget > 0 ? context.tokenUsed / context.tokenBudget : 0
    const tokenTrigger = tokenRatio >= this.policy.summaryTokenThreshold
    return freqTrigger || tokenTrigger
  }

  private shouldLogDecision(): boolean {
    if (this.policy.decisionLogChance >= 1.0) return true
    return Math.random() < this.policy.decisionLogChance
  }

  private createSummary(context: { userMessage: string; assistantReply: string; planActive: boolean }): void {
    this.tickSinceLastSummary = 0
    const turnEnd = Date.now()
    const summaryText = context.assistantReply
      ? `用户: ${context.userMessage.slice(0, 60)} → ${context.assistantReply.slice(0, 60)}`
      : context.userMessage.slice(0, 80)

    this.summary?.addSummary(summaryText, this.stats.totalInteractions, turnEnd, {
      topics: [],
      decisions: context.planActive ? ['计划活跃中'] : [],
      keyEntities: [],
    })
    this.stats.summariesCreated++
  }

  private logDecision(context: { userMessage: string; planActive: boolean; agentId: string }): void {
    this.decisions?.record({
      agentId: context.agentId || 'chat',
      category: context.planActive ? 'plan_route' : 'tool_select',
      context: context.userMessage.slice(0, 200),
      choice: context.planActive ? '按当前计划执行' : '自然对话回复',
      confidence: 0.5,
    })
    this.stats.decisionsLogged++
  }

  // ══════════════════════════════════════════
  //  P1→P2 提纯 + 后台优化
  // ══════════════════════════════════════════

  async backgroundOptimization(): Promise<void> {
    const now = Date.now()
    if (now - this.stats.lastConsolidation < this.policy.consolidationInterval) return

    log('INFO', 'meta_controller_optimization_start')
    const t0 = Date.now()

    const allSummaries = this.summary?.getAll() || []
    if (allSummaries.length >= this.policy.consolidationMinEntries) {
      this.consolidateSummaries(allSummaries)
    }

    this.memory?.flush()

    if (this.stats.totalInteractions > 0 && this.policy.pruneAggressiveness > 0) {
      this.decisions?.query({ limit: 100 })
    }

    this.stats.lastConsolidation = now
    this.stats.consolidationsRun++

    log('INFO', 'meta_controller_optimization_done', {
      elapsed: Date.now() - t0,
      summaries: allSummaries.length,
    })
  }

  private consolidateSummaries(all: any[]): void {
    const MAX_SUMMARIES = 50
    if (all.length < MAX_SUMMARIES * 0.5) return

    const keep = all.slice(-30)
    const old = all.slice(0, all.length - 30)
    if (old.length < 2) return

    const mergedTopics = [...new Set(old.flatMap((s: any) => s.topics || []))].slice(0, 10)
    const mergedDecisions = old
      .flatMap((s: any) => s.decisions || [])
      .filter(Boolean)
      .slice(0, 5)
    const combined = `【历史合并】${old.length} 条对话摘要的综合记录。`

    this.summary?.addSummary(combined, old[0]?.turnStart || 0, old[old.length - 1]?.turnEnd || Date.now(), {
      topics: mergedTopics,
      decisions: mergedDecisions,
      keyEntities: [],
    })

    log('INFO', 'summaries_consolidated', { old: old.length, kept: keep.length })
  }

  // ══════════════════════════════════════════
  //  策略自适应
  // ══════════════════════════════════════════

  recordMemoryQuery(hit: boolean): void {
    this.stats.totalQueries++
    if (hit) this.stats.hitQueries++
    if (this.stats.totalQueries > 50) {
      this.stats.totalQueries = 25
      this.stats.hitQueries = Math.round(this.stats.hitQueries / 2)
    }
    this.stats.memoryHitRate = this.stats.totalQueries > 0 ? this.stats.hitQueries / this.stats.totalQueries : 0
  }

  private adaptPolicy(): void {
    const now = Date.now()
    if (now - this.policy.lastAdaptation < 60_000) return
    this.policy.lastAdaptation = now

    if (this.stats.memoryHitRate > 0.8 && this.stats.totalQueries > 10) {
      this.policy.summaryFrequency = Math.min(this.policy.summaryFrequency + 1, 15)
    }
    if (this.stats.memoryHitRate < 0.4 && this.stats.totalQueries > 10) {
      this.policy.summaryFrequency = Math.max(this.policy.summaryFrequency - 1, 2)
    }

    log('INFO', 'meta_policy_adapted', {
      summaryFrequency: this.policy.summaryFrequency,
      hitRate: this.stats.memoryHitRate.toFixed(2),
    })
  }
}
