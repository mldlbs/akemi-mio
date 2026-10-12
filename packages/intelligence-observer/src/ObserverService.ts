import { log } from '@akemi-mio/core/logger/Logger'
import { ObserverLlmService } from './ObserverLlmService'
import type { ObserverLlmConfig } from './ObserverLlmService'
import { ObserverStore } from './ObserverStore'
import { FermentationEngine } from './FermentationEngine'
import { WritingGate } from './WritingGate'
import { DagStateMachine } from './DagStateMachine'
import { TrendEngine } from './TrendEngine'
import { TensionFieldEngine } from './TensionFieldEngine'
import { DeepResearchEngine } from './DeepResearchEngine'
import { MultiBrainModel } from './MultiBrainModel'
import { InsightComposer } from './InsightComposer'
import { WorldModelStore } from './WorldModelStore'
import { SelfEvolutionEngine } from './SelfEvolutionEngine'
import { OutputLayer } from './OutputLayer'
import { RSSCollector } from './collectors/RSSCollector'
import { GitHubTrendingCollector } from './collectors/GitHubTrendingCollector'
import { HackerNewsCollector } from './collectors/HackerNewsCollector'
import { sampleBySourceQuota, sourceFamily } from './sourceQuota'
import type { Collector, FeedbackSignal, EvolutionParams, OutputEnvelope, WritingMode, Observation } from './types'

const PIPELINE_INTERVAL_MS = 4 * 60 * 60 * 1000

/**
 * 从选题文本中提取用于素材检索的关键词。
 * 中文按 2-gram + 整段，英文按完整单词；过滤单字符和纯标点。
 */
