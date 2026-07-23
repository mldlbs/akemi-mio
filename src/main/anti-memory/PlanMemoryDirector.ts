/**
 * PlanMemoryDirector — Plan → Memory 反转原型
 *
 * 【核心思想】
 * 反转 Memory ↔ Plan 的默认关系：
 * - 传统模式：Memory 是主动上下文来源（提供优先级/兴趣分布/画像），Plan 是被动消费者
 * - 反转模式：Plan 是主动指令源（指定聚焦领域/高优话题），Memory 是被动响应者
 *
 * 【五个假设前提及其反转】
 *   见 getAntiMemoryAssumptions() 和本模块各方法的注释。
 *
 * 【选定的原型方向】
 * 反转假设 A1（主从关系）+ A3（决策权）：
 *   "Plan 决定重要性 → Memory 重新排序"。
 *   理由：现有架构中 Memory 的 getTargetedEvolutionPriorities() 已经实现了
 *   Memory→Plan 的优先级传递，反转这个方向能最小代价验证新模式的可行性。
 *
 * 【使用方式】
 *   import { planMemoryDirector } from '../anti-memory'
 *
 *   // Plan 执行完毕后，主动告诉 Memory 其领域范围
 *   planMemoryDirector.syncPlanScope({
 *     activeDomains: ['radar_merge', 'songge_backup', 'blog_analysis'],
 *     domainTopics: { radar_merge: ['创业', 'AI', '融资'], ... },
 *     highValueKeywords: ['startup', '投资', '工业颂歌'],
 *     lastPlanRunAt: Date.now(),
 *     directives: [],
 *   })
 *
 *   // 获取 Plan 驱动的记忆上下文（Memory 的排序受 Plan 范围影响）
 *   const planCtx = planMemoryDirector.getPlanDrivenContext()
 *   // → 优先返回与当前 Plan 领域相关的记忆
 */

import { log } from '../logger/Logger'
import { eventBus } from '../core/EventBus'
import { getMemoryService, getPlanManager } from '../tool/deps'
import type { DevPlan } from '../evolution/types'
import type { PlanParallelOutput } from '../pipeline/stages/PlanParallelAdvancementStage'
import type {
  PlanDomain,
  MemoryDirective,
  MemoryDirectiveAction,
  PlanScopeSnapshot,
  PlanDrivenMemoryContext,
  PlanMemoryDirectorConfig,
  AssumptionInversion,
} from './types'
import { DEFAULT_DIRECTOR_CONFIG } from './types'

// ══════════════════════════════════════════════════════════════════
// 常量
// ══════════════════════════════════════════════════════════════════

/** 领域名称映射（中文标签） */
const DOMAIN_LABELS: Record<PlanDomain, string> = {
  radar_merge: '雷达合并',
  songge_backup: '工业颂歌备份',
  blog_analysis: '博客分析',
}

/** 领域 → 默认话题标签（当 Plan 未提供明确话题时使用） */
const DOMAIN_DEFAULT_TOPICS: Record<PlanDomain, string[]> = {
  radar_merge: ['创业', 'startup', '融资', 'AI', '技术趋势'],
  songge_backup: ['工业颂歌', '排版', '公众号', '内容备份', '写作'],
  blog_analysis: ['博客', '写作', '内容策略', '平台运营', '数据分析'],
}

// ══════════════════════════════════════════════════════════════════
// 五个假设前提的反转分析
// ══════════════════════════════════════════════════════════════════

/**
 * 获取 Memory ↔ Plan 关系的五个假设前提及其反转版本。
 *
 * 【被分析的 Plan】
 *   "并行推进：雷达合并 + 工业颂歌备份 + 博客分析"
 *   对应 Pipeline Stage: PlanParallelAdvancementStage
 *
 * 【分析结果摘要】
 *   反转方向 A1+A3（决策权反转）被选为原型实现方向。
 *   见本类方法的实现 detail。
 */
