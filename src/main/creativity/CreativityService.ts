import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve } from 'path'
import { log } from '../logger/Logger'
import { eventBus, EventBus } from '../core/EventBus'
import { IdeaGenerator } from './IdeaGenerator'
import { WorldTrendProvider } from './WorldTrendProvider'
import { SourceBuilder } from './SourceBuilder'
import { evaluateNovelty } from './NoveltyScorer'
import type { CreativitySource, CreativeIdea, DreamCycleLog, IdeaStoreLike } from './types'
import { DREAM_CYCLE_INTERVAL_MS, NORMAL_CYCLE_INTERVAL_MS } from './types'
import type { TaskRunner } from '../core/tasks/unified/TaskRunner'

/**
 * CreativityService — 创造力引擎
 *
 * 职责：
 * - 收集多个来源的概念
 * - 周期性触发概念重组（LLM 驱动）
 * - 管理 Hypothesis 生命周期
 * - 在低负载时段进入 Dream Mode
 *
 * 这不是分析系统（Insight），这是发明系统。
 * 分析：发现问题
 * 创造：创造新东西
 */
export class CreativityService {
  private generator: IdeaGenerator
  private store: IdeaStoreLike
  private eventBus: EventBus
  private normalTimer: ReturnType<typeof setInterval> | null = null
  private dreamTimer: ReturnType<typeof setInterval> | null = null
  private reportDir: string
  private taskRunner?: TaskRunner
  private taskRunnerKeys: string[] = []
  private sourceBuilder: SourceBuilder
  private worldTrendProvider: WorldTrendProvider | null

  /** 最近一次进化系统执行结果（Phase 3 反馈） */
  private evolutionOutcome: { success: boolean; summary: string; planTitle?: string } | null = null
  private evolutionDisposer: (() => void) | null = null

  /** 用户正在对话中 — 跳过创造性周期避免抢占 LLM */
  private conversationActive = false

  private getSources: () => CreativitySource[]
  private getInsights: () => { title: string; description: string; score: number }[]
  private getFailedHypotheses: () => { title: string; idea: string; risk: string }[]

  constructor(
    store: IdeaStoreLike,
    deps: {
      getSources: () => CreativitySource[]
      getInsights: () => { title: string; description: string; score: number }[]
      getFailedHypotheses: () => { title: string; idea: string; risk: string }[]
    },
    chatJson: (
      userText: string,
      options?: { system?: string; temperature?: number; timeoutMs?: number; requestId?: string },
    ) => Promise<{ data?: any; error?: string }>,
    temperature = 0.3,
    seed?: number,
    bus?: EventBus,
    reportDir = '',
    taskRunner?: TaskRunner,
    observerDir?: string,
  ) {
    this.store = store
    this.generator = new IdeaGenerator(chatJson, temperature, seed)
    this.eventBus = bus || eventBus
    this.reportDir = reportDir
    this.taskRunner = taskRunner

    this.getSources = deps.getSources
    this.getInsights = deps.getInsights
    this.getFailedHypotheses = deps.getFailedHypotheses
    this.sourceBuilder = new SourceBuilder(seed)
    this.worldTrendProvider = observerDir ? new WorldTrendProvider(observerDir) : null

    // 对话期间不触发创造力周期，避免抢占 LLM 资源
    this.eventBus.on('agent.input.received', () => {
      this.conversationActive = true
    })
    this.eventBus.on('agent.response.generated', () => {
      this.conversationActive = false
    })
    // 超时保护：最长 5 分钟后自动放行
    setInterval(
      () => {
        this.conversationActive = false
      },
      5 * 60 * 1000,
    )

    // Phase 3: 订阅进化系统执行结果反馈
    this.evolutionDisposer = this.eventBus.on('evolution.plan.outcome' as any, (p: any) => {
      this.evolutionOutcome = {
        success: p.success,
        summary: p.summary || '',
        planTitle: p.planTitle,
      }
    })
  }

