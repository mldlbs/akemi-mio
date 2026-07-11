/**
 * pipeline/types.ts — Memory × PiperTTS 处理流水线类型定义
 *
 * 定义流水线 JSON Schema、Stage 接口、缓存契约等核心类型。
 * 每个 Stage 均有明确的输入/输出 Schema，中间结果可缓存可重放。
 */

// ═══════════════════════════════════════════════
//  Pipeline JSON 定义类型
// ═══════════════════════════════════════════════

/** JSON Schema 片段（足以描述输入/输出结构） */
export interface SchemaFragment {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  description?: string
  properties?: Record<string, SchemaFragment>
  items?: SchemaFragment
  default?: unknown
  required?: string[]
}

/** 流水线中单个 Stage 的 JSON 定义 */
export interface StageDefinition {
  /** 唯一标识，用于依赖引用 */
  id: string
  /** Stage 类型名，对应注册的 StageExecutor */
  stageType: string
  /** 人类可读描述 */
  description: string
  /** 依赖的上游 stage id 列表（其输出会作为本 stage 输入） */
  dependsOn: string[]
  /** Stage 专属配置（由对应 StageExecutor 自行解析） */
  config: Record<string, unknown>
  /** 输入 Schema（文档/校验用） */
  inputSchema: SchemaFragment
  /** 输出 Schema（文档/校验用） */
  outputSchema: SchemaFragment
}

/** 完整的流水线 JSON 定义 */
export interface PipelineDefinition {
  /** 流水线唯一 ID */
  pipelineId: string
  /** 描述 */
  description: string
  /** 语义化版本 */
  version: string
  /** Stage 列表 */
  stages: StageDefinition[]
}

// ═══════════════════════════════════════════════
//  Stage 执行器接口
// ═══════════════════════════════════════════════

/** 单个 Stage 执行后的输出 */
export interface StageOutput {
  /** Stage ID */
  stageId: string
  /** 执行结果数据 */
  data: Record<string, unknown>
  /** 执行耗时（毫秒） */
  durationMs: number
  /** 是否来自缓存 */
  fromCache: boolean
  /** 执行时间戳 */
  timestamp: number
}

/** Stage 执行上下文（由引擎传入） */
export interface StageExecutionContext {
  /** 各上游 stage 的输出（keyed by stage id） */
  inputs: ReadonlyMap<string, StageOutput>
  /** 流水线起始输入 */
  pipelineInput: Readonly<Record<string, unknown>>
  /** 日志/追踪标识 */
  traceId: string
}

/**
 * Stage 执行器接口。
 * 每个具体 Stage 实现此接口，通过 stageType 与 JSON 定义对应。
 */
export interface StageExecutor {
  /** 对应的 stageType */
  readonly stageType: string

  /**
   * 执行本 Stage。
   * @param config 来自 JSON 定义的 config
   * @param ctx    执行上下文（含上游输出、流水线输入等）
   * @returns      Stage 输出
   */
  execute(
    config: Record<string, unknown>,
    ctx: StageExecutionContext,
  ): Promise<StageOutput>
}

// ═══════════════════════════════════════════════
//  缓存类型
// ═══════════════════════════════════════════════

/** 缓存条目 */
export interface CacheEntry {
  /** Stage ID */
  stageId: string
  /** 输入哈希（用于判断缓存是否有效） */
  inputHash: string
  /** 输出数据 */
  output: StageOutput
  /** 缓存创建时间 */
  createdAt: number
  /** 缓存过期时间（0=永不过期） */
  ttlMs: number
}

/** 缓存管理器接口 */
export interface ICacheManager {
  get(stageId: string, inputHash: string): StageOutput | null
  set(stageId: string, inputHash: string, output: StageOutput, ttlMs?: number): void
  invalidate(stageId?: string): void
  getStats(): CacheStats
}

export interface CacheStats {
  entries: number
  hits: number
  misses: number
}

// ═══════════════════════════════════════════════
//  流水线执行结果
// ═══════════════════════════════════════════════

/** 完整的流水线执行结果 */
export interface PipelineResult {
  /** 流水线 ID */
  pipelineId: string
  /** 是否全部成功 */
  success: boolean
  /** 所有 Stage 的输出（可重放） */
  stageOutputs: Map<string, StageOutput>
  /** 最终 Stage 的输出（快捷访问） */
  finalOutput: StageOutput | null
  /** 总耗时（毫秒） */
  totalDurationMs: number
  /** 执行时间戳 */
  timestamp: number
  /** 错误信息（若有） */
  error?: string
  /** 各 stage 详细错误（stageId → error） */
  stageErrors?: Record<string, string>
}

// ═══════════════════════════════════════════════
//  Stage 常用 Schema 快捷定义
// ═══════════════════════════════════════════════

export const SCHEMA = {
  string: (desc: string, def?: string): SchemaFragment => ({
    type: 'string', description: desc, ...(def !== undefined ? { default: def } : {}),
  }),
  number: (desc: string, def?: number): SchemaFragment => ({
    type: 'number', description: desc, ...(def !== undefined ? { default: def } : {}),
  }),
  boolean: (desc: string, def?: boolean): SchemaFragment => ({
    type: 'boolean', description: desc, ...(def !== undefined ? { default: def } : {}),
  }),
  object: (props: Record<string, SchemaFragment>, desc?: string): SchemaFragment => ({
    type: 'object', description: desc, properties: props,
  }),
}
