/**
 * PiperEvolutionPlugin — Evolution × PiperTTS 深度融合插件
 *
 * 实现 EvolutionPlugin 契约，将 PiperTTS 的性能数据和状态变化
 * 以插件形式接入 Evolution 系统。
 *
 * 职责：
 *   1. collect() — 采集 PiperTTS 性能退化问题（失败率、延迟、队列）
 *   2. fix() — 执行修复操作（切换模型、调整配置、重置队列）
 *
 * 与现有 TtsPreferenceCollector / TtsConfigOptimizationExecutor 的区别：
 *   - 现有组件处理 TTS 系统的偏好学习和配置优化（用户隐式反馈驱动）
 *   - 本插件处理 Piper 引擎本身的性能监控和问题修复（引擎健康驱动）
 *
 * 注册方式（在 AppRuntime.ts 中）：
 *   const loader = PluginServiceLoader.getInstance()
 *   loader.register(new PiperEvolutionPlugin())
 *   await loader.loadAll()
 */

import { log } from '../../logger/Logger'
import { piperOrchestrator } from '../../tts/PiperOrchestrator'
import { ttsPiperBridge } from '../../tts/TtsPiperBridge'
import { evolutionPiperBridge } from './EvolutionPiperBridge'
import { piperReasoningChainExecutor } from '../../tts/reasoning'
import type {
  EvolutionPlugin,
  EvolutionPluginManifest,
  PluginProblem,
  PluginFixResult,
} from '../plugin/types'

import type { ProblemSource } from '../automation/types'
import type { AssignedProblem } from '../automation/types'
import type { FixResult } from '../automation/types'
import type { PiperFailureCategory, PiperFailureSeverity } from '../../tts/reasoning/types'

// ════════════════════════════════════════════
//  问题 ID 前缀
// ════════════════════════════════════════════

const PROBLEM_ID_PREFIX = 'piper:'

// ════════════════════════════════════════════
//  PiperEvolutionPlugin
// ════════════════════════════════════════════

/**
 * PiperEvolutionPlugin — Evolution × PiperTTS 深度融合插件
 *
 * 【反 PiperTTS 反转】:
 * 默认使用 PiperReasoningChainExecutor 替代直接 fix() 操作。
 * 推理链将故障恢复变成一个可中断/可恢复的分步过程（反向应用实验43模式）。
 *
 * 通过 enableReasoningChain 切换控制：
 * - true（默认）: fix() 委托给推理链，生成 Plan 支持中断恢复
 * - false: 使用旧有直接 switchModel / reset 操作（向后兼容）
 */

export class PiperEvolutionPlugin implements EvolutionPlugin {
  readonly manifest: EvolutionPluginManifest = {
    name: 'piper-evolution',
    version: '2.0.0',
    description: 'PiperTTS 引擎健康监控与自动优化插件 — 检测模型失败、高延迟、队列过载等问题并自动修复（v2: 支持推理链中断恢复）',
    capabilities: ['collect', 'optimize'],
  }

  private _loaded = false

  /**
   * 是否启用推理链恢复模式。
   * true  = 使用 PiperReasoningChainExecutor（中断可恢复）
   * false = 使用旧有直接 fix 操作 (switchModel/reset)
   */
  private enableReasoningChain = true

  // ══════════════════════════════════════════
  //  EvolutionPlugin 接口实现
  // ══════════════════════════════════════════

  isAvailable(): boolean {
    return this._loaded
  }

