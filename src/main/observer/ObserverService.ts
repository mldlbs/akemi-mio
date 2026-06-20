import { log } from '../logger/Logger'
import { ObserverLlmService } from './ObserverLlmService'
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
import { BilibiliCollector } from './collectors/BilibiliCollector'
import { DouyinCollector } from './collectors/DouyinCollector'
import { GitHubTrendingCollector } from './collectors/GitHubTrendingCollector'
import type { Collector, FeedbackSignal, EvolutionParams, OutputEnvelope, WritingMode } from './types'

const PIPELINE_INTERVAL_MS = 4 * 60 * 60 * 1000

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

  constructor(baseDir?: string) {
    this.llm = new ObserverLlmService()
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
    this.collectors = [new RSSCollector(), new BilibiliCollector(), new DouyinCollector(), new GitHubTrendingCollector()]
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
      const obs = this.store.readRecent(3).map((o) => `[${o.source}] ${o.content}`)
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
      const envelope = await this.output.publishInsight(insight, dag, startedAt)
      dag = this.dag.transition(dag, 'COMPLETED')

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