export function getAntiMemoryAssumptions(): AssumptionInversion[] {
  return [
    {
      original: 'A1 [主从关系] Memory 是主（上下文来源/画像/兴趣分布），Plan 是从（被动消费这些信息的执行者）',
      inversed: 'Plan 是主（主动指定聚焦领域和优先级），Memory 是从（被动按 Plan 指令排序输出）',
      feasibility: 'high',
      scope: 'MemoryEvolutionBridge + MemoryService.getFormattedContext 的排序逻辑',
      risks: [
        'Plan 指令可能覆盖用户的真实长期兴趣分布',
        'Plan 活跃度波动导致 Memory 输出剧烈变化',
        '与 Memory 自身的行为加权系统可能冲突',
      ],
      value: '使 Memory 的输出上下文与当前任务高度对齐，减少无关记忆干扰',
    },
    {
      original: 'A2 [执行顺序] Memory 先加载完整上下文 → Plan 在此上下文中选择要执行的步骤',
      inversed: 'Plan 先确定要执行的步骤 → Memory 仅加载与步骤相关的上下文子集',
      feasibility: 'medium',
      scope: 'ChatExecutor.refreshMemory → PlanManager.getFormattedContext → MemoryService.getFormattedContext 的调用链',
      risks: [
        '按需加载可能导致 Plan 遗漏关键的跨域关联信息',
        '需要在 Plan 步骤定义中标注所需的记忆类型',
        '冷启动场景下 Plan 尚未确定时无法提供上下文',
      ],
      value: '大幅减少注入到 LLM 的无关记忆量，降低 token 消耗和上下文噪声',
    },
    {
      original: 'A3 [决策权] Memory 决定什么重要（通过置信度/行为得分/效用分数），Plan 遵循这些优先级排序',
      inversed: 'Plan 决定什么重要（通过当前任务的聚焦领域），Memory 按 Plan 优先级重新排序输出',
      feasibility: 'high',
      scope: 'MemoryService.getBehaviorWeightedEntries → PlanMemoryDirector.applyDirectives',
      risks: [
        'Plan 过于狭窄时可能屏蔽有价值但不直接相关的记忆',
        '多个 active Plan 的优先级冲突需要仲裁',
      ],
      value: '让记忆排序从"用户长期行为驱动"进化为"用户当前任务驱动"，提升即时相关性',
    },
    {
      original: 'A4 [范围控制] Memory 存储全部交互数据（通用范围）→ Plan 从完整数据中过滤所需子集',
      inversed: 'Plan 定义存储范围和老化策略 → Memory 仅保留与 Plan 相关的数据',
      feasibility: 'low',
      scope: 'MemoryService.prune → MemoryCleaner → MemoryService.addEntry 的存储策略',
      risks: [
        'Plan 不完整时可能导致大量潜在有用的记忆被过早清除',
        '违反"Memory 是长期累积"的基本设计假设',
        '用户切换任务时历史数据已丢失，无法恢复',
      ],
      value: '显著降低 Memory 存储膨胀，专注存储与当前项目目标一致的数据',
    },
    {
      original: 'A5 [生命周期] Memory 是长期累积的（永久层/半永久层/临时层的衰减模型），Plan 是短期任务绑定（完成后归档/冻结）',
      inversed: 'Plan 是结构化组织原则（内存按 Plan 上下文分段），Memory 是 Plan 的执行档案（每条记忆携带所属 Plan ID）',
      feasibility: 'medium',
      scope: 'MemoryEntry.structuredData 中的 planId 字段 → MemoryUnifiedQuery 的 Plan 级联查询',
      risks: [
        '需要改造 MemoryEntry 类型，增加 planId 和 planDomain 字段',
        '跨 Plan 的记忆共享需要额外的引用计数机制',
        'Plan 取消后其关联的记忆需要重新分配归属',
      ],
      value: '记忆可按 Plan 维度查询和检索，支持"这个 Plan 中我们学到了什么"的复盘能力',
    },
  ]
}

