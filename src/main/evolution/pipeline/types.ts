/**
 * Evolution Pipeline — 4 阶段流水线类型定义
 *
 * Analyzer → Strategizer → Executor → Reviewer
 * 各阶段通过类型化的输入/输出契约通信。
 */

import type { DevPlan, PlanManagerLike } from '../types'
import type { StrategyConfig, CycleEvaluation } from '../EvolutionStrategy'
import type { EvolutionSafetyMode } from '../types'

// ===== 策略选择上下文 =====

export interface StrategyContext {
  consecutiveFailures: number
  isFirstRun: boolean
  isRecovering: boolean
  hoursSinceLastRun: number
  isDegenerate: boolean
}

// ===== 分析阶段输出 =====

export interface AnalysisInput {
  mode: 'first_run' | 'continue_plan' | 'review_only'
  planContext: string
  historySummary: string
  safetyMode: string
  validationSummary?: string
  livingPlanCtx: string
  cognitiveCtx: string
  strategyCtx: string
  creativityCtx?: string
  promptMode: 'full' | 'balanced' | 'minimal'
}

export interface AnalysisResult {
  success: boolean
  summary: string
  planSummary?: { id: string; title: string; stepsComplete: number; stepsTotal: number }
  hadTimeout: boolean
  hadRetry: boolean
  planCreated: boolean
}

// ===== 执行阶段输入 =====

export interface ExecutionInput {
  planId: string
  stepIndex: number
  stepDescription: string
  planCtx: string
  cognitiveCtx: string
}

export interface ExecutionResult {
  success: boolean
  stepIndex: number
  error?: string
  planCompleted: boolean
}

// ===== 验证阶段输入 =====

export interface ReviewInput {
  changedFiles: { newFiles: string[]; modifiedFiles: string[] }
  mode: 'analyze' | 'execute'
}

export interface ReviewResult {
  passed: boolean
  verification?: { passed: boolean }
  regression?: { hasRegression: boolean }
  validationSummary: string
}

// ===== 阶段接口 =====

export interface IEvolutionStage {
  readonly name: string
  init(): Promise<void>
  destroy(): Promise<void>
}

export interface IAnalyzer extends IEvolutionStage {
  analyze(input: AnalysisInput): Promise<AnalysisResult>
  getHistorySummary(): string
  detectPlanMode(): { mode: AnalysisInput['mode']; planContext: string; planSummary?: AnalysisResult['planSummary'] }
  isDegenerate(): boolean
  recordFingerprint(summary: string): void
  loadRecentFailures(): Array<{ task: string; error: string; timestamp: number }>
}

export interface IStrategizer extends IEvolutionStage {
  select(context: StrategyContext): StrategyConfig
  evaluate(strategyName: string, evalResult: CycleEvaluation): void
  getFormattedContext(): string
  learn(): { recommendation?: string; insight: string }
}

export interface IExecutor extends IEvolutionStage {
  executeNextStep(input: ExecutionInput): Promise<ExecutionResult>
  hasPendingStep(): boolean
  getPlanProgress(): { completed: number; total: number }
}

export interface IReviewer extends IEvolutionStage {
  startListen(): void
  stopAndValidate(mode: 'analyze' | 'execute'): {
    passed: boolean
    violations: any[]
    warnings: string[]
    stats: any
    validationSummary: string
  }
  verify(changedFiles: { newFiles: string[]; modifiedFiles: string[] }): Promise<{ passed: boolean }>
  detectRegression(changedFiles: { newFiles: string[]; modifiedFiles: string[] }): Promise<{ hasRegression: boolean }>
  setProposalValidator(v: any): void
}