  start(): void {
    if (this.taskRunner) {
      this.taskRunner.register(
        'creativity.cycle',
        async () => {
          await this.cycle()
          return { success: true }
        },
        NORMAL_CYCLE_INTERVAL_MS,
      )
      this.taskRunner.register(
        'creativity.dream',
        async () => {
          await this.dreamCycle()
          return { success: true }
        },
        DREAM_CYCLE_INTERVAL_MS,
      )
      this.taskRunnerKeys = ['creativity.cycle', 'creativity.dream']
      return
    }

    // Fallback: setInterval（无 TaskRunner 时）
    if (this.normalTimer) return
    this.normalTimer = setInterval(() => {
      this.cycle()
    }, NORMAL_CYCLE_INTERVAL_MS)
    this.dreamTimer = setInterval(() => {
      this.dreamCycle()
    }, DREAM_CYCLE_INTERVAL_MS)
    log('INFO', 'creativity_service_started', {
      normal_interval_ms: NORMAL_CYCLE_INTERVAL_MS,
      dream_interval_ms: DREAM_CYCLE_INTERVAL_MS,
    })
  }

  stop(): void {
    if (this.taskRunner) {
      for (const key of this.taskRunnerKeys) {
        this.taskRunner.stopType(key as any)
      }
      this.taskRunnerKeys = []
      return
    }

    if (this.normalTimer) {
      clearInterval(this.normalTimer)
      this.normalTimer = null
    }
    if (this.dreamTimer) {
      clearInterval(this.dreamTimer)
      this.dreamTimer = null
    }
    log('INFO', 'creativity_service_stopped')
  }

  /**
   * 正常创造力周期
   */
  private async cycle(): Promise<void> {
    if (this.conversationActive) return
    let sources = this.getSources()

    // 注入 Observer 世界趋势和洞察
    if (this.worldTrendProvider) {
      const trends = this.worldTrendProvider.getTrends()
      const insights = this.worldTrendProvider.getInsights()
      if (trends.length > 0 || insights.length > 0) {
        const observerSources = this.sourceBuilder.build({ observer: { trends, insights } }, [], trends)
        const worldSources = observerSources.filter((s) => s.type === 'provocation' || s.type === 'insight')
        sources = [...sources, ...worldSources]
      }
    }

    // Phase 3: 注入进化系统反馈作为来源
    if (this.evolutionOutcome) {
      const outcome = this.evolutionOutcome
      sources.push({
        name: outcome.success ? '进化:可行方案' : '进化:失败尝试',
        content: outcome.success
          ? `进化系统最近执行了计划"${outcome.planTitle || '(分析)'}"并成功完成: ${outcome.summary.slice(0, 200)}`
          : `进化系统最近的分析/执行未成功: ${outcome.summary.slice(0, 200)}`,
        type: outcome.success ? 'knowledge' : 'failure',
        weight: outcome.success ? 0.8 : 0.6,
      })
      this.evolutionOutcome = null // 消费后清除
    }

    if (sources.length < 2) return

    log('INFO', 'creativity_cycle_start', { source_count: sources.length })
    this.eventBus.emit('creativity.cycle.started', {})

    // 推送已探索配对给 Mixer 用于降权
    this.generator.setExploredPairs(this.store.getExploredPairs())

    const ideas = await this.generator.generateIdeas(sources)

    if (ideas.length === 0) {
      log('INFO', 'creativity_cycle_empty')
      this.eventBus.emit('creativity.cycle.completed', { count: 0, hasValue: false })
      return
    }

    // Phase 5: 代码层新颖度评估 — 替代纯标题去重
    const recent = this.store.getHypotheses({ limit: 30 })
    const rejected = this.store.getHypotheses({ status: 'rejected', limit: 50 })
    const passed: CreativeIdea[] = []
    const rejectedIdeas: CreativeIdea[] = []
    for (const idea of ideas) {
      const verdict = evaluateNovelty(
        { title: idea.hypothesis.title, idea: idea.hypothesis.idea, novelty: idea.hypothesis.novelty },
        recent.map((h) => ({ title: h.title, idea: h.idea, novelty: h.novelty })),
        rejected.map((h) => ({ title: h.title, idea: h.idea })),
      )
      if (verdict.shouldReject) {
        rejectedIdeas.push(idea)
        log('INFO', 'creativity_novelty_rejected', {
          title: idea.hypothesis.title,
          reason: verdict.rejectReason,
        })
        continue
      }
      idea.hypothesis.novelty = verdict.adjustedNovelty
      passed.push(idea)
    }

    if (passed.length === 0) {
      log('INFO', 'creativity_cycle_all_rejected', { noveltyRejected: rejectedIdeas.length })
      this.eventBus.emit('creativity.cycle.completed', { count: rejectedIdeas.length, hasValue: false })
      return
    }
    const deduped = passed

    this.persist(deduped)
    this.reportCycle(deduped)
    this.report(deduped)

    // 记录本轮配对为已探索，避免重复
    for (const idea of deduped) {
      const labels = idea.hypothesis.sourceLabels
      if (labels.length >= 2) {
        this.store.addExploredPair(labels[0], labels[1])
      }
    }

    // Phase 2: 高综合分假设 → 通知进化系统
    const topIdea = deduped.reduce(
      (best, i) => {
        const score = i.hypothesis.novelty + i.hypothesis.feasibility + i.hypothesis.impact
        return score > (best.score || 0) ? { idea: i, score } : best
      },
      { idea: null as any, score: 0 },
    )
    if (topIdea.idea && topIdea.score > 220) {
      const h = topIdea.idea.hypothesis
      this.eventBus.emit('creativity.hypothesis.selected', {
        id: h.id,
        title: h.title,
        idea: h.idea,
        novelty: h.novelty,
        feasibility: h.feasibility,
        impact: h.impact,
        sourceLabels: h.sourceLabels,
        expectedBenefit: h.expectedBenefit,
        risk: h.risk,
      })
    }

    this.eventBus.emit('creativity.cycle.completed', { count: deduped.length, hasValue: true })
  }