// ══════════════════════════════════════════════════════════════════
// PlanMemoryDirector
// ══════════════════════════════════════════════════════════════════

export class PlanMemoryDirector {
  private config: PlanMemoryDirectorConfig
  private scopeSnapshot: PlanScopeSnapshot | null = null

  /** 活跃指令列表（含来自 Plan 的显式指令和内部派生的隐式指令） */
  private activeDirectives: Map<string, MemoryDirective> = new Map()

  constructor(config?: Partial<PlanMemoryDirectorConfig>) {
    this.config = { ...DEFAULT_DIRECTOR_CONFIG, ...config }
    log('INFO', 'plan_memory_director_created', { enabled: this.config.enabled })
  }

  // ══════════════════════════════════════════════════════════════
  // 核心 API：Plan → Memory 反转
  // ══════════════════════════════════════════════════════════════

  /**
   * 【反转 A1+A3】同步 Plan 的当前执行范围到 Director。
   *
   * 传统方向：Memory 提供兴趣分布 → Plan 决定做什么
   * 反转方向：Plan 告诉 Director 当前做什么 → Memory 按 Plan 范围排序输出
   *
   * 应在 PlanParallelAdvancementStage 完成执行后调用。
   */
  syncPlanScope(scope: PlanScopeSnapshot): void {
    if (!this.config.enabled) return

    this.scopeSnapshot = {
      ...scope,
      lastPlanRunAt: Date.now(),
    }

    // 将 Plan 范围转换为 Memory 指令
    this.deriveDirectivesFromScope(scope)

    // 发射事件供外部监控
    eventBus.emit('plan_memory_scope_synced', {
      version: 1,
      activeDomains: scope.activeDomains,
      directiveCount: this.activeDirectives.size,
      timestamp: Date.now(),
    })

    log('INFO', 'plan_memory_scope_synced', {
      domains: scope.activeDomains.join(','),
      directives: this.activeDirectives.size,
      keywords: scope.highValueKeywords.length,
    })
  }

  /**
   * 【反转 A3】将 Plan 并行执行结果同步到 Memory 指令。
   *
   * 该方法分析 PlanParallelAdvancementStage 的输出，
   * 提取高价值信号/洞察，转换为对 Memory 的优先级指令。
   *
   * 这是反转的核心：Plan 的输出结果直接影响 Memory 的排序策略。
   */
  syncPlanOutput(planOutput: PlanParallelOutput): void {
    if (!this.config.enabled) return
    const now = Date.now()
    const ttl = this.config.defaultDirectiveTtlMs

    // 从雷达合并结果提取高价值信号话题
    if (planOutput.radarMerge.success && planOutput.radarMerge.topSignals.length > 0) {
      for (const signal of planOutput.radarMerge.topSignals.slice(0, 3)) {
        const topic = signal.title.slice(0, 30)
        this.activeDirectives.set(`radar_${signal.id}`, {
          action: 'boost',
          topic,
          intensity: Math.min(signal.compositeScore, this.config.maxBoostIntensity),
          reason: `雷达合并检测到高价值信号: ${signal.category}`,
          domain: 'radar_merge',
          expiresAt: now + ttl,
        })
      }
    }

    // 从工业颂歌备份提取内容质量问题话题
    if (planOutput.songgeBackup.success && planOutput.songgeBackup.totalIssues > 0) {
      for (const [category, count] of Object.entries(planOutput.songgeBackup.issueCategories)) {
        const boostIntensity = Math.min(count / 10, this.config.maxBoostIntensity)
        this.activeDirectives.set(`songge_${category}`, {
          action: count > 5 ? 'boost' : 'pin',
          topic: `工业颂歌_${category}`,
          intensity: boostIntensity,
          reason: `工业颂歌备份检测到 ${count} 个 "${category}" 类问题`,
          domain: 'songge_backup',
          expiresAt: now + ttl,
        })
      }
    }

    // 从博客分析提取策略话题
    if (planOutput.blogAnalysis.success && planOutput.blogAnalysis.insights.length > 0) {
      for (let i = 0; i < Math.min(planOutput.blogAnalysis.insights.length, 3); i++) {
        const insight = planOutput.blogAnalysis.insights[i]
        this.activeDirectives.set(`blog_insight_${i}`, {
          action: 'boost',
          topic: `博客分析_${insight.slice(0, 20)}`,
          intensity: 0.4,
          reason: `博客分析洞察: ${insight.slice(0, 60)}`,
          domain: 'blog_analysis',
          expiresAt: now + ttl,
        })
      }
    }

    log('INFO', 'plan_memory_output_synced', {
      totalDirectives: this.activeDirectives.size,
      radarTopics: planOutput.radarMerge.topSignals.length,
      songgeCategories: Object.keys(planOutput.songgeBackup.issueCategories).length,
      blogInsights: planOutput.blogAnalysis.insights.length,
    })
  }

