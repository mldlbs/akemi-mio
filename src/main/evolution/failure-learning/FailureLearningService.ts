/**
 * FailureLearningService — 基于失败学习的自修复服务
 *
 * 核心职责：
 * 1. 监听 EventBus 失败事件，记录到 failure_logs 表
 * 2. 在 Evolution 周期中读取未分析失败日志
 * 3. 通过 LLM 分析失败原因（工具描述歧义、任务分解不合理等）
 * 4. 生成改进建议（修改 system prompt / 工具描述 / 任务模板）
 * 5. 自动应用建议（带配置快照）
 * 6. 下一周期评估效果，失败率上升则自动回滚
 *
 * 集成方式：
 * - 注入 SelfEvolutionService，在 runAnalysisCycle() 中调用
 * - 监听 EventBus 事件记录失败
 * - 使用 LlmService.chatJson() 进行 LLM 分析
 */
import { log } from '../../logger/Logger'
import { eventBus } from '../../core/EventBus'
import { LlmService } from '../../llm/LlmService'
import { failureDatabase } from './FailureDatabase'
import { configSnapshotManager } from './ConfigSnapshotManager'
import {
  type FailureLearningConfig,
  type FailureAnalysisResult,
  type FailureErrorType,
  type FailureRateSnapshot,
  DEFAULT_FAILURE_LEARNING_CONFIG,
} from './types'

// ── LLM 分析用的 prompt ──

const FAILURE_ANALYSIS_SYSTEM_PROMPT = `你是一个专业的 Agent 执行失败分析专家。你的任务是：
1. 分析 Agent 执行失败的日志
2. 识别根因（工具描述歧义、任务分解不合理、prompt 指令不清、超时低估等）
3. 生成具体可操作的改进建议

请输出 JSON 格式的分析结果，包含：
- rootCause: 根因摘要
- confidence: 置信度 (0-1)
- category: 失败分类
- detail: 具体分析
- suggestions: 改进建议列表（每项包含 type, targetName, currentValue, suggestedValue, rationale, expectedBenefit）

分类选项：
- tool_description_ambiguity: 工具描述歧义/参数格式不清
- task_decomposition: 任务分解不合理
- prompt_instruction: prompt 指令不够清晰
- timeout_underestimation: 超时低估
- llm_capability_limit: LLM 能力限制
- configuration_error: 配置错误
- unknown: 其他/未知`

function buildFailureAnalysisUserPrompt(failures: any[]): string {
  return `请分析以下 Agent 执行失败记录，找出根因并给出改进建议：

${failures
  .map(
    (f, i) => `[失败 ${i + 1}]
错误类型: ${f.errorType}
错误名称: ${f.errorName}
错误消息: ${f.errorMessage}
错误详情: ${f.errorDetail || '(无)'}
工具状态: ${f.toolState || '(无)'}
LLM输出: ${f.llmOutput || '(无)'}
任务描述: ${f.taskDescription || '(无)'}
--------------------`,
  )
  .join('\n')}

请输出 JSON 格式的分析结果。`
}

// =============================================================================
// FailureLearningService
// =============================================================================

export class FailureLearningService {
  private llmService: LlmService | null = null
  private config: FailureLearningConfig
  private started = false
  private unsubscribers: (() => void)[] = []

  /** 缓存本周期内记录的失败数（用于速率限制） */
  private recentFailureCount = 0
  private lastCycleFailureRate: FailureRateSnapshot | null = null

  constructor(config?: Partial<FailureLearningConfig>) {
    this.config = { ...DEFAULT_FAILURE_LEARNING_CONFIG, ...config }
  }

  /** 注入 LLM 服务引用 */
  setLlmService(llm: LlmService): void {
    this.llmService = llm
  }

  /** 更新配置 */
  updateConfig(config: Partial<FailureLearningConfig>): void {
    this.config = { ...this.config, ...config }
    log('INFO', 'failure_learning_config_updated', { config: this.config })
  }

  /** 获取当前配置 */
  getConfig(): FailureLearningConfig {
    return { ...this.config }
  }

