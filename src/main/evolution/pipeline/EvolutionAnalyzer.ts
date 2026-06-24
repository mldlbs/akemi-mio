/**
 * EvolutionAnalyzer — 进化流水线 Stage 1
 *
 * 职责：收集指标、检测进化需求、构建分析 Prompt、执行 LLM 分析、管理历史记录
 * 生命周期：init() → [analyze() 循环] → destroy()
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { log } from '../../logger/Logger'
import { eventBus } from '../../core/EventBus'
import { buildEvolutionSystemPrompt } from '../SelfEvolutionPrompt'
import { ANALYSIS_PROMPT, detectPlanMode, pickBestPlan, buildPlanInjection } from '../EvolutionPromptBuilder'
import type { AgentService } from '../../agent/AgentService'
import type { DevPlan, PlanManagerLike } from '../types'
import type { ISubsystem, HealthCheckResult, SubsystemState } from '../../core/lifecycle/types'
import type { AnalysisInput, AnalysisResult } from './types'

/** 单次 evolution 的历史记录 */
export interface EvolutionHistoryEntry {
  timestamp: number
  perspective: string
  summary: string
  planCreated: boolean
  planTitle?: string
  stepsCompleted: number
  stepsTotal: number
  success: boolean
}

export interface EvolutionHistory {
  cycles: EvolutionHistoryEntry[]
}

export class EvolutionAnalyzer implements ISubsystem {
  readonly name = 'EvolutionAnalyzer'
  state: SubsystemState = 'created'

  private agentService: AgentService
  private planManager: PlanManagerLike | null
  private historyPath: string
  private livingPlanDir: string
  private maxLivingPlanBytes: number
  private promptTrimMode: boolean = false
  private historyMaxEntries: number = 5
  private currentAnalysisTimeoutMs: number
  private degenerationThreshold: number = 3
  private recentAnalysisFingerprints: string[] = []

  /** prompt 修正 overlay（由 PromptEvolutionManager 设置） */
  private promptOverlay: string = ''

  constructor(
    agentService: AgentService,
    planManager: PlanManagerLike | null,
    options?: {
      historyPath?: string
      maxLivingPlanBytes?: number
      analysisTimeoutMs?: number
      degenerationThreshold?: number
    },
  ) {
    this.agentService = agentService
    this.planManager = planManager
    this.historyPath = options?.historyPath ?? join(process.cwd(), 'evolution_workspace', 'history.json')
    this.livingPlanDir = dirname(this.historyPath)
    this.maxLivingPlanBytes = options?.maxLivingPlanBytes ?? 4096
    this.currentAnalysisTimeoutMs = options?.analysisTimeoutMs ?? 120000
    this.degenerationThreshold = options?.degenerationThreshold ?? 3
  }

  async init(): Promise<void> {
    this.state = 'initializing'
    log('INFO', 'evolution_analyzer.init')
    this.state = 'ready'
  }

  async start(): Promise<void> {
    this.state = 'running'
  }
  async stop(): Promise<void> {
    this.state = 'ready'
  }
  async destroy(): Promise<void> {
    this.state = 'stopped'
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return { healthy: true, metrics: { fingerprints: this.recentAnalysisFingerprints.length } }
  }

  // ==================== 分析入口 ====================

  async analyze(input: AnalysisInput): Promise<AnalysisResult> {
    const prompt =
      ANALYSIS_PROMPT(input.mode, input.planContext, input.historySummary, input.safetyMode, input.validationSummary, this.promptOverlay) +
      '\n' +
      input.livingPlanCtx +
      '\n' +
      input.cognitiveCtx +
      '\n' +
      input.strategyCtx +
      (input.creativityCtx ? '\n' + input.creativityCtx : '')

    try {
      const result = await this.agentService.runSelfTask(prompt, buildEvolutionSystemPrompt(undefined, this.promptOverlay))

      if (result.success) {
        this.recordCycle({
          timestamp: Date.now(),
          perspective: '分析',
          summary: result.summary.slice(0, 500),
          planCreated: !!this.planManager?.getActivePlan(),
          planTitle: this.planManager?.getActivePlan()?.title,
          stepsCompleted: this.getActivePlanProgress().completed,
          stepsTotal: this.getActivePlanProgress().total,
          success: true,
        })
      } else {
        this.recordCycle({
          timestamp: Date.now(),
          perspective: '分析',
          summary: `失败: ${result.summary.slice(0, 300)}`,
          planCreated: false,
          success: false,
          stepsCompleted: 0,
          stepsTotal: 0,
        })
      }

      return {
        success: result.success,
        summary: result.summary,
        hadTimeout: false,
        hadRetry: false,
        planCreated: !!this.planManager?.getActivePlan(),
      }
    } catch (err: any) {
      this.recordCycle({
        timestamp: Date.now(),
        perspective: '分析',
        summary: `异常: ${err.message}`,
        planCreated: false,
        success: false,
        stepsCompleted: 0,
        stepsTotal: 0,
      })
      return { success: false, summary: err.message, hadTimeout: true, hadRetry: true, planCreated: false }
    }
  }