  /**
   * 【反转 A3】获取受 Plan 指令影响的 Memory 上下文。
   *
   * 传统：MemoryService.getFormattedContext() 按行为得分排序
   * 反转：按 Plan 指令优先级重新排序，Plan 领域相关的记忆排在前面
   *
   * 这是对外的主要输出接口——consumers 使用此方法而非直接调用 MemoryService。
   */
  getPlanDrivenContext(): PlanDrivenMemoryContext {
    this.cleanExpiredDirectives()

    const memoryService = getMemoryService()
    const planManager = getPlanManager()
    if (!memoryService) {
      return { activePlanDomains: [], planScopedMemories: [], suppressedTopics: [] }
    }

    // 获取当前活跃 Plan 的领域标签
    const activePlanDomains = this.getActivePlanDomains(planManager)

    // 获取所有记忆条目
    const allEntries = memoryService.getEntries()
    const userFactEntries = allEntries.filter((e) => e.type === 'user_fact')

    // 【反转核心】按 Plan 指令重新排序记忆：
    // 不再只使用 Memory 的行为得分，而是混合 Plan 相关性得分
    const planScoredEntries = userFactEntries.map((entry) => {
      const planRelevance = this.computePlanRelevance(entry.content, entry.topics || [])
      // 混合得分 = (1 - w) × memoryScore + w × planRelevance
      // 其中 w 由当前活跃 Plan 的强度决定（有 active Plan 时 w 增大）
      const hasActiveDirectives = this.activeDirectives.size > 0
      const planWeight = hasActiveDirectives ? 0.4 : 0.0 // 有 Plan 时倾斜 40%
      const memoryScore = memoryService.getEffectiveScore(entry)
      const blendedScore = (1 - planWeight) * memoryScore + planWeight * planRelevance

      return { entry, planRelevance, blendedScore }
    })

    // 按混合得分降序排列
    planScoredEntries.sort((a, b) => b.blendedScore - a.blendedScore)

    // 取 top 10
    const topPlanScored = planScoredEntries.slice(0, 10)

    // 收集被抑制的话题（用于审计）
    const suppressedTopics = this.collectSuppressedTopics(planScoredEntries, userFactEntries)

    return {
      activePlanDomains,
      planScopedMemories: topPlanScored.map((s) => ({
        content: s.entry.content,
        planRelevance: s.planRelevance,
        domain: this.inferDomainFromContent(s.entry.content),
        originalConfidence: s.entry.confidence,
      })),
      suppressedTopics,
    }
  }

  // ══════════════════════════════════════════════════════════════
  // 格式化输出
  // ══════════════════════════════════════════════════════════════