  /**
   * 采集 PiperTTS 性能退化问题。
   *
   * 通过 EvolutionPiperBridge 检测以下问题：
   * - 模型失败率过高 → 建议切换模型或检查模型文件
   * - 合成延迟过高 → 建议优化系统资源或切换轻量模型
   * - 队列过载 → 建议优化合成频率
   * - 回退链异常 → 建议检查模型文件完整性
   * - 整体退化 → 综合性能下降告警
   */
  async collect(): Promise<PluginProblem[]> {
    const problems: PluginProblem[] = []

    try {
      const descriptors = evolutionPiperBridge.detectProblems()

      for (const desc of descriptors) {
        const problemId = `${PROBLEM_ID_PREFIX}${desc.category}${desc.model ? `:${desc.model}` : ''}:${Date.now()}`

        problems.push({
          id: problemId,
          title: this.getProblemTitle(desc.category),
          description: desc.detail,
          severity: this.getProblemSeverity(desc.category),
          estimatedCostChars: 300,
          context: {
            raw: `[piper_evolution] ${desc.detail}
category: ${desc.category}
model: ${desc.model ?? '(global)'}
currentValue: ${desc.currentValue}
threshold: ${desc.threshold}`,
            category: desc.category,
            model: desc.model ?? '',
            currentValue: String(desc.currentValue),
            threshold: String(desc.threshold),
          },
        })
      }

      log('INFO', 'piper_evolution_plugin_collected', {
        problemsCreated: problems.length,
        categories: problems.map((p) => p.context.category ?? 'unknown').join(','),
      })
    } catch (err: any) {
      log('ERROR', 'piper_evolution_plugin_collect_error', { error: err.message })
    }

    return problems
  }

  /**
   * 设置是否启用推理链恢复模式。
   */
  setReasoningChainMode(enabled: boolean): void {
    this.enableReasoningChain = enabled
    log('INFO', 'piper_evolution_plugin_reasoning_mode', { enabled })
  }

  /**
   * 修复 PiperTTS 性能问题。
   *
   * 当 enableReasoningChain=true（默认）：
   *   fix() 委托给 PiperReasoningChainExecutor，生成完整的推理链，
   *   通过 PlanManager 持久化 Plan 支持中断恢复。
   *   这是反 PiperTTS 反转的主要体现：Piper 拥有与 ASR 同等的恢复能力。
   *
   * 当 enableReasoningChain=false：
   *   使用旧有直接 switchModel / reset 操作（向后兼容）。
   *
   * 支持的操作（旧有模式）：
   * - model_failure_rate: 切换为默认模型（huayan-medium）
   * - high_latency: 切换为轻量模型
   * - queue_overload: 重置队列
   * - fallback_chain: 切换为默认模型并重置
   * - degradation: 切换为默认模型并重置
   */
  async fix(problem: PluginProblem): Promise<PluginFixResult> {
    const t0 = Date.now()
    const category = (problem.context.category ?? '') as string

    log('INFO', 'piper_evolution_plugin_fix_start', {
      problemId: problem.id,
      category,
      reasoningChain: this.enableReasoningChain,
    })

    try {
      // ── 推理链模式：委托给 PiperReasoningChainExecutor ──
      if (this.enableReasoningChain) {
        return await this.fixWithReasoningChain(problem, t0)
      }

      // ── 旧有模式：直接操作 ──
      switch (category) {
        case 'model_failure_rate':
          return this.fixModelFailure(problem, t0)
        case 'high_latency':
          return this.fixHighLatency(problem, t0)
        case 'queue_overload':
          return this.fixQueueOverload(problem, t0)
        case 'fallback_chain':
          return this.fixFallbackChain(problem, t0)
        case 'degradation':
          return this.fixDegradation(problem, t0)
        default:
          return {
            problemId: problem.id,
            success: false,
            summary: `未知的 Piper 问题类型: ${category}`,
            durationMs: Date.now() - t0,
            error: 'unknown_category',
          }
      }
    } catch (err: any) {
      log('ERROR', 'piper_evolution_plugin_fix_error', {
        problemId: problem.id,
        error: err.message,
      })
      return {
        problemId: problem.id,
        success: false,
        summary: `Piper 修复失败: ${err.message}`,
        durationMs: Date.now() - t0,
        error: err.message,
      }
    }
  }

