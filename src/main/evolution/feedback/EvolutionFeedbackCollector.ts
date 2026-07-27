/**
 * EvolutionFeedbackCollector — 自进化行为反馈闭环采集器
 *
 * 采集用户对进化计划执行结果的隐性反馈信号：
 * 1. Git 回滚检测：检查进化计划修改的文件是否被用户回滚
 * 2. 工具重试检测：检查被进化修改过的模块是否出现高频重试
 * 3. 错误率检测：检查进化修改后是否出现错误率飙升
 *
 * 输出：
 * - 每个检测到的负反馈生成一个 'evidence' 来源的 Problem
 * - Problem 包含具体的模块名、拒绝信号强度和描述
 *
 * 集成方式：
 * - 作为 SignalCollector 注册到 PipelineOrchestrator
 * - 生成的 Problem 供 ModuleFeedbackManager 消费
 * - 也可直接调用 updateModuleFeedback() 更新 ModuleFeedbackManager
 */

import { log } from '../../logger/Logger'
import type { SignalCollector, Problem } from '../automation/types'
import { moduleFeedbackManager } from './ModuleFeedbackManager'
import { userBehaviorAnalyzer } from '../../agent/UserBehaviorAnalyzer'
import type { RejectionSignalType } from './types'

// =============================================================================
// 配置常量
// =============================================================================

/** 最小采集间隔：30 分钟 */
const MIN_INTERVAL_MS = 30 * 60 * 1000

/** 检查 Git 回滚的时间窗口（毫秒）：最近 1 小时 */
const GIT_REVERT_WINDOW_MS = 60 * 60 * 1000

/** 工具重试检测：同一工具在窗口内连续调用 >= 此值视为重试 */
const RETRY_THRESHOLD = 3

/** 错误率飙升阈值：窗口内错误率大于此值视为飙升 */
const ERROR_RATE_SURGE_THRESHOLD = 0.4

/** 最少工具调用样本数：低于此值不触发错误率检测 */
const MIN_TOOL_CALL_SAMPLES = 5

/** 每周期最大问题数 */
const MAX_PROBLEMS_PER_CYCLE = 3

// =============================================================================
// EvolutionFeedbackCollector
// =============================================================================

export class EvolutionFeedbackCollector implements SignalCollector {
  readonly name = 'evolution-feedback-collector'
  readonly source = 'evidence' as const

  private lastRun = 0

  shouldRun(): boolean {
    if (Date.now() - this.lastRun < MIN_INTERVAL_MS) return false
    return true
  }

  getSkipReason(): string {
    if (Date.now() - this.lastRun < MIN_INTERVAL_MS) {
      const remaining = Math.round((MIN_INTERVAL_MS - (Date.now() - this.lastRun)) / 1000)
      return `cooldown: ${remaining}s remaining`
    }
    return 'unknown'
  }

  async collect(): Promise<Problem[]> {
    this.lastRun = Date.now()
    const problems: Problem[] = []

    try {
      // ── 阶段 1：读取已记录的进化计划，获取最近修改过的模块 ──
      const recentModules = moduleFeedbackManager.getRecentModifiedModules(60 * 60 * 1000)

      if (recentModules.length === 0) {
        log('INFO', 'evolution_feedback_collector_no_recent_changes')
        return []
      }

      log('INFO', 'evolution_feedback_collector_recent_modules', {
        modules: recentModules,
        count: recentModules.length,
      })

      // ── 阶段 2：对每个被修改过的模块检查用户反馈信号 ──
      for (const moduleName of recentModules) {
        const signals = await this.detectRejectionSignals(moduleName)

        for (const signal of signals) {
          const problemId = `evolution_feedback:${signal.moduleName}:${signal.type}:${signal.timestamp}`

          problems.push({
            id: problemId,
            source: 'evidence',
            severity: signal.strength >= 0.6 ? 'error' : signal.strength >= 0.3 ? 'warning' : 'info',
            title: `用户拒绝信号: ${signal.moduleName} 模块 (${this.signalTypeLabel(signal.type)})`,
            description: signal.description,
            estimatedCostChars: 100,
            lastSeen: signal.timestamp,
            occurrenceCount: 1,
            context: {
              raw: `拒绝信号类型: ${signal.type}\n模块: ${signal.moduleName}\n强度: ${signal.strength}\n描述: ${signal.description}\n文件: ${signal.affectedFiles.join(', ')}`,
              metadata: {
                moduleName: signal.moduleName,
                signalType: signal.type,
                strength: String(signal.strength),
                relatedPlanRunId: signal.relatedPlanRunId || '',
                affectedFiles: signal.affectedFiles.join(','),
              },
            },
          })
        }

        // ── 阶段 3：将检测到的信号应用到 ModuleFeedbackManager ──
        for (const signal of signals) {
          moduleFeedbackManager.recordRejection(signal.moduleName, signal.type, signal.strength, signal.description)
          log('INFO', 'evolution_feedback_signal_recorded', {
            module: signal.moduleName,
            type: signal.type,
            strength: signal.strength,
            description: signal.description.slice(0, 80),
          })
        }
      }

      // 如果问题太多，只保留最高优先级的
      if (problems.length > MAX_PROBLEMS_PER_CYCLE) {
        problems.sort((a, b) => {
          const severityOrder = { error: 3, warning: 2, info: 1 }
          return (severityOrder[b.severity] || 0) - (severityOrder[a.severity] || 0)
        })
        problems.splice(MAX_PROBLEMS_PER_CYCLE)
      }

      log('INFO', 'evolution_feedback_collector_done', {
        modulesChecked: recentModules.length,
        signalsDetected: problems.length,
      })
    } catch (err: any) {
      log('ERROR', 'evolution_feedback_collector_error', { error: err.message })
    }

    return problems
  }