  /**
   * 获取受 Plan 驱动的格式化记忆上下文（替代 MemoryService.getFormattedContext）。
   *
   * 返回格式化的字符串，可直接注入 system prompt。
   * 这是传统 Memory → Plan 方向中 getFormattedContext 的反转版本。
   */
  getFormattedPlanDrivenContext(): string {
    const ctx = this.getPlanDrivenContext()
    if (ctx.planScopedMemories.length === 0) return ''

    const parts: string[] = [
      '---',
      '【反记忆：Plan 驱动的上下文】',
      '以下记忆已按当前活跃 Plan 领域重新排序，优先展示与 Plan 任务相关的信息：',
      '',
      `当前 Plan 活跃领域：${ctx.activePlanDomains.join('、') || '（无）'}`,
      '',
    ]

    // 按领域分组展示
    const byDomain: Record<string, typeof ctx.planScopedMemories> = {}
    for (const mem of ctx.planScopedMemories) {
      const domain = mem.domain || 'unknown'
      if (!byDomain[domain]) byDomain[domain] = []
      byDomain[domain].push(mem)
    }

    for (const [domain, mems] of Object.entries(byDomain)) {
      const label = DOMAIN_LABELS[domain as PlanDomain] || domain
      parts.push(`[${label} 相关]`)
      for (const mem of mems) {
        parts.push(`  - ${mem.content.slice(0, 100)} (Plan 相关性: ${(mem.planRelevance * 100).toFixed(0)}%)`)
      }
      parts.push('')
    }

    if (ctx.suppressedTopics.length > 0) {
      parts.push(`[被抑制的话题] ${ctx.suppressedTopics.join('、')}`)
      parts.push('')
    }

    parts.push('---')
    return parts.join('\n')
  }

  // ══════════════════════════════════════════════════════════════
  // 工具方法
  // ══════════════════════════════════════════════════════════════

  /** 获取当前 Director 状态（用于监控/审计） */
  getStatus(): { config: PlanMemoryDirectorConfig; directiveCount: number; hasScope: boolean; lastSyncedAt: number | null } {
    return {
      config: this.config,
      directiveCount: this.activeDirectives.size,
      hasScope: this.scopeSnapshot !== null,
      lastSyncedAt: this.scopeSnapshot?.lastPlanRunAt ?? null,
    }
  }

  /** 清除所有 Plan 指令（恢复到 Memory 默认排序） */
  clearDirectives(): void {
    this.activeDirectives.clear()
    log('INFO', 'plan_memory_directives_cleared')
  }

  /** 更新配置 */
  updateConfig(partial: Partial<PlanMemoryDirectorConfig>): void {
    this.config = { ...this.config, ...partial }
    log('INFO', 'plan_memory_director_config_updated', {
      enabled: this.config.enabled,
    })
  }

  // ══════════════════════════════════════════════════════════════
  // 内部实现
  // ══════════════════════════════════════════════════════════════

  /** 从 Plan 范围派生出隐式指令 */
  private deriveDirectivesFromScope(scope: PlanScopeSnapshot): void {
    const now = Date.now()
    const ttl = this.config.defaultDirectiveTtlMs

    for (const domain of scope.activeDomains) {
      const topics = scope.domainTopics[domain] || DOMAIN_DEFAULT_TOPICS[domain] || []
      for (const topic of topics) {
        const directiveKey = `domain_${domain}_${topic}`
        this.activeDirectives.set(directiveKey, {
          action: 'boost',
          topic,
          intensity: 0.3,
          reason: `Plan 领域「${DOMAIN_LABELS[domain]}」活跃，提升相关话题优先级`,
          domain,
          expiresAt: now + ttl,
        })
      }
    }

    // Plan 的高价值关键词 → boost
    for (const keyword of scope.highValueKeywords) {
      const directiveKey = `keyword_${keyword}`
      this.activeDirectives.set(directiveKey, {
        action: 'boost',
        topic: keyword,
        intensity: 0.35,
        reason: 'Plan 产生的高价值关键词',
        domain: 'radar_merge',
        expiresAt: now + ttl,
      })
    }
  }