  /** 启动服务：创建表、监听事件 */
  start(): void {
    if (this.started) return
    this.started = true

    // 确保数据库表存在
    failureDatabase.ensureTables()

    // 监听失败事件
    this.unsubscribers.push(
      eventBus.on('agent.tool.failed', (p: any) => {
        this.recordFailure({
          requestId: p.requestId || 'unknown',
          errorType: 'tool',
          errorName: p.tool || 'unknown_tool',
          errorMessage: p.error || 'Unknown tool error',
          errorDetail: p.detail || p.stack || undefined,
          toolState: p.toolState || p.state || undefined,
          llmOutput: p.llmOutput || undefined,
          taskDescription: p.taskDescription || undefined,
        })
      }),
    )

    this.unsubscribers.push(
      eventBus.on('agent.error', (p: any) => {
        this.recordFailure({
          requestId: p.requestId || 'unknown',
          errorType: 'crash',
          errorName: 'agent_error',
          errorMessage: p.error || 'Unknown agent error',
          errorDetail: typeof p.error === 'string' ? p.error : JSON.stringify(p.error),
        })
      }),
    )

    this.unsubscribers.push(
      (eventBus.on as any)('llm.request.failed', (p: any) => {
        this.recordFailure({
          requestId: p.requestId || 'unknown',
          errorType: 'llm',
          errorName: p.model || 'unknown_model',
          errorMessage: p.error || 'LLM request failed',
          errorDetail: p.detail || undefined,
          llmOutput: p.response || undefined,
        })
      }),
    )

    this.unsubscribers.push(
      (eventBus.on as any)('agent.task.failed', (p: any) => {
        this.recordFailure({
          requestId: p.requestId || 'unknown',
          errorType: 'task',
          errorName: p.taskName || 'unknown_task',
          errorMessage: p.error || 'Task execution failed',
          errorDetail: p.detail || undefined,
          taskDescription: p.taskDescription || undefined,
          systemPrompt: p.systemPrompt || undefined,
        })
      }),
    )

    log('INFO', 'failure_learning_service_started', {
      config: this.config,
    })
  }

  /** 停止服务 */
  stop(): void {
    for (const unsub of this.unsubscribers) {
      try {
        unsub()
      } catch {}
    }
    this.unsubscribers = []
    this.started = false
    log('INFO', 'failure_learning_service_stopped')
  }

  /** 是否已启动 */
  isStarted(): boolean {
    return this.started
  }

  // ══════════════════════════════════════════════
  // 失败记录
  // ══════════════════════════════════════════════

