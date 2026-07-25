/**
 * PreOrchestrationEngine — 行为模式工具链预编排引擎
 *
 * ## 职责
 * 1. 监听当前工具调用，检测是否命中已挖掘模式的触发工具
 * 2. 匹配会话上下文（意图、分类、关键词），筛选最相关的模式
 * 3. 解析参数模板（变量替换），生成预编排计划
 * 4. 管理确认流程（自动执行 / 需用户确认 / 拒绝）
 * 5. 批处理执行预编排的工具链
 *
 * ## 工作流
 *   onToolCall(toolName, args, context)
 *     → detectPatternMatch(toolName, context)
 *       → [匹配成功] buildPlan(match)
 *         → [需确认] 返回 pending_confirmation，等待 confirm()/cancel()
 *         → [自动] 执行 executePlan()
 *           → 逐步骤执行 resolvedSteps
 *           → 返回执行结果
 *       → [无匹配] 静默返回
 *
 * ## 风险控制
 * - 低置信度模式（< threshold）必须用户确认
 * - 用户可编辑参数后再确认
 * - 执行过程中可跳过/取消
 * - 连续误匹配自动降低模式优先级
 *
 * @module behavior
 */

import { log } from '../logger/Logger'
import { toolCallLogStore } from '../tool/ToolCallLogStore'
import { toolPatternStore } from './ToolPatternStore'
import type {
  BehaviorPattern,
  PatternStep,
  PatternMatchResult,
  PreOrchestrationPlan,
  ResolvedStep,
  ExecutionEntry,
} from './types'
import { DEFAULT_CONFIRMATION_THRESHOLD } from './types'

// ══════════════════════════════════════════
//  类型
// ══════════════════════════════════════════

/** 工具调用时的上下文 */
export interface ToolCallContext {
  /** 当前用户意图（来自 ToolCallChainStore.currentIntent） */
  intent: string
  /** 意图分类 */
  category: string
  /** 该工具当前的参数 */
  args: Record<string, any>
}

/** 确认回调 */
export type ConfirmationCallback = (plan: PreOrchestrationPlan) => void

/** 引擎配置 */
export interface OrchestratorConfig {
  /** 匹配分数阈值：低于此值不触发预编排 */
  matchThreshold: number
  /** 需要用户确认的置信度阈值 */
  confirmationThreshold: number
  /** 用户确认超时（毫秒），超时自动取消 */
  confirmationTimeoutMs: number
  /** 连续误匹配次数上限（超过后降低模式偏好） */
  maxFalseMatches: number
  /** 是否启用预编排 */
  enabled: boolean
}

// ══════════════════════════════════════════
//  默认配置
// ══════════════════════════════════════════

const DEFAULT_CONFIG: OrchestratorConfig = {
  matchThreshold: 0.3,
  confirmationThreshold: DEFAULT_CONFIRMATION_THRESHOLD,
  confirmationTimeoutMs: 30_000,
  maxFalseMatches: 3,
  enabled: true,
}

// ══════════════════════════════════════════
//  PreOrchestrationEngine
// ══════════════════════════════════════════

export class PreOrchestrationEngine {
  private config: OrchestratorConfig
  /** 当前活跃的编排计划 */
  private activePlan: PreOrchestrationPlan | null = null
  /** 确认超时定时器 */
  private confirmationTimer: ReturnType<typeof setTimeout> | null = null
  /** 确认回调 */
  private onConfirmationNeeded: ConfirmationCallback | null = null
  /** 模式误匹配计数器（用于降频） */
  private falseMatchCounts = new Map<string, number>()
  /** 是否正在执行计划 */
  private _executing = false