  // ===========================================================================
  // 拒绝信号检测
  // ===========================================================================

  /**
   * 对指定模块检测所有类型的拒绝信号。
   * 返回检测到的信号列表。
   */
  private async detectRejectionSignals(moduleName: string): Promise<Array<{
    type: RejectionSignalType
    moduleName: string
    strength: number
    affectedFiles: string[]
    timestamp: number
    description: string
    relatedPlanRunId?: string
  }>> {
    const signals: Array<{
      type: RejectionSignalType
      moduleName: string
      strength: number
      affectedFiles: string[]
      timestamp: number
      description: string
      relatedPlanRunId?: string
    }> = []

    const now = Date.now()

    // ── 1. Git 回滚检测 ──
    const gitSignal = this.detectGitRevert(moduleName)
    if (gitSignal) {
      signals.push(gitSignal)
    }

    // ── 2. 工具重试检测 ──
    const retrySignal = this.detectToolRetry(moduleName, now)
    if (retrySignal) {
      signals.push(retrySignal)
    }

    // ── 3. 错误率飙升检测 ──
    const errorSignal = this.detectErrorSpike(moduleName, now)
    if (errorSignal) {
      signals.push(errorSignal)
    }

    return signals
  }

  /**
   * 检测 Git 回滚信号。
   * 检查 evolution 工作区下的 git 日志，看是否有文件被 revert 或 reset。
   */
  private detectGitRevert(moduleName: string): {
    type: RejectionSignalType
    moduleName: string
    strength: number
    affectedFiles: string[]
    timestamp: number
    description: string
  } | null {
    try {
      // 通过 ModuleFeedbackManager 检查是否有记录的回滚
      const revertCount = moduleFeedbackManager.getModuleRevertCount(moduleName)
      if (revertCount <= 0) return null

      const state = moduleFeedbackManager.getModuleState(moduleName)
      if (!state) return null

      // 回滚信号强度：回滚次数越多越强
      const strength = Math.min(0.3 + revertCount * 0.2, 0.9)

      return {
        type: 'git_revert',
        moduleName,
        strength,
        affectedFiles: state.recentSignals
          .filter((s) => s.type === 'git_revert')
          .map(() => ''),
        timestamp: Date.now(),
        description: `模块 "${moduleName}" 的进化修改被回滚 ${revertCount} 次，表明用户未接受该模块的自动修改`,
      }
    } catch {
      return null
    }
  }

  /**
   * 检测工具重试信号。
   * 通过 UserBehaviorAnalyzer 检查该模块关联的工具是否有高频重试。
   */
  private detectToolRetry(moduleName: string, now: number): {
    type: RejectionSignalType
    moduleName: string
    strength: number
    affectedFiles: string[]
    timestamp: number
    description: string
  } | null {
    try {
      // 将模块名映射到关联的工具名
      const relatedTools = this.mapModuleToTools(moduleName)

      let totalRetries = 0
      for (const toolName of relatedTools) {
        const quality = userBehaviorAnalyzer.getToolQualityMetrics()
        const metrics = quality.get(toolName)
        if (!metrics) continue

        // 如果工具在窗口内调用次数超过阈值且最近一次失败，视为重试
        if (metrics.totalCalls >= RETRY_THRESHOLD && !metrics.lastSuccess) {
          totalRetries++
        }
      }

      if (totalRetries <= 0) return null

      // 重试信号强度：重试的工具数 / 关联工具数
      const strength = Math.min(totalRetries / Math.max(relatedTools.length, 1), 0.8)

      return {
        type: 'tool_retry',
        moduleName,
        strength,
        affectedFiles: [],
        timestamp: now,
        description: `模块 "${moduleName}" 的 ${totalRetries} 个关联工具出现高频重试，可能因进化修改导致功能异常`,
      }
    } catch {
      return null
    }
  }

