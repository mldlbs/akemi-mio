/**
 * Multi-Path Decoder Types — ASR 多路径解码异常融合类型定义
 *
 * 设计原则：
 * 1. 每个解码器实例独立运行（共享主进程上下文），通过统一的 DecoderInstance 接口抽象
 * 2. 心跳监控通过定时健康检查实现，异常通过错误队列传递
 * 3. 融合层基于历史准确率动态加权
 * 4. 所有类型保持与现有 AsrService/WhisperEngine/BaiduEngine 兼容
 */

// ══════════════════════════════════════════
//  解码器实例类型
// ══════════════════════════════════════════

/** 解码器后端类型 — 扩展自现有引擎类型 */
export type DecoderBackend = 'whisper_gpu' | 'whisper_cpu' | 'baidu' | string

/** 解码器配置 */
export interface DecoderConfig {
  /** 解码器唯一标识名 */
  name: string
  /** 后端引擎类型 */
  backend: DecoderBackend
  /** 模型规模（仅 whisper 引擎适用） */
  modelSize?: 'tiny' | 'small' | 'medium' | 'large-v3'
  /** 单次转录超时（毫秒） */
  timeoutMs: number
  /** 初始融合权重（0.1–2.0），启动时用于加权投票 */
  initialWeight: number
  /** 初始置信度偏移（±0.2），用于校准各引擎的置信度偏差 */
  confidenceBias: number
}

/** 默认解码器配置 */
export const DEFAULT_DECODER_CONFIG: DecoderConfig = {
  name: 'default',
  backend: 'whisper_gpu',
  modelSize: 'small',
  timeoutMs: 20000,
  initialWeight: 1.0,
  confidenceBias: 0,
}

// ══════════════════════════════════════════
//  解码器健康状态
// ══════════════════════════════════════════

/** 解码器健康状态枚举 */
export type DecoderHealthState =
  | 'healthy' // 正常运行
  | 'degraded' // 降级（偶发失败，仍在活跃列表）
  | 'crashed' // 崩溃（发生致命错误，已从活跃列表移除）
  | 'dead' // 已死亡（多次崩溃，不再尝试恢复）

/** 解码器健康快照 */
export interface DecoderHealth {
  name: string
  state: DecoderHealthState
  /** 连续失败次数 */
  consecutiveFailures: number
  /** 最后一次心跳时间戳 */
  lastHeartbeat: number
  /** 最后一次错误信息 */
  lastError: string | null
  /** 总调用次数 */
  totalCalls: number
  /** 成功调用次数 */
  successfulCalls: number
  /** 平均延迟（毫秒） */
  averageLatency: number
  /** 滑动窗口内最近 N 次的历史准确率（0–1） */
  historicalAccuracy: number
  /** 是否在活跃列表中 */
  active: boolean
}

// ══════════════════════════════════════════
//  解码器执行结果
// ══════════════════════════════════════════

/** 单个解码器的转录结果 */
export interface DecoderResult {
  /** 解码器名称 */
  name: string
  /** 识别文本 */
  text: string
  /** 置信度 (0–1) */
  confidence: number
  /** 推理延迟（毫秒） */
  latencyMs: number
  /** 是否成功 */
  success: boolean
  /** 错误信息（仅 success=false 时） */
  error?: string
  /** 时间戳 */
  timestamp: number
}

// ══════════════════════════════════════════
//  融合结果
// ══════════════════════════════════════════

/** 融合方法枚举 */
export type FusionMethod = 'weighted_vote' | 'best_confidence' | 'single'

/** 多路径融合输出 */
export interface MultiPathFusionResult {
  /** 融合后的最终文本 */
  text: string
  /** 融合后的最终置信度 (0–1) */
  confidence: number
  /** 主引擎标识（输出文本来源引擎） */
  primaryEngine: string
  /** 所有解码器的结果明细 */
  decoderResults: DecoderResult[]
  /** 使用的融合方法 */
  fusionMethod: FusionMethod
  /** 活跃解码器数量 */
  activeDecoderCount: number
  /** 总解码器数量 */
  totalDecoderCount: number
  /** 是否触发异常降级（有解码器崩溃） */
  degraded: boolean
  /** 融合处理耗时 */
  fusionLatencyMs: number
}