  /** 清除过期指令 */
  private cleanExpiredDirectives(): void {
    const now = Date.now()
    let removed = 0
    for (const [key, directive] of this.activeDirectives) {
      if (directive.expiresAt > 0 && now > directive.expiresAt) {
        this.activeDirectives.delete(key)
        removed++
      }
    }
    if (removed > 0) {
      log('INFO', 'plan_memory_directives_expired', { removed, remaining: this.activeDirectives.size })
    }
  }

  /** 计算记忆内容与 Plan 领域的相关性得分 (0–1) */
  private computePlanRelevance(content: string, topics: string[]): number {
    if (this.activeDirectives.size === 0) return 0

    const lowerContent = content.toLowerCase()
    let maxScore = 0

    for (const [, directive] of this.activeDirectives) {
      if (directive.action === 'suppress') continue

      const topicLower = directive.topic.toLowerCase()
      let matchScore = 0

      // 直接包含话题关键词
      if (lowerContent.includes(topicLower)) {
        matchScore = directive.intensity * 1.0
      }

      // topics 字段匹配
      const topicMatch = topics.some((t) => t.toLowerCase().includes(topicLower) || topicLower.includes(t.toLowerCase()))
      if (topicMatch) {
        matchScore = Math.max(matchScore, directive.intensity * 0.8)
      }

      maxScore = Math.max(maxScore, matchScore)
    }

    return Math.min(maxScore, 1.0)
  }

  /** 从记忆内容推断领域标签 */
  private inferDomainFromContent(content: string): PlanDomain {
    const lower = content.toLowerCase()
    if (lower.includes('startup') || lower.includes('创业') || lower.includes('融资') || lower.includes('radar')) {
      return 'radar_merge'
    }
    if (lower.includes('工业颂歌') || lower.includes('排版') || lower.includes('公众号') || lower.includes('songge')) {
      return 'songge_backup'
    }
    if (lower.includes('博客') || lower.includes('blog') || lower.includes('写作') || lower.includes('内容')) {
      return 'blog_analysis'
    }
    return 'radar_merge' // 默认
  }

  /** 获取当前活跃 Plan 的领域标签列表 */
  private getActivePlanDomains(planManager: any): string[] {
    try {
      const activePlan = planManager?.getActivePlan?.() as DevPlan | undefined
      if (!activePlan) return []

      const title = activePlan.title
      if (title.includes('雷达合并') || title.includes('radar')) return ['雷达合并']
      if (title.includes('工业颂歌') || title.includes('songge')) return ['工业颂歌备份']
      if (title.includes('博客分析') || title.includes('blog')) return ['博客分析']
      if (title.includes('并行推进')) return ['雷达合并', '工业颂歌备份', '博客分析']

      return [title.slice(0, 20)]
    } catch {
      return []
    }
  }

  /** 收集被 Plan 指令抑制的话题列表 */
  private collectSuppressedTopics(
    scored: Array<{ entry: any; planRelevance: number }>,
    all: any[],
  ): string[] {
    if (this.activeDirectives.size === 0) return []

    // 找出被 Plan 领域覆盖的记忆（高相关性）和被忽略的记忆（低相关性）
    const highRelevanceIds = new Set(scored.filter((s) => s.planRelevance > 0.3).map((s) => s.entry.id))

    // 从全部记忆中找到不在高相关集合中且原本得分不低的条目
    const suppressed: string[] = []
    for (const entry of all) {
      if (highRelevanceIds.has(entry.id)) continue
      if (entry.confidence > 0.7 && entry.tier === 'permanent') {
        // 永久层高置信度内容即使被 Plan 忽略也应该提及
        continue
      }
      if (entry.behaviorScore > 0.6 && entry.tier !== 'ephemeral') {
        // 原 Memory 认为重要的但 Plan 不关注的 → 被抑制
        const contentShort = entry.content.slice(0, 30)
        if (!suppressed.includes(contentShort)) {
          suppressed.push(contentShort)
        }
      }
    }

    return suppressed.slice(0, 5)
  }
}

/** 模块级单例 */
export const planMemoryDirector = new PlanMemoryDirector()
