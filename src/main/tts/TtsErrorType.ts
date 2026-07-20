/**
 * TtsErrorType — TTS 合成错误分类
 *
 * MCP 模式迁移：从 ToolErrorType（src/main/tool/ToolErrorType.ts）迁移
 *
 * ToolErrorType 解决的问题：
 *   MCP 工具调用返回的原始错误消息格式不统一，下游（ToolScheduler、
 *   ToolAvailabilityCache、LLM 调度层）需要一致的是否可重试/是否需要回退的判断。
 *   通过正则模式匹配分类，提供单一事实来源。
 *
 * TTS 中的相同问题：
 *   TTS 合成引擎（Piper、edge-tts）返回的错误消息格式各异，
 *   TtsService._synthesize 目前使用 ad-hoc 的 attempt 重试计数，
 *   缺少统一的错误类型判断来驱动回退决策。
 *   — Piper 错误："Python 进程异常退出" vs "模型文件不存在"
 *   — edge-tts 错误："网络超时" vs "参数无效"
 *   需要一致的分类来回答"这个错误该重试还是该换引擎"。
 *
 * 适配差异：
 *   ToolErrorType 分类更细（TOOL_MISSING / MCP_ERROR / PERMISSION / ARGUMENT），
 *   因为 MCP 工具调用涉及权限检查、工具发现等 TTS 不存在的维度。
 *   TtsErrorType 聚焦于 TTS 合成领域的失败模式：
 *   - ENGINE_UNAVAILABLE：引擎不可用（CLI 未安装、进程崩溃）
 *   - TIMEOUT：合成超时（网络延迟、模型加载慢）
 *   - NETWORK：网络问题（仅 edge-tts）
 *   - SYNTHESIS_FAILURE：引擎执行错误但可重试
 *   - INVALID_INPUT：输入参数无效（文本太短、参数越界）
 *   - UNKNOWN：兜底
 */

// ════════════════════════════════════════════════════════════════
//  错误类型枚举
// ════════════════════════════════════════════════════════════════

/**
 * TTS 合成错误类型。
 *
 * 与 ToolErrorType（src/main/tool/ToolErrorType.ts）的处理原则一致：
 * - 可恢复错误（RECOVERABLE）：ENGINE_UNAVAILABLE, TIMEOUT, NETWORK
 *   → 可触发引擎间回退（Piper ↔ edge-tts）
 * - 不可恢复错误（UNRECOVERABLE）：INVALID_INPUT, SYNTHESIS_FAILURE（部分）
 *   → 应向上层报告，不再重试
 * - 未知错误（UNKNOWN）：按可恢复处理，尝试重试
 */
export enum TtsErrorType {
  /** 引擎不可用：CLI 未安装、Python 进程无法启动、引擎崩溃 */
  ENGINE_UNAVAILABLE = 'ENGINE_UNAVAILABLE',
  /** 合成超时：响应超过超时上限 */
  TIMEOUT = 'TIMEOUT',
  /** 网络问题：仅在云端引擎（edge-tts）中出现 */
  NETWORK = 'NETWORK',
  /** 合成执行错误：进程异常退出、输出文件未生成（可重试） */
  SYNTHESIS_FAILURE = 'SYNTHESIS_FAILURE',
  /** 输入参数无效：文本太短、参数超出范围 */
  INVALID_INPUT = 'INVALID_INPUT',
  /** 兜底：无法分类的错误 */
  UNKNOWN = 'UNKNOWN',
}

// ════════════════════════════════════════════════════════════════
//  可恢复性判断
// ════════════════════════════════════════════════════════════════

/** 可恢复的错误类型集合（可触发引擎间回退） */
const RECOVERABLE_TYPES = new Set([
  TtsErrorType.ENGINE_UNAVAILABLE,
  TtsErrorType.TIMEOUT,
  TtsErrorType.NETWORK,
  TtsErrorType.SYNTHESIS_FAILURE,
  TtsErrorType.UNKNOWN,
])

/**
 * 判断 TTS 错误是否可恢复（可触发回退）。
 *
 * 与 ToolErrorAggregator.isRecoverable() 的处理逻辑一致：
 * - ENGINE_UNAVAILABLE：可恢复，尝试另一引擎
 * - TIMEOUT：可恢复，可能是临时负载高，重试或换引擎
 * - NETWORK：可恢复，换本地引擎
 * - SYNTHESIS_FAILURE：可恢复，可能是临时状态导致
 * - INVALID_INPUT：不可恢复，参数问题重试同样失败
 * - UNKNOWN：按可恢复处理，尝试换引擎
 */
export function isTtsErrorRecoverable(errorType: TtsErrorType): boolean {
  return RECOVERABLE_TYPES.has(errorType)
}

