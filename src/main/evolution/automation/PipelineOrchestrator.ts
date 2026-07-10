/**
 * PipelineOrchestrator — 自动化管道编排器
 *
 * 一个简单循环：
 *   1. 对每个 Collector: collect() → push to ProblemQueue
 *   2. 从 Queue pop() 最高优先级问题
 *   3. 主执行器修复，失败则尝试备用
 *   4. 结果写回 Queue
 *
 * 【MCP 模式迁移】
 * - 集成 ProblemFixCache：执行前检查缓存，跳过已知不可修复问题
 * - 集成 ProblemErrorType：markFailed() 时传递错误消息用于分类
 * - 集成 AutomationRegistry：registerBuiltins() 通过注册表注册
 */

import { log } from '../../logger/Logger'
import { eventBus } from '../../core/EventBus'
import type { SignalCollector, FixExecutor, FixResult } from './types'
import { ProblemQueue } from './ProblemQueue'
import { TscCollector } from './TscCollector'
import { TestCollector } from './TestCollector'
import { EslintCollector } from './EslintCollector'
import { ClaudeCodeExecutor } from './ClaudeCodeExecutor'
import { DeepSeekExecutor } from './DeepSeekExecutor'
import { AsrLogCollector } from './AsrLogCollector'
import { AsrOptimizationExecutor } from './AsrOptimizationExecutor'
import { AsrVocabEvolutionExecutor } from './AsrVocabEvolutionExecutor'
import { AsrAcousticOptimizationExecutor } from './AsrAcousticOptimizationExecutor'
import { PlanLogCollector } from './PlanLogCollector'
import { AutoPatchExecutor } from './AutoPatchExecutor'
import { ToolEvolutionCollector } from './ToolEvolutionCollector'
import { ToolEvolutionExecutor } from './ToolEvolutionExecutor'
import { TtsPreferenceCollector } from './TtsPreferenceCollector'
import { TtsConfigOptimizationExecutor } from './TtsConfigOptimizationExecutor'
import { TtsTypographyCollector } from './TtsTypographyCollector'
import { TtsTypographyExecutor } from './TtsTypographyExecutor'
import { TypeHealthCollector } from '../typehealth/TypeHealthCollector'
import { TypeRefactorExecutor } from '../typehealth/TypeRefactorExecutor'
import {
  registerCollector,
  registerExecutor,
  getAllCollectors,
  getAllExecutors,
  getExecutorsBySource,
} from './registry'

export interface PipelineConfig {
  projectRoot: string
  persistDir: string
  maxFixesPerCycle: number
}

export interface PipelineMetrics {
  totalCollected: number
  totalFixed: number
  totalFailed: number
  queueSize: number
  lastRunAt: number
  isRunning: boolean
}

export class PipelineOrchestrator {
  private collectors: SignalCollector[] = []
  private executors: FixExecutor[] = []
  private queue: ProblemQueue
  private config: PipelineConfig
  private _isRunning = false
  private _lastRunAt = 0
  private totalCollected = 0
  private totalFixed = 0
  private totalFailed = 0

  constructor(config: PipelineConfig) {
    this.config = config
    this.queue = new ProblemQueue(config.persistDir)
  }

  addCollector(collector: SignalCollector): void {
    this.collectors.push(collector)
  }

  addExecutor(executor: FixExecutor): void {
    this.executors.push(executor)
  }

  /**
   * 初始化内置 Collector 和 Executor
   *
   * 两阶段初始化：
   * 1. 先注册到中央注册表（使 getCollectors/getExecutors 发现）
   * 2. 再添加到本地列表
   *
   * 【MCP 模式迁移】通过注册表统一管理，替代分散的 new 调用。
   * 后续新增 Collector/Executor 只需在 registerBuiltins 中注册，
   * 消费侧通过 getAllCollectors() / getAllExecutors() 发现。
   */
  initDefaults(mcpManager?: any): void {
    // Stage 1: 创建内置采集器
    const tscCollector = new TscCollector(this.config.projectRoot)
    const testCollector = new TestCollector(this.config.projectRoot)
    const eslintCollector = new EslintCollector(this.config.projectRoot)
    const asrLogCollector = new AsrLogCollector()
    const planLogCollector = new PlanLogCollector()
    const toolEvolutionCollector = new ToolEvolutionCollector()
    const ttsPreferenceCollector = new TtsPreferenceCollector()
    const ttsTypographyCollector = new TtsTypographyCollector()
    const typeHealthCollector = new TypeHealthCollector()

    // Stage 2: 注册到中央注册表
    registerCollector(tscCollector)
    registerCollector(testCollector)
    registerCollector(eslintCollector)
    registerCollector(asrLogCollector)
    registerCollector(planLogCollector)
    registerCollector(toolEvolutionCollector)
    registerCollector(ttsPreferenceCollector)
    registerCollector(ttsTypographyCollector)
    registerCollector(typeHealthCollector)

    // Stage 3: 从注册表加载到本地
    for (const c of getAllCollectors()) {
      this.addCollector(c)
    }

    // Stage 4: 创建并注册内置执行器
    const claudeCodeExecutor = new ClaudeCodeExecutor()
    const asrOptimizationExecutor = new AsrOptimizationExecutor()
    const asrVocabEvolutionExecutor = new AsrVocabEvolutionExecutor()
    const asrAcousticOptimizationExecutor = new AsrAcousticOptimizationExecutor()
    const autoPatchExecutor = new AutoPatchExecutor()
    const toolEvolutionExecutor = new ToolEvolutionExecutor()
    const ttsConfigOptExecutor = new TtsConfigOptimizationExecutor()
    const ttsTypographyExecutor = new TtsTypographyExecutor()
    const typeRefactorExecutor = new TypeRefactorExecutor()

    registerExecutor(claudeCodeExecutor)
    registerExecutor(asrOptimizationExecutor)
    registerExecutor(asrVocabEvolutionExecutor)
    registerExecutor(asrAcousticOptimizationExecutor)
    registerExecutor(autoPatchExecutor)
    registerExecutor(toolEvolutionExecutor)
    registerExecutor(ttsConfigOptExecutor)
    registerExecutor(ttsTypographyExecutor)
    registerExecutor(typeRefactorExecutor)
    if (mcpManager) {
      registerExecutor(new DeepSeekExecutor(mcpManager))
    }

    // Stage 5: 从注册表加载到本地
    for (const e of getAllExecutors()) {
      this.addExecutor(e)
    }
  }