  /** 记录一条失败日志 */
  recordFailure(params: {
    requestId: string
    errorType: FailureErrorType
    errorName: string
    errorMessage: string
    errorDetail?: string
    toolState?: string
    llmOutput?: string
    taskDescription?: string
    systemPrompt?: string
  }): void {
    if (!this.config.enabled) return

    const id = `fail_${params.errorType}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    failureDatabase.insertFailureLog({
      id,
      requestId: params.requestId,
      errorType: params.errorType,
      errorName: params.errorName,
      errorMessage: params.errorMessage.slice(0, 500),
      errorDetail: params.errorDetail?.slice(0, 2000),
      toolState: params.toolState,
      llmOutput: params.llmOutput?.slice(0, 1000),
      taskDescription: params.taskDescription?.slice(0, 500),
      systemPrompt: params.systemPrompt?.slice(0, 1000),
    })

    this.recentFailureCount++
  }

  // ══════════════════════════════════════════════
  // LLM 分析
  // ══════════════════════════════════════════════

  /**
   * 分析未处理的失败日志并生成改进建议。
   * 在 Evolution 周期中调用。
   *
   * @returns 分析结果摘要
   */
  async analyzeAndSuggest(): Promise<{
    analyzed: number
    suggestions: number
    summary: string
  }> {
    if (!this.config.enabled) {
      return { analyzed: 0, suggestions: 0, summary: '失败学习服务已禁用' }
    }

    const unanalyzedCount = failureDatabase.getUnanalyzedCount()
    if (unanalyzedCount < this.config.minFailureSamples) {
      return {
        analyzed: 0,
        suggestions: 0,
        summary: `未分析失败日志不足（现有 ${unanalyzedCount} 条，需要 ${this.config.minFailureSamples} 条）`,
      }
    }

    const failures = failureDatabase.getUnanalyzedFailures(this.config.maxFailuresToAnalyze)
    if (failures.length === 0) {
      return { analyzed: 0, suggestions: 0, summary: '无未分析的失败日志' }
    }

    if (!this.llmService) {
      log('WARN', 'failure_learning_no_llm_service')
      return { analyzed: 0, suggestions: 0, summary: 'LLM 服务未配置' }
    }

    log('INFO', 'failure_learning_analysis_start', {
      failureCount: failures.length,
    })

    // 分批分析（每批最多 5 条，避免超出 LLM 上下文）
    const batchSize = 5
    let totalAnalyzed = 0
    let totalSuggestions = 0
    const summaryParts: string[] = []

    for (let i = 0; i < failures.length; i += batchSize) {
      const batch = failures.slice(i, i + batchSize)
      const result = await this.analyzeBatch(batch)

      if (result) {
        totalAnalyzed += batch.length

        // 标记为已分析
        for (const f of batch) {
          failureDatabase.markAnalyzed(f.id, JSON.stringify(result))
        }

        // 生成改进建议
        if (result.suggestions && result.suggestions.length > 0) {
          for (const suggestion of result.suggestions) {
            const suggestionId = `sug_${suggestion.type}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

            failureDatabase.insertSuggestion({
              id: suggestionId,
              suggestionType: suggestion.type,
              targetName: suggestion.targetName,
              currentValue: suggestion.currentValue,
              suggestedValue: suggestion.suggestedValue,
              rationale: suggestion.rationale,
              failurePattern: result.rootCause,
            })

            // 关联到失败记录
            for (const f of batch) {
              failureDatabase.markHasSuggestion(f.id, suggestionId)
            }

            totalSuggestions++
          }