// ══════════════════════════════════════════
//  心跳与异常事件
// ══════════════════════════════════════════

/** 心跳事件 */
export interface HeartbeatEvent {
  decoderName: string
  timestamp: number
  state: DecoderHealthState
  consecutiveFailures: number
  error?: string
}

/** 异常消息（通过队列传递至融合节点） */
export interface DecoderErrorMessage {
  type: 'crash' | 'timeout' | 'oom' | 'model_corruption' | 'unknown'
  decoderName: string
  timestamp: number
  message: string
  stack?: string
}

/** 异常消息回调类型 */
export type ErrorMessageCallback = (msg: DecoderErrorMessage) => void

// ══════════════════════════════════════════
//  融合配置
// ══════════════════════════════════════════

/** 多路径融合配置 */
export interface MultiPathFusionConfig {
  /** 是否启用多路径融合 */
  enabled: boolean
  /** 置信度阈值 — 低于此值的解码器结果被排除 */
  confidenceThreshold: number
  /** 历史准确率衰减因子 (0–1)，越高则历史权重衰减越慢 */
  historyDecayFactor: number
  /** 融合所需的最少活跃解码器数 */
  minActiveDecoders: number
  /** 心跳检查间隔（毫秒） */
  heartbeatIntervalMs: number
  /** 心跳超时（毫秒） — 超过此时间无响应视为死亡 */
  heartbeatTimeoutMs: number
  /** 连续失败次数上限 — 超过此值移出活跃列表 */
  maxConsecutiveFailures: number
  /** 是否启用故障解码器自动恢复 */
  autoRecovery: boolean
  /** 故障解码器恢复冷却时间（毫秒） */
  recoveryCooldownMs: number
}

/** 默认融合配置 */
export const DEFAULT_FUSION_CONFIG: MultiPathFusionConfig = {
  enabled: false,
  confidenceThreshold: 0.3,
  historyDecayFactor: 0.7,
  minActiveDecoders: 1,
  heartbeatIntervalMs: 5000,
  heartbeatTimeoutMs: 15000,
  maxConsecutiveFailures: 3,
  autoRecovery: true,
  recoveryCooldownMs: 60000,
}

// ══════════════════════════════════════════
//  解码器实例接口（统一抽象）
// ══════════════════════════════════════════

/**
 * 统一解码器实例接口。
 * 将 WhisperGPU、WhisperCPU、Baidu 等引擎包装为统一契约，
 * 供 MultiPathDecoderManager 透明管理。
 */
export interface IDecoderInstance {
  /** 解码器名称 */
  readonly name: string
  /** 后端类型 */
  readonly backend: DecoderBackend
  /** 当前配置 */
  readonly config: DecoderConfig

  /**
   * 对音频执行转录。
   * 返回 DecoderResult，其中 success=false 表示失败。
   * 实现方应捕获内部异常并转为 DecoderResult。
   */
  transcribe(audio: Float32Array, options?: { timeoutMs?: number; requestId?: string }): Promise<DecoderResult>

  /**
   * 获取当前健康快照。
   */
  getHealth(): DecoderHealth

  /**
   * 重置健康计数器（恢复为 healthy）。
   */
  resetHealth(): void

  /**
   * 检查解码器是否响应（心跳探测）。
   * 返回 true 表示正常，false 表示无响应。
   */
  ping(): Promise<boolean>

  /**
   * 销毁解码器占用的资源。
   * 调用后不应再使用此实例。
   */
  destroy(): Promise<void>

  /**
   * 获取后端引擎的信息字符串（供调试/UI 展示）。
   */
  getModelInfo(): string
}