  /**
   * 使用推理链执行修复。
   * 将问题委托给 PiperReasoningChainExecutor 生成分步可恢复的恢复链。
   */
  private async fixWithReasoningChain(problem: PluginProblem, t0: number): Promise<PluginFixResult> {
    const category = this.mapCategoryToFailureCategory(problem.context.category ?? '')
    const currentValue = parseFloat(problem.context.currentValue ?? '0')
    const threshold = parseFloat(problem.context.threshold ?? '0')
    const model = problem.context.model || undefined

    const chainResult = await piperReasoningChainExecutor.execute({
      problemId: problem.id,
      failureCategory: category,
      currentValue,
      threshold,
      model,
      detail: problem.description,
      severity: this.mapSeverity(problem.severity),
      metadata: {
        ...problem.context.metadata,
        raw: problem.context.raw,
      },
    })

    const stepDetails = chainResult.stepResults
      .map((r) => `[${r.success ? '✓' : '✗'}] 步骤${r.index}: ${r.description} (${(r.durationMs / 1000).toFixed(1)}s)`)
      .join('\n')

    const summary = chainResult.allSucceeded
      ? [
          '✅ Piper 推理链恢复完成',
          '',
          `故障类型: ${category}`,
          `步骤: ${chainResult.succeeded}/${chainResult.totalSteps} 全部成功`,
          chainResult.planId ? `Plan ID: ${chainResult.planId}` : '',
          '',
          stepDetails,
        ].filter(Boolean).join('\n')
      : [
          '⚠️ Piper 推理链部分完成',
          '',
          `故障类型: ${category}`,
          `步骤: ${chainResult.succeeded}/${chainResult.totalSteps}`,
          chainResult.planId ? `Plan ID: ${chainResult.planId} (可恢复)` : '',
          '',
          stepDetails,
          '',
          '推理链已通过 PlanManager 持久化，可在下次会话中恢复执行。',
        ].filter(Boolean).join('\n')

    return {
      problemId: problem.id,
      success: chainResult.allSucceeded,
      summary,
      durationMs: Date.now() - t0,
      output: JSON.stringify({
        reasoningChain: true,
        allSucceeded: chainResult.allSucceeded,
        totalSteps: chainResult.totalSteps,
        succeededSteps: chainResult.succeeded,
        planId: chainResult.planId,
      }),
    }
  }

  /**
   * 将 PluginProblem 的 category 字符串映射为 PiperFailureCategory。
   */
  private mapCategoryToFailureCategory(category: string): PiperFailureCategory {
    const mapping: Record<string, PiperFailureCategory> = {
      model_failure_rate: 'model_failure',
      high_latency: 'high_latency',
      queue_overload: 'queue_overload',
      fallback_chain: 'fallback_chain',
      model_unavailable: 'model_unavailable',
      degradation: 'degradation',
    }
    return mapping[category] || 'unknown'
  }

  /**
   * 将 PluginProblem 的 severity 映射为 PiperFailureSeverity。
   */
  private mapSeverity(severity: 'error' | 'warning' | 'info'): PiperFailureSeverity {
    const mapping: Record<string, PiperFailureSeverity> = {
      error: 'error',
      warning: 'warning',
      info: 'info',
    }
    return mapping[severity] || 'warning'
  }

  // ══════════════════════════════════════════
  //  生命周期钩子
  // ══════════════════════════════════════════

  async onLoad(): Promise<void> {
    this._loaded = true
    log('INFO', 'piper_evolution_plugin_loaded', { version: this.manifest.version })
  }

  async onUnload(): Promise<void> {
    this._loaded = false
    evolutionPiperBridge.reset()
    log('INFO', 'piper_evolution_plugin_unloaded')
  }

  // ══════════════════════════════════════════
  //  修复方法
  // ══════════════════════════════════════════