          summaryParts.push(
            `分析 ${batch.length} 条失败记录 → 发现根因: ${result.rootCause.slice(0, 60)}，生成 ${result.suggestions.length} 条建议`,
          )
        } else {
          summaryParts.push(
            `分析 ${batch.length} 条失败记录 → 根因: ${result.rootCause.slice(0, 60)}，无需改进`,
          )
        }
      } else {
        // 分析失败：标记为已分析但无结果
        for (const f of batch) {
          failureDatabase.markAnalyzed(f.id, JSON.stringify({ error: 'LLM analysis failed' }))
        }
        summaryParts.push(`分析 ${batch.length} 条失败记录 → LLM 分析失败`)
      }
    }

    const summary = summaryParts.join('\n')
    log('INFO', 'failure_learning_analysis_complete', {
      analyzed: totalAnalyzed,
      suggestions: totalSuggestions,
    })

    return {
      analyzed: totalAnalyzed,
      suggestions: totalSuggestions,
      summary,
    }
  }

  /**
   * 对一批失败记录进行 LLM 分析。
   */
  private async analyzeBatch(
    batch: Array<{
      id: string
      errorType: string
      errorName: string
      errorMessage: string
      errorDetail: string | null
      toolState: string | null
      llmOutput: string | null
      taskDescription: string | null
      systemPrompt: string | null
    }>,
  ): Promise<FailureAnalysisResult | null> {
    if (!this.llmService) return null

    try {
      const result = await this.llmService.chatJson(buildFailureAnalysisUserPrompt(batch), {
        system: FAILURE_ANALYSIS_SYSTEM_PROMPT,
        temperature: 0.3,
        timeoutMs: 30000,
        requestId: `failure_analysis_${Date.now()}`,
      })

      if (result.error) {
        log('WARN', 'failure_analysis_llm_error', { error: result.error })
        return null
      }

      if (!result.data) {
        log('WARN', 'failure_analysis_empty_result')
        return null
      }

      const analysis = result.data as FailureAnalysisResult

      // 验证必要字段
      if (!analysis.rootCause || !analysis.category) {
        log('WARN', 'failure_analysis_incomplete_result', { data: JSON.stringify(analysis).slice(0, 200) })
        return null
      }

      return analysis
    } catch (err: any) {
      log('ERROR', 'failure_analysis_exception', { error: err.message })
      return null
    }
  }

  // ══════════════════════════════════════════════
  // 建议应用
  // ══════════════════════════════════════════════

  /**
   * 应用待处理的改进建议。
   * 每次修改前创建配置快照。
   *
   * @returns 应用结果摘要
   */
  async applyPendingSuggestions(): Promise<{
    applied: number
    skipped: number
    details: string[]
  }> {
    if (!this.config.enabled || !this.config.autoApply) {
      return { applied: 0, skipped: 0, details: ['自动应用未启用（autoApply=false）'] }
    }

    const pending = failureDatabase.getPendingSuggestions(5)
    if (pending.length === 0) {
      return { applied: 0, skipped: 0, details: ['无待处理的建议'] }
    }

    const applied: string[] = []
    let appliedCount = 0
    let skippedCount = 0

    for (const suggestion of pending) {
      try {
        // 创建快照（修改前）
        const snapshotId = await configSnapshotManager.createBeforeModification({
          snapshotType: suggestion.suggestionType,
          configKey: suggestion.targetName,
          oldValue: suggestion.currentValue,
          newValue: suggestion.suggestedValue,
          suggestionId: suggestion.id,
        })

        // 执行实际修改（由各类型的具体实现接管）
        const applyResult = await this.applySuggestionByType(
          suggestion.suggestionType,
          suggestion.targetName,
          suggestion.suggestedValue,
        )

        if (applyResult) {
          // 更新建议状态
          failureDatabase.updateSuggestionStatus(suggestion.id, 'applied', snapshotId)

          appliedCount++
          applied.push(
            `✅ [${suggestion.suggestionType}] ${suggestion.targetName}: ${suggestion.rationale.slice(0, 60)}`,
          )
          log('INFO', 'suggestion_applied', {
            id: suggestion.id,
            type: suggestion.suggestionType,
            target: suggestion.targetName,
            snapshotId,
          })
        } else {
          // 应用失败（类型不支持等），标记为 rejected
          failureDatabase.updateSuggestionStatus(suggestion.id, 'rejected')
          skippedCount++
          applied.push(
            `⚠️ [${suggestion.suggestionType}] ${suggestion.targetName}: 应用失败（类型不支持）`,
          )
        }
      } catch (err: any) {
        log('ERROR', 'suggestion_apply_error', {
          id: suggestion.id,
          error: err.message,
        })
        failureDatabase.updateSuggestionStatus(suggestion.id, 'rejected')
        skippedCount++
      }
    }

    return {
      applied: appliedCount,
      skipped: skippedCount,
      details: applied,
    }
  }

  /**
   * 按类型执行建议的实际修改。
   * 当前为桩实现，记录日志但不实际修改（TODO 项）。
   */
  private async applySuggestionByType(
    type: string,
    targetName: string,
    suggestedValue: string,
  ): Promise<boolean> {
    switch (type) {
      case 'modify_tool_description':
        // TODO: 接入 ToolRegistry.updateToolDescription()
        log('INFO', 'apply_tool_description', { targetName, suggestedValue: suggestedValue.slice(0, 200) })
        return false // 尚未接入实际修改

      case 'modify_system_prompt':
        // TODO: 接入 AgentService 的 system prompt 管理
        log('INFO', 'apply_system_prompt', { targetName, suggestedValue: suggestedValue.slice(0, 200) })
        return false

      case 'modify_task_template':
        // TODO: 接入 TaskTemplateManager
        log('INFO', 'apply_task_template', { targetName, suggestedValue: suggestedValue.slice(0, 200) })
        return false

      case 'modify_agent_config':
        log('INFO', 'apply_agent_config', { targetName, suggestedValue: suggestedValue.slice(0, 200) })
        return false

      default:
        log('WARN', 'apply_unknown_suggestion_type', { type })
        return false
    }
  }

  // ══════════════════════════════════════════════
  // 回滚评估
  // ══════════════════════════════════════════════

  /**
   * 评估是否需要回滚之前的配置变更。
   * 在 Evolution 周期中调用。
   *
   * @returns 回滚结果摘要
   */
  async evaluateRollback(): Promise<{
    evaluated: boolean
    rolledBack: number
    details: string[]
  }> {
    if (!this.config.enabled) {
      return { evaluated: false, rolledBack: 0, details: ['失败学习服务已禁用'] }
    }

    const currentRate = failureDatabase.computeCurrentFailureRate(50)

    // 与前一次快照的 pre_rate 比较
    const prevRate = failureDatabase.getPreviousFailureRate()
    if (prevRate !== null) {
      const delta = currentRate.failureRate - prevRate
      log('INFO', 'failure_rate_change', {
        previousRate: (prevRate * 100).toFixed(1) + '%',
        currentRate: (currentRate.failureRate * 100).toFixed(1) + '%',
        delta: (delta * 100).toFixed(1) + '%',
        threshold: (this.config.rollbackThreshold * 100).toFixed(1) + '%',
      })
    }

    // 评估回滚需求
    const toRollBack = await configSnapshotManager.evaluateRollback(
      currentRate,
      this.config.rollbackThreshold,
    )

    if (toRollBack.length === 0) {
      return {
        evaluated: true,
        rolledBack: 0,
        details: ['无需回滚'],
      }
    }

    const details: string[] = []
    let rolledBackCount = 0

    for (const { snapshot, reason } of toRollBack) {
      if (this.config.autoRollback) {
        const success = await configSnapshotManager.rollback(snapshot)
        if (success) {
          rolledBackCount++
          details.push(`✅ 回滚 ${snapshot.snapshotType}[${snapshot.configKey}]: ${reason}`)
        } else {
          details.push(`❌ 回滚失败 ${snapshot.snapshotType}[${snapshot.configKey}]: ${reason}`)
        }
      } else {
        details.push(`🔍 需要回滚但自动回滚未启用: ${snapshot.snapshotType}[${snapshot.configKey}]: ${reason}`)
      }
    }

    return {
      evaluated: true,
      rolledBack: rolledBackCount,
      details,
    }
  }

  // ══════════════════════════════════════════════
  // 完整周期
  // ══════════════════════════════════════════════

  /**
   * 执行完整的失败学习周期（单次调用）：
   * 1. 分析失败日志 → 生成建议
   * 2. 应用待处理建议（如 autoApply=true）
   * 3. 评估回滚需求（检查之前变更的效果）
   *
   * 在 Evolution 周期的后处理阶段调用。
   */
  async runFullCycle(): Promise<{
    analysis: { analyzed: number; suggestions: number; summary: string }
    applyResult: { applied: number; skipped: number; details: string[] }
    rollbackResult: { evaluated: boolean; rolledBack: number; details: string[] }
  }> {
    // 步骤 1: 分析
    const analysis = await this.analyzeAndSuggest()

    // 步骤 2: 应用建议（如果 autoApply 启用）
    const applyResult = await this.applyPendingSuggestions()

    // 步骤 3: 评估回滚
    const rollbackResult = await this.evaluateRollback()

    // 重置本周期计数
    this.recentFailureCount = 0

    return { analysis, applyResult, rollbackResult }
  }

  /** 获取统计信息 */
  getStats(): {
    unanalyzedCount: number
    pendingSuggestions: number
    appliedSuggestions: number
    recentFailureCount: number
  } {
    return {
      unanalyzedCount: failureDatabase.getUnanalyzedCount(),
      pendingSuggestions: failureDatabase.getPendingSuggestions(100).length,
      appliedSuggestions: failureDatabase.getSuggestionsPendingVerification().length,
      recentFailureCount: this.recentFailureCount,
    }
  }
}
