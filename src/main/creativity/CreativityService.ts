import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve } from 'path'
import { log } from '../logger/Logger'
import { eventBus, EventBus } from '../core/EventBus'
import { IdeaGenerator } from './IdeaGenerator'
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
  ) {
    this.store = store
    this.generator = new IdeaGenerator(chatJson, temperature, seed)
    this.eventBus = bus || eventBus
    this.reportDir = reportDir
    this.taskRunner = taskRunner

    this.getSources = deps.getSources
    this.getInsights = deps.getInsights
    this.getFailedHypotheses = deps.getFailedHypotheses

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
    const sources = this.getSources()
    if (sources.length < 2) return

    log('INFO', 'creativity_cycle_start', { source_count: sources.length })
    this.eventBus.emit('creativity.cycle.started', {})

    const ideas = await this.generator.generateIdeas(sources)

    if (ideas.length === 0) {
      log('INFO', 'creativity_cycle_empty')
      this.eventBus.emit('creativity.cycle.completed', { count: 0, hasValue: false })
      return
    }

    // 去重：与最近 20 条已知假设对比，跳过相似度过高的
    const recent = this.store.getHypotheses({ limit: 20 })
    const deduped = ideas.filter((i) => !recent.some((r) => similarity(i.hypothesis.title, r.title) > 0.65))

    if (deduped.length === 0) {
      log('INFO', 'creativity_cycle_all_duplicates')
      this.eventBus.emit('creativity.cycle.completed', { count: ideas.length, hasValue: false })
      return
    }

    this.persist(deduped)
    this.reportCycle(deduped)
    this.report(deduped)
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

/**
 * 简单字符串相似度（基于公共子串）
 */
function similarity(a: string, b: string): number {
  const short = a.length <= b.length ? a : b
  const long = a.length <= b.length ? b : a
  if (long.length === 0) return 0
  let maxLen = 0
  for (let i = 0; i < short.length; i++) {
    for (let j = i + 1; j <= short.length; j++) {
      if (long.includes(short.slice(i, j))) {
        maxLen = Math.max(maxLen, j - i)
      }
    }
  }
  return maxLen / long.length
}