  /**
   * 修复模型失败率过高：切换为默认模型。
   */
  private fixModelFailure(problem: PluginProblem, t0: number): PluginFixResult {
    const model = problem.context.model ?? ''
    const result = piperOrchestrator.switchModel('zh_CN-huayan-medium')

    // 重置桥接器统计（让新数据重新累积）
    ttsPiperBridge.resetStats()

    const summary = result.success
      ? `✅ Piper 模型已从 "${model}" 切换为默认模型（zh_CN-huayan-medium），失败率过高触发自动切换`
      : `⚠️ Piper 模型切换到默认模型失败: ${result.message}`

    return {
      problemId: problem.id,
      success: result.success,
      summary,
      durationMs: Date.now() - t0,
      output: result.message,
    }
  }

  /**
   * 修复高延迟：切换为轻量模型。
   */
  private fixHighLatency(problem: PluginProblem, t0: number): PluginFixResult {
    // huayan-medium 是最轻量的模型
    const result = piperOrchestrator.switchModel('zh_CN-huayan-medium')

    return {
      problemId: problem.id,
      success: result.success,
      summary: result.success
        ? '✅ Piper 已切换为轻量模型（zh_CN-huayan-medium）以降低延迟'
        : `⚠️ 切换轻量模型失败: ${result.message}`,
      durationMs: Date.now() - t0,
      output: result.message,
    }
  }

  /**
   * 修复队列过载：重置队列。
   */
  private fixQueueOverload(problem: PluginProblem, t0: number): PluginFixResult {
    piperOrchestrator.reset()

    return {
      problemId: problem.id,
      success: true,
      summary: '✅ Piper 合成队列已重置（清空待处理请求）',
      durationMs: Date.now() - t0,
      output: 'queue_reset',
    }
  }

  /**
   * 修复回退链异常：切换到默认模型并重置。
   */
  private fixFallbackChain(problem: PluginProblem, t0: number): PluginFixResult {
    const modelResult = piperOrchestrator.switchModel('zh_CN-huayan-medium')
    piperOrchestrator.reset()
    ttsPiperBridge.resetStats()

    return {
      problemId: problem.id,
      success: modelResult.success,
      summary: modelResult.success
        ? '✅ Piper 已切换为默认模型并重置队列（回退链异常触发）'
        : `⚠️ Piper 回退修复失败: ${modelResult.message}`,
      durationMs: Date.now() - t0,
      output: modelResult.message,
    }
  }

  /**
   * 修复整体退化：综合重置。
   */
  private fixDegradation(problem: PluginProblem, t0: number): PluginFixResult {
    const modelResult = piperOrchestrator.switchModel('zh_CN-huayan-medium')
    piperOrchestrator.reset()
    evolutionPiperBridge.reset()

    return {
      problemId: problem.id,
      success: modelResult.success,
      summary: modelResult.success
        ? '✅ Piper 整体性能退化已处理：恢复默认模型、重置队列、清空桥接器统计'
        : `⚠️ Piper 退化修复失败: ${modelResult.message}`,
      durationMs: Date.now() - t0,
      output: modelResult.message,
    }
  }

  // ══════════════════════════════════════════
  //  辅助方法
  // ══════════════════════════════════════════

  private getProblemTitle(category: string): string {
    const titles: Record<string, string> = {
      model_failure_rate: 'Piper 模型失败率过高，建议切换模型',
      high_latency: 'Piper 合成延迟偏高，建议优化',
      queue_overload: 'Piper 合成队列过载，建议检查',
      fallback_chain: 'Piper 模型回退频繁，建议检查模型文件',
      model_unavailable: 'Piper 模型不可用，建议切换',
      degradation: 'Piper 整体性能下降，建议综合检查',
    }
    return titles[category] ?? `Piper 性能问题: ${category}`
  }

  private getProblemSeverity(category: string): 'error' | 'warning' | 'info' {
    switch (category) {
      case 'model_failure_rate':
      case 'degradation':
        return 'error'
      case 'high_latency':
      case 'queue_overload':
        return 'warning'
      case 'fallback_chain':
      case 'model_unavailable':
        return 'warning'
      default:
        return 'info'
    }
  }
}
