/**
 * Evolution Plugin 契约定义
 *
 * 插件 API 的稳定性直接影响生态建设，变更前请评估兼容性。
 *
 * 每个 EvolutionPlugin 在 onLoad 时注册到 PluginServiceLoader，
 * Evolution 系统通过 ServiceLoader 发现并消费插件的能力。
 */

// ── 插件能力类型 ──
export type EvolutionCapability = 'collect' | 'optimize'

// ── 插件元数据 ──
export interface EvolutionPluginManifest {
  /** 唯一标识名，例如 'wallpaper' */
  name: string
  /** 语义版本 */
  version: string
  /** 可读描述 */
  description: string
  /** 该插件提供的能力集合 */
  capabilities: EvolutionCapability[]
  /** 作者（可选） */
  author?: string
}

// ── 插件上报的问题 ──
export interface PluginProblem {
  id: string
  title: string
  description: string
  severity: 'error' | 'warning' | 'info'
  file?: string
  line?: number
  estimatedCostChars: number
  context: Record<string, string>
}

// ── 插件修复结果 ──
export interface PluginFixResult {
  problemId: string
  success: boolean
  summary: string
  durationMs: number
  output?: string
  error?: string
}

// ── Evolution 插件主接口 ──
//
// 实现此接口 = 成为 Evolution 可识别的插件。
// 插件只需关注自己的领域逻辑（检测 + 修复），
// 不需要了解 PipelineOrchestrator 的内部调度。
export interface EvolutionPlugin {
  /** 插件元数据 */
  readonly manifest: EvolutionPluginManifest

  /**
   * 采集插件领域的问题。
   * 返回空数组 = 当前无问题。
   */
  collect(): Promise<PluginProblem[]>

  /**
   * 修复一个由 collect() 上报的问题。
   * 框架保证 fix() 收到的 problem 之前曾被 collect() 返回过。
   */
  fix(problem: PluginProblem): Promise<PluginFixResult>

  /**
   * 插件当前是否可用。
   * 返回 false 时框架跳过该插件的 collect/fix 调用。
   */
  isAvailable(): boolean

  // ── 生命周期钩子（可选） ──

  /** 插件被加载后的初始化（例如创建资源、订阅事件） */
  onLoad?(): Promise<void>

  /** 插件被卸载前的清理（例如释放资源、取消订阅） */
  onUnload?(): Promise<void>
}

// ── 插件适配器：将 EvolutionPlugin 适配为 SignalCollector / FixExecutor ──

import type { SignalCollector, FixExecutor, AssignedProblem, FixResult, ProblemSource, Problem } from '@akemi-mio/evolution/automation/types'

/** 将 EvolutionPlugin 适配为 SignalCollector */
export class PluginCollectorAdapter implements SignalCollector {
  readonly name: string
  readonly source: ProblemSource = 'runtime'

  constructor(private plugin: EvolutionPlugin) {
    this.name = `${plugin.manifest.name}-collector`
  }

  shouldRun(): boolean {
    return this.plugin.isAvailable()
  }

  async collect(): Promise<Problem[]> {
    const pluginProblems = await this.plugin.collect()
    return pluginProblems.map((p) => ({
      id: p.id,
      source: 'runtime' as ProblemSource,
      severity: p.severity,
      title: p.title,
      description: p.description,
      file: p.file,
      line: p.line,
      estimatedCostChars: p.estimatedCostChars,
      lastSeen: Date.now(),
      occurrenceCount: 1,
      context: {
        raw: p.context.raw ?? '',
        snippet: p.context.snippet,
        metadata: p.context,
      },
    }))
  }
}

/** 将 EvolutionPlugin 适配为 FixExecutor */
export class PluginExecutorAdapter implements FixExecutor {
  readonly name: string
  readonly source: ProblemSource = 'runtime'
  readonly supportedSources: ProblemSource[] = ['runtime']
  readonly timeoutMs = 30_000

  constructor(private plugin: EvolutionPlugin) {
    this.name = `${plugin.manifest.name}-optimization`
  }

  isAvailable(): boolean {
    return this.plugin.isAvailable()
  }

  async execute(problem: AssignedProblem): Promise<FixResult> {
    const pluginProblem = {
      id: problem.id,
      title: problem.title,
      description: problem.description,
      severity: problem.severity,
      file: problem.file,
      line: problem.line,
      estimatedCostChars: problem.estimatedCostChars,
      context: {
        raw: problem.context.raw,
        ...(problem.context.snippet ? { snippet: problem.context.snippet } : {}),
        ...(problem.context.metadata ?? {}),
      },
    }
    const result = await this.plugin.fix(pluginProblem)
    return {
      problemId: result.problemId,
      success: result.success,
      summary: result.summary,
      durationMs: result.durationMs,
      output: result.output,
      error: result.error,
    }
  }
}