  // ==================== 历史管理 ====================

  private loadHistory(): EvolutionHistory {
    try {
      if (!existsSync(this.historyPath)) return { cycles: [] }
      return JSON.parse(readFileSync(this.historyPath, 'utf-8'))
    } catch {
      return { cycles: [] }
    }
  }

  private saveHistory(history: EvolutionHistory): void {
    try {
      const dir = dirname(this.historyPath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.historyPath, JSON.stringify(history, null, 2), 'utf-8')
    } catch (err) {
      log('ERROR', 'evolution_history_save_failed', { error: String(err) })
    }
  }

  private recordCycle(entry: EvolutionHistoryEntry): void {
    try {
      const history = this.loadHistory()
      history.cycles.push(entry)
      if (history.cycles.length > 20) history.cycles = history.cycles.slice(-20)
      this.saveHistory(history)
    } catch (err) {
      log('ERROR', 'evolution_history_record_failed', { error: String(err) })
    }
  }

  getHistorySummary(): string {
    try {
      const history = this.loadHistory()
      if (history.cycles.length === 0) return '【历史记录】暂无历史进化记录，这是首次运行。\n请全面分析项目状态。'

      const sliceCount = Math.min(this.historyMaxEntries, history.cycles.length)
      const recent = history.cycles.slice(-sliceCount)
      const lines = ['【近期进化历史】']
      for (const h of recent) {
        const time = new Date(h.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        lines.push(`- [${time}] ${h.success ? '成功' : '失败'} 摘要: ${h.summary.slice(0, 200)}`)
        if (h.planCreated) lines.push(`  计划: ${h.planTitle || '(未命名)'} (${h.stepsCompleted}/${h.stepsTotal})`)
      }
      lines.push('', '请基于以上历史记录，避免重复分析已经看过的方向。选择一个之前未被充分关注的新视角进行分析。')
      return lines.join('\n')
    } catch {
      return '【历史记录】读取失败，请全面分析。'
    }
  }

  loadRecentFailures(): Array<{ task: string; error: string; timestamp: number }> {
    try {
      const history = this.loadHistory()
      return history.cycles
        .filter((c) => !c.success)
        .slice(-10)
        .map((c) => ({
          task: c.perspective,
          error: c.summary.slice(0, 60),
          timestamp: c.timestamp,
        }))
    } catch {
      return []
    }
  }

  // ==================== 计划检测 ====================

  detectPlanMode(): { mode: AnalysisInput['mode']; planContext: string; planSummary?: AnalysisResult['planSummary'] } {
    return detectPlanMode(this.planManager as any)
  }

  private getActivePlanProgress(): { completed: number; total: number } {
    const plan = this.planManager?.getActivePlan()
    if (!plan) return { completed: 0, total: 0 }
    return {
      completed: plan.steps.filter((s) => s.status === 'done').length,
      total: plan.steps.length,
    }
  }

  /**
   * 检测活跃计划是否已卡住（超过 1 小时无更新）。
   * 卡住的计划允许 evolution 分析穿透，以便 LLM 发现并处理。
   */
  private isActivePlanStale(): boolean {
    const plan = this.planManager?.getActivePlan()
    if (!plan) return true
    const staleThreshold = Date.now() - 3600_000 // 1 小时
    const lastUpdated = plan.updatedAt || plan.createdAt
    return lastUpdated < staleThreshold
  }

  /**
   * 廉价预过滤：在调用 LLM 分析前检查是否有必要运行。
   * Level 1 规则（无 LLM 调用）：退化检测、计划进展、近期空闲周期。
   */
  shouldAnalyze(): { shouldRun: boolean; reason?: string } {
    // 1. 退化检测：连续 N 次相同结论不重复分析
    if (this.isDegenerate()) {
      return { shouldRun: false, reason: 'degenerate_fingerprint' }
    }

    // 2. 计划活跃存在：未卡住的活跃计划阻止新分析
    //    卡住的计划允许分析穿透，以便 LLM 发现并处理
    const activePlan = this.planManager?.getActivePlan()
    if (activePlan) {
      if (!this.isActivePlanStale()) {
        const progress = this.getActivePlanProgress()
        return { shouldRun: false, reason: `active_plan_exists_${progress.completed}/${progress.total}` }
      }
      // 计划卡住超过 1 小时，允许分析穿透
      log('INFO', 'evolution_active_plan_stale', {
        planTitle: activePlan.title,
        planId: activePlan.id,
        updatedAt: new Date(activePlan.updatedAt || activePlan.createdAt).toISOString(),
      })
    }

    // 3. 近期空闲周期：最近 3 次分析都成功但未创建计划
    const history = this.loadHistory()
    const recent = history.cycles.slice(-3)
    if (recent.length >= 3 && recent.every((c) => c.success && !c.planCreated)) {
      return { shouldRun: false, reason: 'recent_cycles_all_idle' }
    }

    return { shouldRun: true }
  }

  // ===== Living Plan 上下文 =====

  buildLivingPlanContext(): string {
    if (this.promptTrimMode) {
      const missionOnly = this.readLivingPlanFile('mission.yaml')
      return missionOnly ? ['', '---', '【Mission - 使命】', missionOnly, '---'].join('\n') : ''
    }
    const mission = this.readLivingPlanFile('mission.yaml')
    const goals = this.readLivingPlanFile('goals.yaml')
    const planTree = this.readLivingPlanFile('plan_tree.yaml')
    const queue = this.readLivingPlanFile('execution_queue.yaml')

    interface Section {
      label: string
      content: string
      priority: number
    }
    const allSections: Section[] = []
    if (mission) allSections.push({ label: '【Mission — 使命】', content: mission, priority: 4 })
    if (goals) allSections.push({ label: '【Goals — 长期目标】', content: goals, priority: 3 })
    if (planTree) allSections.push({ label: '【Plan Tree — 计划树】', content: planTree, priority: 2 })
    if (queue) allSections.push({ label: '【Execution Queue — 执行队列】', content: queue, priority: 1 })

    const template = [
      '',
      '---',
      '你可以在 evolution_workspace/living_plan/ 下用 write_file 更新这些文件：',
      '- goals.yaml：添加/修改/删除长期目标',
      '- plan_tree.yaml：添加 Initiative 或 Task，标记完成',
      '- execution_queue.yaml：添加执行项，标记完成',
      '- history_log.yaml：记录行动日志',
      '---',
      '',
    ].join('\n')

    const templateBytes = new TextEncoder().encode(template).length
    const missionSection = allSections.find((s) => s.priority === 4)
    const missionBytes = missionSection ? new TextEncoder().encode(`\n${missionSection.label}\n${missionSection.content}`).length : 0
    const remainingBudget = this.maxLivingPlanBytes - templateBytes - missionBytes
    const included = new Set<string>()
    included.add('【Mission — 使命】')
    if (remainingBudget > 0) {
      const weightedSections = allSections.filter((s) => s.priority < 4)
      const totalWeight = weightedSections.reduce((sum, s) => sum + s.priority, 0)
      for (const s of weightedSections) {
        const text = `\n${s.label}\n${s.content}`
        const bytes = new TextEncoder().encode(text).length
        const budget = Math.floor((remainingBudget * s.priority) / totalWeight)
        if (bytes <= budget) included.add(s.label)
      }
    }

    const parts: string[] = []
    for (const sec of allSections)
      if (included.has(sec.label)) {
        parts.push('', sec.label, sec.content)
      }
    parts.push(template)
    return parts.join('\n')
  }

  private readLivingPlanFile(filename: string): string {
    try {
      const p = join(this.livingPlanDir, filename)
      return existsSync(p) ? readFileSync(p, 'utf-8') : ''
    } catch {
      return ''
    }
  }

  // ==================== 退化检测 ====================

  private computeFingerprint(summary: string): string {
    return summary.replace(/\s+/g, ' ').slice(0, 100).trim()
  }

  isDegenerate(): boolean {
    if (this.recentAnalysisFingerprints.length < this.degenerationThreshold) return false
    const recent = this.recentAnalysisFingerprints.slice(-this.degenerationThreshold)
    return recent.every((fp) => fp === recent[0])
  }

  recordFingerprint(summary: string): void {
    const fp = this.computeFingerprint(summary)
    this.recentAnalysisFingerprints.push(fp)
    if (this.recentAnalysisFingerprints.length > 10) this.recentAnalysisFingerprints = this.recentAnalysisFingerprints.slice(-10)
  }

  // ==================== 参数自适应 ====================

  setPromptTrimMode(v: boolean) {
    this.promptTrimMode = v
  }
  setPromptOverlay(overlay: string) {
    this.promptOverlay = overlay
  }
  setHistoryMaxEntries(n: number) {
    this.historyMaxEntries = n
  }
  setAnalysisTimeout(ms: number) {
    this.currentAnalysisTimeoutMs = ms
  }
  getAnalysisTimeout(): number {
    return this.currentAnalysisTimeoutMs
  }
  getPromptTrimMode(): boolean {
    return this.promptTrimMode
  }
  getHistoryMaxEntries(): number {
    return this.historyMaxEntries
  }
  getFingerprints(): string[] {
    return this.recentAnalysisFingerprints
  }

  /** 最近一次指纹的时间戳（毫秒）。无指纹返回 Infinity */
  getFingerprintAgeMs(): number {
    if (this.recentAnalysisFingerprints.length === 0) return Infinity
    const history = this.loadHistory()
    const nonDegenerate = history.cycles.filter((c) => c.success || c.planCreated)
    if (nonDegenerate.length === 0) {
      return 999 * 60 * 60 * 1000
    }
    const lastSuccessTime = nonDegenerate[nonDegenerate.length - 1].timestamp
    return Date.now() - lastSuccessTime
  }

  resetFingerprints(): void {
    this.recentAnalysisFingerprints = []
    log('INFO', 'evolution_fingerprints_reset')
  }

  resetDegenerationCount(): void {
    this.recentAnalysisFingerprints = []
    log('INFO', 'evolution_degeneration_reset')
  }
}
