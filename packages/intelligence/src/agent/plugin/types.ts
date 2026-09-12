/**
 * Agent Plugin Contracts — Agent 插件契约定义
 *
 * 设计原则（源自 SpeechPluginRegistry 的 ServiceLoader 模式）：
 * 1. 插件 API 稳定性直接影响生态建设，变更前请评估兼容性。
 * 2. 每个插件实现单一契约（具体接口），职责边界清晰。
 * 3. 插件无需关心 AgentPluginRegistry 的内部调度，只需聚焦于接口实现。
 *
 * 模式来源：
 * - src/main/speech/types.ts — SpeechPluginRegistry 的插件契约定义
 * - 迁移到 Agent 领域，适配 Agent 的认知管线（OTPAR）和运行时特性
 */

// ══════════════════════════════════════════
//  插件元数据
// ══════════════════════════════════════════

/** 插件能力类型 — Agent 认知管线各环节 */
export type AgentCapability =
  | 'cognitive_stage' // 认知阶段（Observe/Think/Reflect）
  | 'memory_source' // 记忆源适配
  | 'behavior_analyzer' // 用户行为分析
  | 'tool_provider' // 工具提供者
  | 'guardrail' // 安全护栏扩展

/** 插件元数据 */
export interface AgentPluginManifest {
  /** 唯一标识名，例如 'observe_stage', 'think_stage', 'reflect_stage' */
  name: string
  /** 语义版本 */
  version: string
  /** 人类可读描述 */
  description: string
  /** 插件能力类型 */
  capability: AgentCapability
  /** 作者（可选） */
  author?: string
  /** 优先级（数值越大越优先，默认 0） */
  priority?: number
  /** 插件依赖（可选）
   *  依赖插件的 manifest.name 列表。
   *  注册时若依赖缺失，registry 会打印警告但不阻塞注册。 */
  dependencies?: string[]
}

// ══════════════════════════════════════════
//  基础插件接口
// ══════════════════════════════════════════

/** Agent 插件状态 */
export interface AgentPluginStatus {
  registered: boolean
  initialized: boolean
  error: string | null
}

/**
 * Agent 插件基础接口。
 *
 * 实现此接口的类将成为 AgentPluginRegistry 可发现的 Agent 扩展。
 * 插件只需关注能力实现，不需要了解 AgentPluginRegistry 的调度策略。
 *
 * @example
 * class MyObservePlugin implements AgentPlugin {
 *   readonly manifest: AgentPluginManifest = {
 *     name: 'my_observe',
 *     version: '1.0.0',
 *     description: '自定义 Observe 阶段实现',
 *     capability: 'cognitive_stage',
 *     priority: 50,
 *   }
 *   // ...
 * }
 */
export interface AgentPlugin {
  /** 插件元数据（只读，注册后不应修改） */
  readonly manifest: AgentPluginManifest

  // ── 生命周期钩子（可选） ──

  /**
   * 初始化插件（模型加载、资源分配等）。
   * 在注册后由 AgentPluginRegistry.loadAll() 调用。
   */
  initialize?(config?: unknown): Promise<void>

  /**
   * 插件卸载前的清理。
   */
  onUnload?(): Promise<void>
}

// ══════════════════════════════════════════
//  认知阶段插件接口
// ══════════════════════════════════════════

/**
 * 认知阶段输入 — 所有 OTPAR 阶段共享的上下文。
 *
 * 对照 ASR 的 AsrTranscribeOptions，本接口提供标准化的
 * 阶段执行输入，确保不同阶段实现间输入结构一致。
 */
export interface StageInput {
  /** 当前消息数组（可修改以注入上下文） */
  messages: Array<{ role: string; content: string | null; tool_call_id?: string }>
  /** 当前运行上下文 */
  ctx: { runId: string; step: number }
}

/**
 * 认知阶段输出 — 所有 OTPAR 阶段共享的结果结构。
 */
export interface StageOutput {
  /** 是否注入了额外上下文到 messages */
  injected: boolean
  /** 阶段执行摘要 */
  summary: string
  /** 阶段耗时（毫秒） */
  durationMs?: number
}

/**
 * Observe 阶段插件接口。
 *
 * 在 LLM 返回 toolCalls 后、Guardrail 之前运行。
 * 查询 ProceduralMemory 和 FailureAnalyzer 获取与当前工具相关的上下文。
 */
export interface ObserveStagePlugin extends AgentPlugin {
  /**
   * 执行 Observe 阶段。
   * @param toolCalls 当前轮次 LLM 返回的工具调用
   * @param input 当前轮次的执行上下文
   * @returns 观察结果
   */
  observe(toolCalls: Array<{ name: string; arguments?: string }>, input: StageInput): Promise<StageOutput>
}

/**
 * Think 阶段插件接口。
 *
 * 当 LLM 提出大量工具调用且无文本回复时，
 * 注入策略提示要求 LLM 先说明整体策略再执行。
 */
export interface ThinkStagePlugin extends AgentPlugin {
  /**
   * 执行 Think 阶段。
   * @param toolCalls 当前轮次 LLM 返回的工具调用
   * @param reply LLM 的文本回复（可能为空）
   * @param input 当前轮次的执行上下文
   * @returns 思考结果
   */
  think(toolCalls: Array<{ name: string; arguments?: string }>, reply: string | undefined | null, input: StageInput): Promise<StageOutput>
}

/**
 * Reflect 阶段插件接口。
 *
 * 在工具执行结果推入 messages 后、Guardrail 之前运行。
 * 同步执行反馈。
 */
export interface ReflectStagePlugin extends AgentPlugin {
  readonly manifest: AgentPluginManifest & { capability: 'cognitive_stage' }

  /**
   * 执行 Reflect 阶段。
   * @param toolResults 已执行完的工具结果
   * @param input 当前轮次的执行上下文
   * @returns 反思结果
   */
  reflect(toolResults: Array<{ name: string; success: boolean; error?: string; content?: string }>, input: StageInput): Promise<StageOutput>
}
