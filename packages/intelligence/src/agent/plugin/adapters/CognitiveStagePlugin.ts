/**
 * CognitiveStagePlugin — 认知阶段插件适配器
 *
 * 将现有的 runObserve / runThink / runReflect 函数封装为
 * AgentPlugin 接口，使其可通过 AgentPluginRegistry 发现和加载。
 *
 * 设计原则（与 SpeechPluginRegistry 适配器的设计原则一致）：
 * - 零侵入：不修改现有 runObserve / runThink / runReflect 的接口
 * - 全委托：所有方法直接转发到现有函数
 * - 渐进式：现有函数可独立工作，不阻塞插件注册
 *
 * 对照 ASR 适配器（WhisperGpuAsrPlugin / BaiduAsrPlugin）：
 *   ASR 适配器将 WhisperGpuEngine / BaiduEngine 封装为 AsrPlugin；
 *   本适配器将 runObserve / runThink / runReflect 封装为 AgentPlugin。
 *
 * 使用方式：
 *   const plugin = new ObserveStagePluginAdapter()
 *   agentPluginRegistry.register(plugin)
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { AgentPluginManifest, StageInput, StageOutput, ObserveStagePlugin, ThinkStagePlugin, ReflectStagePlugin } from '../types'
import { runObserve } from '../../ObserveStage'
import { runThink } from '../../ThinkStage'
import { runReflect } from '../../ReflectStage'
import type { ProceduralMemory } from '../../ProceduralMemory'
import type { FailureAnalyzer } from '../../FailureAnalyzer'
import type { RunContext } from '../../runstate'

// ══════════════════════════════════════════
//  Observe 阶段插件适配器
// ══════════════════════════════════════════

export class ObserveStagePluginAdapter implements ObserveStagePlugin {
  readonly manifest: AgentPluginManifest = {
    name: 'observe_stage',
    version: '1.0.0',
    description: 'OTPAR Observe 阶段：查询 ProceduralMemory 和 FailureAnalyzer ' + '获取与当前工具相关的上下文，注入提示防止重复失败',
    capability: 'cognitive_stage',
    priority: 50,
    author: 'akemi-mio',
  }

  /** ProceduralMemory 引用（延迟注入，插件化后由 registry 管理） */
  private proceduralMemory: ProceduralMemory | null = null
  /** FailureAnalyzer 引用 */
  private failureAnalyzer: FailureAnalyzer | null = null

  /**
   * 设置 Observe 阶段的依赖注入。
   * 在 AgentService 中注册插件后调用。
   */
  setDeps(deps: { proceduralMemory: ProceduralMemory | null; failureAnalyzer: FailureAnalyzer | null }): void {
    this.proceduralMemory = deps.proceduralMemory
    this.failureAnalyzer = deps.failureAnalyzer
  }

  async observe(toolCalls: Array<{ name: string; arguments?: string }>, input: StageInput): Promise<StageOutput> {
    const t0 = Date.now()

    // 委托到现有的 runObserve 函数
    const ctx = {
      runId: input.ctx.runId,
      step: input.ctx.step,
    } as RunContext

    const result = runObserve(toolCalls as any, input.messages as any, ctx, {
      proceduralMemory: this.proceduralMemory,
      failureAnalyzer: this.failureAnalyzer,
    })

    return {
      injected: result.injected,
      summary: result.injected ? `发现 ${result.proceduresFound} 个相关流程和 ${result.patternsFound} 个失败模式` : '无相关上下文',
      durationMs: Date.now() - t0,
    }
  }

  // ── 生命周期钩子 ──

  async initialize(config?: { proceduralMemory?: ProceduralMemory; failureAnalyzer?: FailureAnalyzer }): Promise<void> {
    if (config?.proceduralMemory) {
      this.proceduralMemory = config.proceduralMemory
    }
    if (config?.failureAnalyzer) {
      this.failureAnalyzer = config.failureAnalyzer
    }
    log('INFO', 'agent_plugin_observe_initialized', {
      hasProceduralMemory: !!this.proceduralMemory,
      hasFailureAnalyzer: !!this.failureAnalyzer,
    })
  }

  async onUnload(): Promise<void> {
    this.proceduralMemory = null
    this.failureAnalyzer = null
  }
}

// ══════════════════════════════════════════
//  Think 阶段插件适配器
// ══════════════════════════════════════════

export class ThinkStagePluginAdapter implements ThinkStagePlugin {
  readonly manifest: AgentPluginManifest = {
    name: 'think_stage',
    version: '1.0.0',
    description: 'OTPAR Think 阶段：当 LLM 提出大量工具调用且无文本回复时，' + '注入策略提示要求 LLM 先说明整体策略再执行',
    capability: 'cognitive_stage',
    priority: 40,
    author: 'akemi-mio',
  }

  async think(
    toolCalls: Array<{ name: string; arguments?: string }>,
    reply: string | undefined | null,
    input: StageInput,
  ): Promise<StageOutput> {
    const t0 = Date.now()
    const messages = input.messages as any
    const ctx = {
      runId: input.ctx.runId,
      step: input.ctx.step,
    } as any

    const result = runThink(toolCalls as any, reply, messages, ctx)

    return {
      injected: result.injected,
      summary: result.injected ? '已注入策略提示' : '无需策略提示',
      durationMs: Date.now() - t0,
    }
  }

  async onUnload(): Promise<void> {
    // Think 阶段无状态，无需清理
  }
}

// ══════════════════════════════════════════
//  Reflect 阶段插件适配器
// ══════════════════════════════════════════

export class ReflectStagePluginAdapter implements ReflectStagePlugin {
  readonly manifest: AgentPluginManifest & { capability: 'cognitive_stage' } = {
    name: 'reflect_stage',
    version: '1.0.0',
    description: 'OTPAR Reflect 阶段：在工具执行结果推入 messages 后注入执行反馈，' + '包括成功/失败统计和超时告警',
    capability: 'cognitive_stage',
    priority: 30,
    author: 'akemi-mio',
  }

  async reflect(
    toolResults: Array<{ name: string; success: boolean; error?: string; content?: string }>,
    input: StageInput,
  ): Promise<StageOutput> {
    const t0 = Date.now()
    const messages = input.messages as any
    const ctx = {
      runId: input.ctx.runId,
      step: input.ctx.step,
    } as any

    const result = runReflect(
      toolResults as any,
      toolResults.map((r) => ({ id: `reflect_${r.name}`, name: r.name, arguments: {} })),
      messages,
      ctx,
    )

    return {
      injected: result.injected,
      summary: result.summary || '无反馈注入',
      durationMs: Date.now() - t0,
    }
  }

  async onUnload(): Promise<void> {
    // Reflect 阶段无状态，无需清理
  }
}