function extractTopicKeywords(topic: string): string[] {
  const tokens = topic
    .split(/[\s,，。！？;；:：、"'「」【】\[\]()（）]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && t.length <= 20)
    .filter((t) => /[一-鿿\w]/.test(t))
  // 中文短语补充 2-gram（如 "AI 安全" → ["AI", "安全"] 已够；"人工智能安全" → 加 "人工智能","能安全" 等）
  const cjk = topic.replace(/[^一-鿿]/g, '')
  if (cjk.length >= 3) {
    for (let i = 0; i <= cjk.length - 2; i++) {
      tokens.push(cjk.slice(i, i + 2))
    }
  }
  return [...new Set(tokens)]
}

/**
 * ObserverService — 观察者服务（升级版）
 *
 * 混合模式：同时支持 legacy 发酵和新的 DAG 驱动 pipeline。
 * - collectors 独立运行定时采集
 * - legacy ferment 保留（forceFerment 向后兼容）
 * - pipeline 每 4 小时执行一次完整 DAG
 */
export class ObserverService {
  // legacy
  private llm: ObserverLlmService
  private store: ObserverStore
  private fermentation: FermentationEngine
  private writingGate: WritingGate
  private collectors: Collector[]

  // pipeline
  private dag: DagStateMachine
  private trend: TrendEngine
  private tension: TensionFieldEngine
  private research: DeepResearchEngine
  private multiBrain: MultiBrainModel
  private composer: InsightComposer
  private worldModel: WorldModelStore
  private selfEvo: SelfEvolutionEngine
  private output: OutputLayer

  private collectorTimers: ReturnType<typeof setInterval>[] = []
  private pipelineTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  private lastPipelineDate = ''
  private pipelineRunning = false

  // `llmConfig` is how a host injects the model connection it already resolved
  // (mio-cli reads config.json for creativity/insight and passes the same
  // values here). Omitted, the LLM service falls back to LLM_* / OBSERVER_*
  // environment variables and then its Ollama default -- see D2.
  constructor(baseDir?: string, llmConfig?: ObserverLlmConfig) {
    this.llm = new ObserverLlmService(llmConfig)
    this.store = new ObserverStore(baseDir)
    this.fermentation = new FermentationEngine(this.llm, this.store)
    this.writingGate = new WritingGate(this.llm, this.store)
    this.dag = new DagStateMachine(this.store.baseDir)
    this.trend = new TrendEngine(this.llm, this.store)
    this.tension = new TensionFieldEngine(this.llm, this.store)
    this.research = new DeepResearchEngine(this.llm, this.store)
    this.multiBrain = new MultiBrainModel(this.llm)
    this.composer = new InsightComposer(this.llm, this.store)
    this.worldModel = new WorldModelStore(this.llm, this.store)
    this.selfEvo = new SelfEvolutionEngine(this.store)
    this.output = new OutputLayer(this.store)
    this.collectors = [new RSSCollector(), new GitHubTrendingCollector(), new HackerNewsCollector()]
  }

  // ════════════════════════════════════════════════════════════
  // 原公共接口
  // ════════════════════════════════════════════════════════════

  addCollector(collector: Collector): void {
    this.collectors.push(collector)
  }
  getLlm(): ObserverLlmService {
    return this.llm
  }
  getFermentation(): FermentationEngine {
    return this.fermentation
  }

  // ════════════════════════════════════════════════════════════
  // 新公共接口
  // ════════════════════════════════════════════════════════════

  getDag(): DagStateMachine {
    return this.dag
  }
  getTrend(): TrendEngine {
    return this.trend
  }
  getWorldModel(): WorldModelStore {
    return this.worldModel
  }
  getSelfEvo(): SelfEvolutionEngine {
    return this.selfEvo
  }

  async submitFeedback(signal: FeedbackSignal): Promise<EvolutionParams> {
    return this.selfEvo.applyFeedback(signal)
  }

  async runPipeline(mode: WritingMode = 'analytical'): Promise<OutputEnvelope | null> {
    if (this.pipelineRunning) {
      log('WARN', 'pipeline_already_running')
      return null
    }
    // pipelineRunning only guards this process; mio observe's daemon, a
    // `mio observer serve` loop and a manual `pipeline --run` are three
    // separate processes reading the same dag file. One run at a time.
    if (!this.dag.acquireRunLock()) {
      log('INFO', 'pipeline_skipped_locked')
      return null
    }
    this.pipelineRunning = true
    const startedAt = Date.now()
    const logTag = `pipe_${new Date().toISOString().slice(11, 19)}`

    try {
      let dag = this.dag.createTask()
      if (dag.state === 'COMPLETED') {
        this.lastPipelineDate = new Date().toISOString().slice(0, 10)
        return null
      }

      // Step 1: Collect
      await this.forceCollect()
      dag = this.dag.transition(dag, 'COLLECTED')

      // Step 2: Trend
      log('INFO', `${logTag}_trend`)
      const trends = await this.trend.detectTrends()
      dag = this.dag.transition(dag, 'TOPIC_SELECTED')

      // Step 3: Tension
      log('INFO', `${logTag}_tension`)
      const topicSelection = await this.tension.selectTopic(trends)
      dag = this.dag.transition(dag, 'RESEARCHING')

      // Step 4: Deep Research
      log('INFO', `${logTag}_research`)
      // 按 topic 关键词检索素材（而非只靠时间窗+配额——旧版 8 条 Anthropic
      // 因不在近 3 天窗口或被 30 条配额裁掉而"有料不用"）。
      const recent = this.store.readRecent(7)
      const topicKeywords = extractTopicKeywords(topicSelection.topic.topic)
      const related =
        topicKeywords.length > 0
          ? recent.filter((o) => {
              const lc = o.content.toLowerCase()
              return topicKeywords.some((kw) => lc.includes(kw.toLowerCase()))
            })
          : []
      const MIN_RELATED = 3
      let sampled: Observation[]
      if (topicSelection.fallback) {
        // 抽象 fallback 题目无法按关键词匹配：退化为时间窗抽样，但要求总量下限
        if (recent.length < 5) {
          throw new Error(`insufficient_material: only ${recent.length} observations for fallback topic`)
        }
        sampled = sampleBySourceQuota(recent, 30, 5)
      } else {
        if (related.length < MIN_RELATED) {
          throw new Error(
            `insufficient_material: only ${related.length} related observations for topic "${topicSelection.topic.topic}" (need ${MIN_RELATED})`,
          )
        }
        sampled = sampleBySourceQuota(related, 30, 5)
      }
      const obs = sampled.map((o) => `[${o.source}] ${o.content}`)
      log('INFO', 'research_obs_sampled', {
        total: recent.length,
        related: related.length,
        sampled: sampled.length,
        topicKeywords: topicKeywords.join(','),
        families: [...new Set(sampled.map((o) => sourceFamily(o.source)))].join(','),
      })
      const researchResult = await this.research.research(topicSelection.topic, obs)
      dag = this.dag.transition(dag, 'ANALYZING')

      // Step 5: Multi-Brain
      log('INFO', `${logTag}_brain`)
      const brainOutputs = await this.multiBrain.process(researchResult, mode)
      dag = this.dag.transition(dag, 'WRITING')

      // Step 6: Compose
      log('INFO', `${logTag}_compose`)
      const insight = await this.composer.compose(topicSelection.topic, researchResult, brainOutputs, mode)
      dag = this.dag.transition(dag, 'STORED')

      // Step 7: World Model
      log('INFO', `${logTag}_world_model`)
      await this.worldModel.update(researchResult, insight)

      // Step 8: Output
      log('INFO', `${logTag}_output`)
      // COMPLETED before publishing, not after. publishInsight snapshots
      // dag.state into envelope.dagState, and every consumer (mio.observer.pipeline)
      // reads `dagState.state === 'COMPLETED'` as "the run succeeded". Publishing
      // first meant the envelope always said STORED, so a fully successful run
      // came back completed:false -- CLI exited 1 with "unknown reason", MCP got
      // completed:false (D5). publishInsight only builds the envelope (no I/O),
      // and a later throw still reaches failTask(), which overwrites this state.
      dag = this.dag.transition(dag, 'COMPLETED')
      const envelope = await this.output.publishInsight(insight, dag, startedAt)

      // Step 9: Self Evolution
      const repeated = this.store.getRecentTopics(7).length > 3
      await this.selfEvo.applyImplicitFeedback({ insightSaved: true, dagFailed: false, topicRepeated: repeated })

      this.lastPipelineDate = new Date().toISOString().slice(0, 10)
      log('INFO', 'pipeline_completed', {
        taskId: dag.taskId,
        topic: insight.topic,
        sections: insight.sections.length,
        durationSec: ((Date.now() - startedAt) / 1000).toFixed(0),
      })
      return envelope
    } catch (err: any) {
      log('ERROR', 'pipeline_failed', { error: err.message })
      try {
        const d = this.dag.getTodayTask()
        if (d) this.dag.failTask(d, { message: err.message, phase: 'pipeline' })
      } catch {}
      return null
    } finally {
      this.pipelineRunning = false
      this.dag.releaseRunLock()
    }
  }

  // ════════════════════════════════════════════════════════════
  // start / stop
  // ════════════════════════════════════════════════════════════

  async start(): Promise<void> {
    if (this.disposed) return
    log('INFO', 'observer_service_start')

    for (const collector of this.collectors) {
      const timer = setInterval(async () => {
        const obs = await collector.collect()
        this.store.store(obs)
      }, collector.intervalMs)
      this.collectorTimers.push(timer)
      collector.collect().then((obs) => this.store.store(obs))
    }

    this.pipelineTimer = setInterval(() => this.tickPipeline(), 60_000)
    setTimeout(() => this.tickPipeline(), 5_000)

    log('INFO', 'observer_service_started', {
      collectors: this.collectors.length,
      pipeline_interval_hours: PIPELINE_INTERVAL_MS / 3_600_000,
    })
  }

  stop(): void {
    this.disposed = true
    for (const t of this.collectorTimers) clearInterval(t)
    this.collectorTimers = []
    if (this.pipelineTimer) {
      clearInterval(this.pipelineTimer)
      this.pipelineTimer = null
    }
    this.llm.dispose()
    log('INFO', 'observer_service_stopped')
  }

  async forceCollect(): Promise<void> {
    for (const c of this.collectors) {
      const obs = await c.collect()
      this.store.store(obs)
    }
  }

  /**
   * 按源名称列表按需采集，支持关键词过滤（OR 匹配）和数量限制。
   * 返回 { sourceName → Observation[] } 映射。
   */
  async collectBySource(sourceNames: string[], keywords?: string[], limit: number = 20): Promise<Record<string, Observation[]>> {
    const result: Record<string, Observation[]> = {}
    const collectorMap = new Map<string, Collector>()
    for (const c of this.collectors) {
      collectorMap.set(c.name, c)
      // 兼容源名称别名
      if (c.name === 'github-trending') collectorMap.set('github_trending', c)
    }

    for (const name of sourceNames) {
      const canonical = name === 'github_trending' ? 'github-trending' : name
      const collector = collectorMap.get(canonical)
      if (!collector) {
        if (name !== '36kr' && name !== 'crunchbase') {
          log('WARN', 'collect_by_source_unknown', { source: name })
        }
        continue
      }

      try {
        let obs = await collector.collect()

        // 关键词过滤（OR 匹配 title/content）
        if (keywords && keywords.length > 0) {
          const kwLower = keywords.map((k) => k.toLowerCase())
          obs = obs.filter((o) => kwLower.some((kw) => o.content.toLowerCase().includes(kw)))
        }

        // 数量限制
        if (limit > 0 && obs.length > limit) {
          obs = obs.slice(0, limit)
        }

        result[name] = obs
        this.store.store(obs)
      } catch (err: any) {
        log('ERROR', 'collect_by_source_failed', { source: name, error: err.message })
      }
    }

    return result
  }

  async forceFerment(): Promise<void> {
    const result = await this.fermentation.ferment('afternoon')
    if (result.clusters.length > 0) {
      const path = await this.writingGate.tryWrite(result)
      if (path) log('INFO', 'observer_essay_written', { path })
    }
  }

  async forcePipeline(mode: WritingMode = 'analytical'): Promise<OutputEnvelope | null> {
    return this.runPipeline(mode)
  }

  // ── private ──────────────────────────────────────────────

  private async tickPipeline(): Promise<void> {
    if (this.disposed || this.pipelineRunning) return
    const today = new Date().toISOString().slice(0, 10)
    if (this.lastPipelineDate === today && this.dag.isTodayCompleted()) return
    await this.runPipeline('analytical')
  }
}