/**
 * 获取某个引擎的错误是否应切换到另一引擎。
 * 决定是"同级重试"还是"跨引擎回退"。
 *
 * 原则：
 * - ENGINE_UNAVAILABLE / NETWORK：跨引擎回退（引擎本身有问题）
 * - TIMEOUT / SYNTHESIS_FAILURE：先同级重试，再跨引擎回退
 * - INVALID_INPUT：不重试，不回退
 */
export function shouldFallbackToOtherEngine(errorType: TtsErrorType): boolean {
  switch (errorType) {
    case TtsErrorType.ENGINE_UNAVAILABLE:
    case TtsErrorType.NETWORK:
      return true // 引擎本身问题，直接跨引擎
    case TtsErrorType.TIMEOUT:
    case TtsErrorType.SYNTHESIS_FAILURE:
    case TtsErrorType.UNKNOWN:
      return false // 先重试，再考虑回退
    case TtsErrorType.INVALID_INPUT:
      return false // 不重试
  }
}

// ════════════════════════════════════════════════════════════════
//  错误消息模式匹配
// ════════════════════════════════════════════════════════════════

interface MatchRule {
  type: TtsErrorType
  patterns: RegExp[]
}

/**
 * 匹配规则表（优先级从高到低）。
 *
 * 与 ToolErrorType 的 MATCH_RULES 模式一致：
 * - 使用正则匹配错误消息
 * - 首个匹配胜出
 * - 无匹配回退到 UNKNOWN
 *
 * 适配差异：
 * ToolErrorType 覆盖文件系统、SSH、权限等工具特定错误，
 * TtsErrorType 聚焦 Piper、edge-tts、Python 引擎的领域错误。
 */
const MATCH_RULES: MatchRule[] = [
  // ── ENGINE_UNAVAILABLE ──
  {
    type: TtsErrorType.ENGINE_UNAVAILABLE,
    patterns: [
      /command not found/i,
      /is not recognized as an internal/i,
      /is not recognized as an operable/i,
      /No such file or directory/i,
      /Python.*not found/i,
      /pip.*not found/i,
      /edge-tts.*not found/i,
      /no.*such.*file/i,
      /ENOENT/i,
      /无法启动.*进程/,
      /找不到命令/,
    ],
  },
  // ── TIMEOUT ──
  {
    type: TtsErrorType.TIMEOUT,
    patterns: [
      /timed out/i,
      /timeout/i,
      /ETIMEDOUT/i,
      /合成超时/,
      /exceeded timeout/i,
    ],
  },
  // ── NETWORK ──
  {
    type: TtsErrorType.NETWORK,
    patterns: [
      /ECONNREFUSED/i,
      /ENETUNREACH/i,
      /ECONNRESET/i,
      /socket hang up/i,
      /network.*unreach/i,
      /network.*unavail/i,
      /connection refused/i,
      /getaddrinfo/i,
      /网络不可用/,
      /网络连接失败/,
      /请求超时/,
    ],
  },
  // ── INVALID_INPUT ──
  {
    type: TtsErrorType.INVALID_INPUT,
    patterns: [
      /文本太短/,
      /text.*too short/i,
      /输入.*无效/,
      /参数.*超出范围/,
      /语速.*超出范围/,
      /speed.*range/i,
      /voice.*invalid/i,
      /无效.*语音/,
      /invalid.*voice/i,
      /清理后为空/,
      /参数错误/,
    ],
  },
  // ── SYNTHESIS_FAILURE ──
  {
    type: TtsErrorType.SYNTHESIS_FAILURE,
    patterns: [
      /exit code/i,
      /exit.*non.?zero/i,
      /process.*exit/i,
      /合成失败/,
      /synthesis.*fail/i,
      /未生成音频文件/,
      /no audio file/i,
      /audio.*not.*generat/i,
      /返回空/,
      /返回.*错误/,
      /.*bridge.*error/,
      /.*bridge.*exit/,
      /stderr/i,
    ],
  },
]

/**
 * 分类 TTS 合成错误消息。
 *
 * 用法：
 *   const errorType = classifyTtsError('edge-tts exit with code 1')
 *   // → TtsErrorType.SYNTHESIS_FAILURE
 *
 * 与 ToolErrorType.classifyToolError() 的模式一致：
 * 返回枚举值，下游据此决定是否重试、是否回退到另一引擎。
 */
export function classifyTtsError(message: string): TtsErrorType {
  if (!message) return TtsErrorType.UNKNOWN

  for (const rule of MATCH_RULES) {
    for (const p of rule.patterns) {
      if (p.test(message)) return rule.type
    }
  }

  return TtsErrorType.UNKNOWN
}