  async runOnce(): Promise<PipelineMetrics> {
    if (this._isRunning) {
      log('WARN', 'pipeline_already_running')
      return this.getMetrics()
    }

    this._isRunning = true
    this._lastRunAt = Date.now()
    eventBus.emit('pipeline.started', { timestamp: this._lastRunAt })

    try {
      // Phase 1: Collect
      const collectResults: Array<{ source: string; problems: import('./types').Problem[] }> = []
      const collectPromises = this.collectors
        .filter((c) => c.shouldRun())
        .map(async (c) => {
          const problems = await c.collect()
          this.queue.push(problems)
          this.totalCollected += problems.length
          collectResults.push({ source: c.source, problems })
        })

      await Promise.all(collectPromises)

      // Phase 1.5: Reconcile — 清除不再活跃的旧问题，避免修已修复的
      for (const { source, problems } of collectResults) {
        const freshIds = new Set(problems.map((p) => p.id))
        this.queue.reconcile(source as import('./types').ProblemSource, freshIds)
      }

      // Phase 1.75: 【MCP 模式迁移】跳过已知不可修复的缓存问题
      const skippedCount = this.queue.skipCachedUnfixable()
      if (skippedCount > 0) {
        log('INFO', 'pipeline_skipped_cached_unfixable', { count: skippedCount })
      }

      // Phase 2: Execute
      let fixed = 0
      let failed = 0
      const fixDetails: Array<{
        problemId: string
        source: string
        file: string
        line: number | undefined
        title: string
        success: boolean
        summary: string
        durationMs: number
        output?: string
        error?: string
      }> = []

      for (let i = 0; i < this.config.maxFixesPerCycle; i++) {
        if (this.queue.isEmpty) break

        const problem = this.queue.pop()
        if (!problem) break

        const result = await this.tryFix(problem)

        fixDetails.push({
          problemId: problem.id,
          source: problem.source,
          file: problem.file || '',
          line: problem.line,
          title: problem.title,
          success: result.success,
          summary: result.summary,
          durationMs: result.durationMs,
          output: result.output,
          error: result.error,
        })

        if (result.success) {
          this.queue.markCompleted(problem.id)
          fixed++
          this.totalFixed++
        } else {
          // 【MCP 模式迁移】传递错误消息给 markFailed 用于错误分类
          this.queue.markFailed(problem.id, result.error || result.summary)
          failed++
          this.totalFailed++
        }
      }

      log('INFO', 'pipeline_cycle_complete', {
        collected: this.totalCollected,
        fixed,
        failed,
        queueRemaining: this.queue.size,
      })

      eventBus.emit('pipeline.completed', {
        collected: this.totalCollected,
        fixed,
        failed,
        queueRemaining: this.queue.size,
        timestamp: Date.now(),
        durationMs: Date.now() - this._lastRunAt,
        details: fixDetails,
      })
    } catch (err: any) {
      log('ERROR', 'pipeline_cycle_error', { error: err.message })
      eventBus.emit('pipeline.errored', { error: err.message })
    } finally {
      this._isRunning = false
    }

    return this.getMetrics()
  }

  /** 按优先级尝试主+备用执行器 */
  private async tryFix(problem: import('./types').AssignedProblem): Promise<FixResult> {
    // 【MCP 模式迁移】优先通过注册表查询匹配的执行器
    const matching = this.executors.filter((e) => (e.supportedSources as string[]).includes(problem.source))

    // 没有支持此类型问题的执行器 → 直接丢弃（不重试）
    if (matching.length === 0) {
      return { problemId: problem.id, success: true, summary: `无执行器支持 ${problem.source} 类型，已跳过`, durationMs: 0 }
    }

    // 第一个匹配的 executor 为主
    const primary = matching[0]

    if (primary && primary.isAvailable()) {
      const result = await primary.execute(problem)
      if (result.success) return result
      log('INFO', 'pipeline_primary_failed', { primary: primary.name, problemId: problem.id })
    }

    // 备用：不同名的第二个 executor
    const fallback = matching.find((e) => e.name !== primary?.name && e.isAvailable())

    if (fallback) {
      log('INFO', 'pipeline_fallback', { primary: primary?.name, fallback: fallback.name, problemId: problem.id })
      return fallback.execute(problem)
    }

    // 全都不可用
    return { problemId: problem.id, success: false, summary: '无可用执行器', durationMs: 0, error: 'no_available_executor' }
  }

  getMetrics(): PipelineMetrics {
    return {
      totalCollected: this.totalCollected,
      totalFixed: this.totalFixed,
      totalFailed: this.totalFailed,
      queueSize: this.queue.size,
      lastRunAt: this._lastRunAt,
      isRunning: this._isRunning,
    }
  }
}