  constructor(config?: Partial<OrchestratorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  // ══════════════════════════════════════════
  //  公共 API
  // ══════════════════════════════════════════

  /** 更新配置 */
  setConfig(partial: Partial<OrchestratorConfig>): void {
    this.config = { ...this.config, ...partial }
  }

  /** 获取配置 */
  getConfig(): Readonly<OrchestratorConfig> {
    return { ...this.config }
  }

  /** 是否正在执行编排计划 */
  get executing(): boolean {
    return this._executing
  }

  /** 获取当前活跃计划 */
  get currentPlan(): PreOrchestrationPlan | null {
    return this.activePlan
  }

  /**
   * 设置用户确认回调。
   * 当预编排计划需要用户确认时，通过此回调通知外部。
   */
  setConfirmationHandler(handler: ConfirmationCallback): void {
    this.onConfirmationNeeded = handler
  }

  // ══════════════════════════════════════════
  //  核心：工具调用时触发
  // ══════════════════════════════════════════

  /**
   * 当有工具被调用时调用此方法。
   * 检查是否命中某个模式的触发工具，如果命中则尝试匹配。
   *
   * @param toolName 被调用的工具名
   * @param context 调用上下文
   * @returns 如果匹配到模式并创建了计划，返回计划信息；否则返回 null
   */
  onToolCall(toolName: string, context: ToolCallContext): PreOrchestrationPlan | null {
    if (!this.config.enabled) return null
    if (this._executing) return null // 正在执行中，不触发新匹配

    // 查找以该工具为触发器的启用模式
    const patterns = toolPatternStore.getByTriggerTool(toolName)
    if (patterns.length === 0) return null

    // 对每个候选模式进行上下文匹配
    const matches: Array<{ pattern: BehaviorPattern; score: number; reason: string; vars: Record<string, string> }> = []

    for (const pattern of patterns) {
      const result = this.matchContext(pattern, context)
      if (result && result.score >= this.config.matchThreshold) {
        matches.push(result)
      }
    }

    if (matches.length === 0) return null

    // 选择最佳匹配（最高分）
    matches.sort((a, b) => b.score - a.score)
    const best = matches[0]

    // 取消之前的待确认计划
    this.cancelCurrentPlan()

    // 构建预编排计划
    const plan = this.buildPlan(best.pattern, best.score, best.reason, best.vars, context)
    this.activePlan = plan

    log('INFO', 'pre_orchestration_pattern_matched', {
      pattern: best.pattern.name,
      score: best.score,
      reason: best.reason,
      steps: plan.pendingSteps.length,
    })

    // 判断是否需要用户确认
    const needsConfirmation = best.pattern.confidence < (best.pattern.confirmationThreshold || this.config.confirmationThreshold)

    if (needsConfirmation) {
      plan.status = 'pending_confirmation'
      this.startConfirmationTimer(plan)
      // 通知外部需要确认
      if (this.onConfirmationNeeded) {
        this.onConfirmationNeeded(plan)
      }
    } else {
      // 自动执行
      plan.status = 'confirmed'
      // 异步执行（不阻塞当前调用）
      this.executePlan(plan).catch((err) => {
        log('ERROR', 'pre_orchestration_execution_failed', {
          planId: plan.id,
          error: String(err),
        })
      })
    }

    return plan
  }

  /**
   * 用户确认执行计划。
   * 用户可选择在确认前修改参数。
   *
   * @param planId 计划 ID
   * @param modifiedSteps 用户修改后的步骤（可选）
   */
  async confirm(
    planId: string,
    modifiedSteps?: ResolvedStep[],
  ): Promise<boolean> {
    if (!this.activePlan || this.activePlan.id !== planId) return false
    if (this.activePlan.status !== 'pending_confirmation') return false

    this.clearConfirmationTimer()

    if (modifiedSteps) {
      this.activePlan.pendingSteps = modifiedSteps
    }

    this.activePlan.status = 'confirmed'
    log('INFO', 'pre_orchestration_confirmed', { planId, steps: this.activePlan.pendingSteps.length })

    await this.executePlan(this.activePlan)
    return true
  }

  /**
   * 用户取消计划。
   */
  cancel(planId: string): boolean {
    if (!this.activePlan || this.activePlan.id !== planId) return false
    if (this.activePlan.status === 'executing') return false // 执行中不能取消

    this.clearConfirmationTimer()
    this.activePlan.status = 'cancelled'

    // 记录误匹配（如果有活跃模式）
    if (this.activePlan.pattern) {
      this.recordFalseMatch(this.activePlan.pattern.id)
    }

    log('INFO', 'pre_orchestration_cancelled', { planId })
    this.activePlan = null
    return true
  }

  /**
   * 用户跳过计划中的某个步骤。
   */
  skipStep(planId: string, stepIndex: number): boolean {
    if (!this.activePlan || this.activePlan.id !== planId) return false
    if (this.activePlan.status !== 'executing' && this.activePlan.status !== 'confirmed') return false

    const step = this.activePlan.pendingSteps.find((s) => s.stepIndex === stepIndex)
    if (!step || step.status !== 'pending') return false

    step.status = 'skipped'
    this.activePlan.executionLog.push({
      stepIndex,
      toolName: step.toolName,
      status: 'skipped',
      durationMs: 0,
      timestamp: Date.now(),
    })

    log('INFO', 'pre_orchestration_step_skipped', { planId, stepIndex, tool: step.toolName })
    return true
  }

  // ══════════════════════════════════════════
  //  上下文匹配
  // ══════════════════════════════════════════

  /**
   * 将模式与会话上下文进行匹配。
   * 综合考量：
   * - 用户意图与模式关联类别的相似度
   * - 用户意图与模式关联关键词的匹配度
   * - 当前工具参数与模式参数模板的匹配度
   *
   * @returns 匹配结果，null = 不匹配
   */
  private matchContext(
    pattern: BehaviorPattern,
    context: ToolCallContext,
  ): { pattern: BehaviorPattern; score: number; reason: string; vars: Record<string, string> } | null {
    let score = 0
    const reasons: string[] = []
    const vars: Record<string, string> = {}

    // 1. 类别匹配（权重 0.35）
    if (pattern.associatedCategories.length > 0 && context.category) {
      if (pattern.associatedCategories.includes(context.category)) {
        score += 0.35
        reasons.push(`类别匹配: ${context.category}`)
      } else {
        // 部分匹配：检查是否包含相似类别
        const partialMatch = pattern.associatedCategories.some(
          (cat) => cat.includes(context.category) || context.category.includes(cat),
        )
        if (partialMatch) {
          score += 0.15
          reasons.push('类别部分匹配')
        }
      }
    }

    // 2. 关键词匹配（权重 0.35）
    if (pattern.associatedKeywords.length > 0 && context.intent) {
      const intentLower = context.intent.toLowerCase()
      let keywordMatches = 0
      for (const keyword of pattern.associatedKeywords) {
        if (intentLower.includes(keyword.toLowerCase())) {
          keywordMatches++
          // 提取关键词值作为变量
          vars[keyword] = keyword
        }
      }
      const keywordRatio = keywordMatches / pattern.associatedKeywords.length
      score += keywordRatio * 0.35
      if (keywordRatio > 0) {
        reasons.push(`关键词匹配: ${keywordMatches}/${pattern.associatedKeywords.length}`)
      }
    }

    // 3. 参数匹配（权重 0.2）
    // 检查当前实际参数与模式第一步骤的参数模板的匹配度
    if (pattern.steps.length > 0) {
      const firstStep = pattern.steps[0]
      let paramMatches = 0
      let totalParams = 0
      for (const [paramKey, paramValue] of Object.entries(firstStep.paramTemplate)) {
        totalParams++
        const contextValue = context.args[paramKey]
        if (contextValue !== undefined) {
          const strValue = String(contextValue)
          if (strValue === paramValue || paramValue.includes('${')) {
            // 直接匹配或模板匹配
            if (strValue === paramValue) {
              paramMatches++
            } else {
              // 提取模板变量值
              const match = paramValue.match(/\$\{(\w+)\}/)
              if (match) {
                vars[match[1]] = strValue
                paramMatches++
              }
            }
          }
        }
      }
      if (totalParams > 0) {
        score += (paramMatches / totalParams) * 0.2
      }
    }

    // 4. 频率/置信度加权（权重 0.1）
    const confidenceBonus = pattern.confidence * 0.1
    score += confidenceBonus

    // 5. 误匹配惩罚
    const falseMatchCount = this.falseMatchCounts.get(pattern.id) || 0
    if (falseMatchCount > 0) {
      score = Math.max(0, score - falseMatchCount * 0.1)
    }

    // 综合评分
    score = Math.round(Math.min(score, 1) * 100) / 100

    if (score < this.config.matchThreshold) return null

    const reason = reasons.length > 0 ? reasons.join('; ') : '触发工具匹配'
    return { pattern, score, reason, vars }
  }

  // ══════════════════════════════════════════
  //  计划构建
  // ══════════════════════════════════════════

  /**
   * 从匹配结果构建预编排计划。
   * 解析参数模板（变量替换），生成待执行步骤列表。
   */
  private buildPlan(
    pattern: BehaviorPattern,
    score: number,
    reason: string,
    vars: Record<string, string>,
    context: ToolCallContext,
  ): PreOrchestrationPlan {
    // 构建匹配结果
    const matchResult: PatternMatchResult = {
      pattern,
      score,
      matchReason: reason,
      extractedVars: vars,
      matchedStepIndex: 0,
      remainingSteps: pattern.steps.slice(1), // 第一个工具已调用
    }

    // 解析后续步骤的参数
    const pendingSteps: ResolvedStep[] = pattern.steps.slice(1).map((step, idx) => ({
      stepIndex: idx + 1,
      toolName: step.toolName,
      resolvedArgs: this.resolveArgs(step.paramTemplate, vars, context),
      status: 'pending' as const,
    }))

    return {
      id: `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      pattern,
      matchResult,
      pendingSteps,
      createdAt: Date.now(),
      status: 'pending_confirmation',
      executionLog: [],
    }
  }

  /**
   * 解析参数模板。
   * 支持：
   * - 字面值: "fixed-value" → 直接使用
   * - 变量引用: "${varName}" → 从 vars 或 context 提取
   * - 模板字符串: "prefix-${varName}-suffix" → 插值填充
   */
  private resolveArgs(
    template: Record<string, string>,
    vars: Record<string, string>,
    context: ToolCallContext,
  ): Record<string, any> {
    const resolved: Record<string, any> = {}

    for (const [key, value] of Object.entries(template)) {
      if (!value.includes('${')) {
        // 字面值
        resolved[key] = value
      } else {
        // 模板替换
        resolved[key] = value.replace(/\$\{(\w+)\}/g, (_, varName) => {
          // 优先使用提取的变量
          if (vars[varName] !== undefined) return vars[varName]
          // 其次从上下文 args 提取
          if (context.args[varName] !== undefined) return String(context.args[varName])
          // 最后从 context.intent 提取（关键词匹配）
          if (context.intent.toLowerCase().includes(varName.toLowerCase())) return varName
          // 保留原始占位符
          return `\${${varName}}`
        })
      }
    }

    return resolved
  }

  // ══════════════════════════════════════════
  //  计划执行
  // ══════════════════════════════════════════

  /**
   * 执行预编排计划。
   * 逐个执行待处理步骤，记录执行日志。
   * 遇到失败步骤时，根据步骤的可选性决定跳过还是终止。
   */
  private async executePlan(plan: PreOrchestrationPlan): Promise<void> {
    if (this._executing) return
    this._executing = true

    plan.status = 'executing'

    try {
      for (const step of plan.pendingSteps) {
        if (step.status !== 'pending') continue

        step.status = 'running'
        const startTime = Date.now()

        try {
          // ★ 实际调用工具
          const result = await this.callTool(step.toolName, step.resolvedArgs)
          const durationMs = Date.now() - startTime

          step.status = 'success'
          step.result = result
          step.durationMs = durationMs

          plan.executionLog.push({
            stepIndex: step.stepIndex,
            toolName: step.toolName,
            status: 'success',
            durationMs,
            timestamp: Date.now(),
            result: result.slice(0, 200),
          })
        } catch (err: any) {
          const durationMs = Date.now() - startTime
          step.status = 'failed'
          step.error = err.message
          step.durationMs = durationMs

          plan.executionLog.push({
            stepIndex: step.stepIndex,
            toolName: step.toolName,
            status: 'failed',
            durationMs,
            timestamp: Date.now(),
            error: err.message.slice(0, 500),
          })

          // 非可选步骤失败 → 终止计划
          const patternStep = plan.pattern.steps[step.stepIndex]
          if (!patternStep?.optional) {
            log('WARN', 'pre_orchestration_step_failed_abort', {
              planId: plan.id,
              stepIndex: step.stepIndex,
              tool: step.toolName,
              error: err.message,
            })
            plan.status = 'failed'
            this._executing = false
            this.activePlan = null
            return
          }
        }
      }

      // 全部步骤完成
      plan.status = 'completed'

      // 更新模式匹配记录
      toolPatternStore.recordMatch(plan.pattern.id)

      log('INFO', 'pre_orchestration_completed', {
        planId: plan.id,
        pattern: plan.pattern.name,
        totalSteps: plan.pendingSteps.length,
        successSteps: plan.executionLog.filter((e) => e.status === 'success').length,
        failedSteps: plan.executionLog.filter((e) => e.status === 'failed').length,
      })
    } catch (err: any) {
      plan.status = 'failed'
      log('ERROR', 'pre_orchestration_execution_error', {
        planId: plan.id,
        error: String(err),
      })
    } finally {
      this._executing = false
      this.activePlan = null
      this.clearConfirmationTimer()
    }
  }

  /**
   * 调用工具。
   * 通过 ToolCallChainStore 获取工具执行能力。
   * 实际会通过全局的 tool provider 执行。
   */
  private async callTool(toolName: string, args: Record<string, any>): Promise<string> {
    // 通过事件系统或全局钩子调用工具
    // 这里使用 toolCallLogStore 来记录此预编排调用
    const startTime = Date.now()

    try {
      // 查找工具执行器（通过全局变量）
      const executor = (globalThis as any).__toolExecutor
      if (typeof executor?.executeTool === 'function') {
        const result = await executor.executeTool(toolName, args)
        const durationMs = Date.now() - startTime

        // 记录到日志
        toolCallLogStore.record(
          toolName,
          { ...args, _source: 'pre_orchestration' },
          typeof result === 'string' ? result : JSON.stringify(result),
          null,
          durationMs,
          true,
        )

        return typeof result === 'string' ? result : JSON.stringify(result)
      }

      // 降级：通过 ToolCallChainStore 的 recordLink 模拟
      toolCallLogStore.record(
        toolName,
        { ...args, _source: 'pre_orchestration' },
        '[pre_orchestration] tool execution not available',
        null,
        0,
        true,
      )

      return `[pre_orchestration] ${toolName} 已预编排等待执行`
    } catch (err: any) {
      const durationMs = Date.now() - startTime
      toolCallLogStore.record(
        toolName,
        { ...args, _source: 'pre_orchestration' },
        null,
        err.message,
        durationMs,
        false,
      )
      throw err
    }
  }

  // ══════════════════════════════════════════
  //  确认超时管理
  // ══════════════════════════════════════════

  private startConfirmationTimer(plan: PreOrchestrationPlan): void {
    this.clearConfirmationTimer()
    this.confirmationTimer = setTimeout(() => {
      if (this.activePlan?.id === plan.id && this.activePlan?.status === 'pending_confirmation') {
        log('INFO', 'pre_orchestration_confirmation_timeout', { planId: plan.id })
        this.activePlan.status = 'cancelled'
        this.activePlan = null
      }
    }, this.config.confirmationTimeoutMs)
  }

  private clearConfirmationTimer(): void {
    if (this.confirmationTimer) {
      clearTimeout(this.confirmationTimer)
      this.confirmationTimer = null
    }
  }

  private cancelCurrentPlan(): void {
    if (this.activePlan && this.activePlan.status === 'pending_confirmation') {
      this.activePlan.status = 'cancelled'
    }
    this.clearConfirmationTimer()
    this.activePlan = null
  }

  // ══════════════════════════════════════════
  //  误匹配管理
  // ══════════════════════════════════════════

  /**
   * 记录模式的误匹配。
   * 连续误匹配超过上限时自动禁用模式。
   */
  private recordFalseMatch(patternId: string): void {
    const count = (this.falseMatchCounts.get(patternId) || 0) + 1
    this.falseMatchCounts.set(patternId, count)

    if (count >= this.config.maxFalseMatches) {
      // 自动禁用模式
      toolPatternStore.setEnabled(patternId, false)
      log('WARN', 'pre_orchestration_pattern_disabled', {
        patternId,
        falseMatches: count,
      })
      this.falseMatchCounts.delete(patternId)
    }
  }

  // ══════════════════════════════════════════
  //  生命周期
  // ══════════════════════════════════════════

  /** 重置引擎状态 */
  reset(): void {
    this.cancelCurrentPlan()
    this._executing = false
    this.falseMatchCounts.clear()
  }

  /** 停止引擎（清理资源） */
  shutdown(): void {
    this.reset()
    this.onConfirmationNeeded = null
  }
}

// ══════════════════════════════════════════
//  全局单例
// ══════════════════════════════════════════

export const preOrchestrationEngine = new PreOrchestrationEngine()