  /**
   * 检测错误率飙升信号。
   * 通过 UserBehaviorAnalyzer 检查该模块关联的工具的错误率。
   */
  private detectErrorSpike(moduleName: string, now: number): {
    type: RejectionSignalType
    moduleName: string
    strength: number
    affectedFiles: string[]
    timestamp: number
    description: string
  } | null {
    try {
      const relatedTools = this.mapModuleToTools(moduleName)
      let totalCalls = 0
      let totalErrors = 0

      const quality = userBehaviorAnalyzer.getToolQualityMetrics()
      for (const toolName of relatedTools) {
        const metrics = quality.get(toolName)
        if (!metrics) continue
        totalCalls += metrics.totalCalls
        if (!metrics.lastSuccess) {
          // 最近一次失败计数
          totalErrors += metrics.totalCalls > 0 ? 1 : 0
        }
      }

      if (totalCalls < MIN_TOOL_CALL_SAMPLES) return null

      const errorRate = totalCalls > 0 ? totalErrors / totalCalls : 0
      if (errorRate < ERROR_RATE_SURGE_THRESHOLD) return null

      // 错误率飙升信号强度：按错误率比例
      const strength = Math.min(errorRate, 0.9)

      return {
        type: 'error_spike',
        moduleName,
        strength,
        affectedFiles: [],
        timestamp: now,
        description: `模块 "${moduleName}" 的关联工具错误率 ${(errorRate * 100).toFixed(0)}%（${totalErrors}/${totalCalls}），超过阈值 ${(ERROR_RATE_SURGE_THRESHOLD * 100).toFixed(0)}%`,
      }
    } catch {
      return null
    }
  }

  // ===========================================================================
  // 辅助方法
  // ===========================================================================

  /**
   * 将模块名映射到关联的工具名。
   * 用于从工具调用数据反推模块反馈。
   */
  private mapModuleToTools(moduleName: string): string[] {
    const moduleToolMap: Record<string, string[]> = {
      tool: ['grep', 'read_file', 'write_file', 'edit_file', 'list_files', 'run_command'],
      tts: ['tts_speak', 'tts_config'],
      asr: ['asr_recognize', 'asr_config'],
      memory: ['remember_fact', 'search_memory', 'list_memories'],
      agent: ['analyze_task', 'analyze_codebase', 'create_dev_plan'],
      creativity: ['generate_idea', 'evaluate_idea'],
      writing: ['writing_system', 'chapter_edit'],
      evolution: ['evolution_trigger', 'evolution_status'],
      file_organizer: ['file_organize'],
      wallpaper: ['wallpaper_generate', 'wallpaper_set'],
      piper: ['piper_speak', 'piper_config'],
      radar: ['radar_scan', 'radar_analyze'],
      telegram: ['telegram_send', 'telegram_poll'],
    }
    return moduleToolMap[moduleName] || []
  }

  /**
   * 将信号类型转为中文标签。
   */
  private signalTypeLabel(type: RejectionSignalType): string {
    const labels: Record<RejectionSignalType, string> = {
      git_revert: 'Git 回滚',
      tool_retry: '工具重试',
      error_spike: '错误率飙升',
      undo_operation: '用户撤销',
      repeated_fix: '反复修复',
    }
    return labels[type] || type
  }

  /**
   * 记录一条进化计划执行记录到 ModuleFeedbackManager。
   * 供 SelfEvolutionService 在管道执行后调用。
   */
  recordPlanExecution(planTitle: string, moduleChanges: Array<{ moduleName: string; filePaths: string[]; changeType: string }>): void {
    moduleFeedbackManager.recordPlanExecution(
      planTitle,
      moduleChanges.map((mc) => ({
        moduleName: mc.moduleName,
        filePaths: mc.filePaths,
        changeType: mc.changeType as EvolutionModuleChange['changeType'],
      })),
    )
  }
}

// 导入类型（仅在 recordPlanExecution 中使用）
import type { EvolutionModuleChange } from './types'

/** 全局单例 */
export const evolutionFeedbackCollector = new EvolutionFeedbackCollector()