  /**
   * 梦境创造力周期 — 更高随机性、纳入失败历史
   */
  private async dreamCycle(): Promise<void> {
    if (this.conversationActive) return
    const recentSources = this.getSources()
    const historicalCombos = this.store.getRecentCombos(30)
    const failedHypotheses = this.store.getHypotheses({ status: 'rejected' }).map((h) => ({ title: h.title, idea: h.idea, risk: h.risk }))

    const insights = this.getInsights()
    const insightSources: CreativitySource[] = insights.map((i) => ({
      name: `洞察:${i.title}`,
      content: `${i.description} (评分:${i.score})`,
      type: 'insight' as const,
      weight: 0.7,
    }))

    const allSources = [...recentSources, ...insightSources]

    log('INFO', 'creativity_dream_start', {
      sources: allSources.length,
      historical_combos: historicalCombos.length,
      failed_hypotheses: failedHypotheses.length,
    })

    const ideas = await this.generator.dreamIdeas(
      allSources,
      historicalCombos,
      failedHypotheses.map((h) => ({
        title: h.title,
        idea: h.idea,
        risk: h.risk,
        status: 'rejected' as const,
        createdAt: Date.now(),
        expectedBenefit: '',
        feasibility: 0,
        id: '',
        impact: 0,
        novelty: 0,
        sourceLabels: [],
      })),
    )

    const logEntry: DreamCycleLog = {
      timestamp: Date.now(),
      sourcesExamined: allSources.length,
      combosGenerated: this.store.getRecentCombos().length,
      hypothesesGenerated: ideas.length,
      topIdea: ideas.length > 0 ? ideas[0].hypothesis.title : null,
    }
    this.store.logDreamCycle(logEntry)

    if (ideas.length === 0) {
      log('INFO', 'creativity_dream_empty')
      return
    }

    this.persist(ideas)
    this.reportCycle(ideas, true)
    this.report(ideas)
    this.eventBus.emit('creativity.dream.completed', {
      count: ideas.length,
      topNovelty: ideas[0].hypothesis.novelty,
    })
  }

  private persist(ideas: CreativeIdea[]): void {
    const hypotheses = ideas.map((i) => i.hypothesis)
    this.store.addManyHypotheses(hypotheses)

    for (const idea of ideas) {
      if (idea.experiment) {
        this.store.addExperiment(idea.experiment)
      }
    }
  }

  private report(ideas: CreativeIdea[]): void {
    const top = ideas.slice(0, 3)
    this.eventBus.emit('creativity.ideas.generated', {
      count: ideas.length,
      ideas: top.map((i) => ({
        id: i.hypothesis.id,
        title: i.hypothesis.title,
        idea: i.hypothesis.idea,
        expectedBenefit: i.hypothesis.expectedBenefit,
        risk: i.hypothesis.risk,
        sourceLabels: i.hypothesis.sourceLabels,
        novelty: i.hypothesis.novelty,
        feasibility: i.hypothesis.feasibility,
        impact: i.hypothesis.impact,
      })),
    })

    log('INFO', 'creativity_ideas_generated', {
      count: ideas.length,
      top_novelty: top[0]?.hypothesis.novelty,
      top_title: top[0]?.hypothesis.title,
    })
  }

  /** 写一份可读的报告到 evolution_workspace */
  private reportCycle(ideas: CreativeIdea[], dream = false): void {
    if (!this.reportDir) return

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const cycleType = dream ? '梦境' : '普通'
    const filePath = resolve(this.reportDir, `creativity-${ts}.md`)

    const dir = this.reportDir
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    const count = ideas.length
    const sorted = [...ideas].sort((a, b) => b.hypothesis.novelty - a.hypothesis.novelty)
    const top = sorted[0]

    let md = `# 创造力周期报告 (${cycleType})

- **时间**: ${ts}
- **产出**: ${count} 个新想法
- **最高新颖度**: ${top?.hypothesis.novelty ?? '-'}
- **最高得分**: ${top ? `新颖=${top.hypothesis.novelty} 可行=${top.hypothesis.feasibility} 影响=${top.hypothesis.impact}` : '-'}

## 想法列表

| # | 标题 | 来源 | 新颖度 | 可行性 | 影响 |
|---|------|------|--------|--------|------|
`
    for (let i = 0; i < sorted.length; i++) {
      const h = sorted[i].hypothesis
      md += `| ${i + 1} | ${h.title} | ${h.sourceLabels.join(', ')} | ${h.novelty} | ${h.feasibility} | ${h.impact} |\n`
    }

    // 附加 top 1 详情
    if (top) {
      const h = top.hypothesis
      md += `
## 最佳想法详情

**${h.title}**

- 来源: ${h.sourceLabels.join(' × ')}
- 新颖度: ${h.novelty} / 可行性: ${h.feasibility} / 影响: ${h.impact}

**描述**
${h.idea}

**预期收益**
${h.expectedBenefit}

**风险**
${h.risk}
`
    }

    // 附加采纳率摘要
    md += `
## 历史采纳率概览

${this.store.adoptionReport(5)}
`

    try {
      writeFileSync(filePath, md, 'utf-8')
      log('INFO', 'creativity_report_saved', { path: filePath })

      // 保留最近 10 份报告，清理旧的
      this.cleanOldReports()
    } catch (err) {
      log('ERROR', 'creativity_report_failed', { error: String(err) })
    }
  }

  private cleanOldReports(): void {
    try {
      const { readdirSync, unlinkSync } = require('fs') as typeof import('fs')
      const files = readdirSync(this.reportDir)
        .filter((f) => f.startsWith('creativity-') && f.endsWith('.md'))
        .map((f) => ({ name: f, time: new Date(f.slice(11, 30).replace(/-/g, ':')).getTime() }))
        .sort((a, b) => b.time - a.time)
      for (const f of files.slice(10)) {
        unlinkSync(resolve(this.reportDir, f.name))
      }
    } catch {}
  }

  async forceCycle(): Promise<CreativeIdea[]> {
    const sources = this.getSources()
    if (sources.length < 2) return []
    const ideas = await this.generator.generateIdeas(sources)
    if (ideas.length > 0) this.persist(ideas)
    return ideas
  }

  async forceDreamCycle(): Promise<CreativeIdea[]> {
    const recentSources = this.getSources()
    const historicalCombos = this.store.getRecentCombos(30)
    const failedHypotheses = this.store.getHypotheses({ status: 'rejected' })
    const insights = this.getInsights().map((i) => ({
      name: `洞察:${i.title}`,
      content: `${i.description} (评分:${i.score})`,
      type: 'insight' as const,
      weight: 0.7,
    }))
    const allSources = [...recentSources, ...insights]
    const ideas = await this.generator.dreamIdeas(
      allSources,
      historicalCombos,
      failedHypotheses.map((h) => ({
        id: h.id,
        title: h.title,
        idea: h.idea,
        risk: h.risk,
        expectedBenefit: h.expectedBenefit,
        feasibility: h.feasibility,
        impact: h.impact,
        novelty: h.novelty,
        sourceLabels: h.sourceLabels,
        status: 'rejected' as const,
        createdAt: h.createdAt,
      })),
    )
    if (ideas.length > 0) this.persist(ideas)
    return ideas
  }

  getStore(): IdeaStoreLike {
    return this.store
  }
}
