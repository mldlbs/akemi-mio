import { log } from '../logger/Logger'

// =============================================================================
// 错误分类器 — 将 LLM/工具调用错误分类为不同类别，分配恢复策略
// =============================================================================

export type ErrorCategory =
  | 'RETRYABLE' // 429/500/502/503/timeout/网络 — transient
  | 'CONTEXT_OVERFLOW' // prompt 超长 / context_length_exceeded — state corruption in context size
  | 'INVALID_REQUEST' // 400 / 参数格式错误 / 消息校验失败 — state corruption
  | 'TOOL_SCHEMA_ERROR' // 工具调用参数不匹配 schema — transient
  | 'FATAL' // OOM / crash / 不可恢复
  // Phase 5C: 新增精细化分类
  | 'CAPABILITY_LOSS' // MCP 工具集漂移 / 能力降级
  | 'CONFIGURATION_ERROR' // 缺少 API Key / 配置错误
  | 'CORRUPTED_STATE' // orphan tool_call / 消息链损坏

export interface RecoveryStrategy {
  category: ErrorCategory
  shouldRetry: boolean
  maxRetries: number
  backoffBaseMs: number
  contextAction: 'preserve' | 'compress' | 'clear' | 'reject'
  message: string
}

export interface ClassificationResult {
  category: ErrorCategory
  strategy: RecoveryStrategy
  retryDelayMs: number
  originalError: string
}

// =============================================================================
// 策略表
// =============================================================================

const STRATEGIES: Record<ErrorCategory, RecoveryStrategy> = {
  RETRYABLE: {
    category: 'RETRYABLE',
    shouldRetry: true,
    maxRetries: 3,
    backoffBaseMs: 2000,
    contextAction: 'preserve',
    message: '暂时遇到服务波动，正在自动重试...',
  },
  CONTEXT_OVERFLOW: {
    category: 'CONTEXT_OVERFLOW',
    shouldRetry: true,
    maxRetries: 1,
    backoffBaseMs: 0,
    contextAction: 'compress',
    message: '上下文过长，正在压缩后重试。',
  },
  INVALID_REQUEST: {
    category: 'INVALID_REQUEST',
    shouldRetry: true,
    maxRetries: 0,
    backoffBaseMs: 0,
    contextAction: 'preserve',
    message: '请求参数异常，正在清理后重试。',
  },
  TOOL_SCHEMA_ERROR: {
    category: 'TOOL_SCHEMA_ERROR',
    shouldRetry: true,
    maxRetries: 1,
    backoffBaseMs: 0,
    contextAction: 'preserve',
    message: '工具调用参数格式有误，正在移除错误调用后重试。',
  },
  FATAL: {
    category: 'FATAL',
    shouldRetry: false,
    maxRetries: 0,
    backoffBaseMs: 0,
    contextAction: 'reject',
    message: '系统遇到了无法恢复的错误，已保存当前进度。',
  },
  CAPABILITY_LOSS: {
    category: 'CAPABILITY_LOSS',
    shouldRetry: false,
    maxRetries: 0,
    backoffBaseMs: 0,
    contextAction: 'reject',
    message: '工具不可用，已跳过当前操作。',
  },
  CONFIGURATION_ERROR: {
    category: 'CONFIGURATION_ERROR',
    shouldRetry: false,
    maxRetries: 0,
    backoffBaseMs: 0,
    contextAction: 'reject',
    message: '配置缺失：所需凭据或设置未配置。',
  },
  CORRUPTED_STATE: {
    category: 'CORRUPTED_STATE',
    shouldRetry: false,
    maxRetries: 0,
    backoffBaseMs: 0,
    contextAction: 'clear',
    message: '会话状态异常，正在回滚到最近的健康检查点。',
  },
}

// =============================================================================
// 模式匹配规则
// =============================================================================

interface MatchRule {
  category: ErrorCategory
  patterns: RegExp[]
  exclude?: RegExp[]
}

const MATCH_RULES: MatchRule[] = [
  {
    category: 'RETRYABLE',
    patterns: [
      /429/,
      /5\d{2}/,
      /timeout/i,
      /etimedout/i,
      /econnreset/i,
      /econnrefused/i,
      /socket hang.?up/i,
      /rate limit/i,
      /too many requests/i,
      /service unavailable/i,
      /internal server error/i,
      /bad gateway/i,
      /fetch failed/i,
      /network error/i,
      /temporarily unavailable/i,
      /upstream connect error/i,
      /upstream request timeout/i,
      /please try again/i,
    ],
  },
  {
    category: 'CORRUPTED_STATE',
    patterns: [
      /insufficient tool messages/i,
      /orphan.*tool_call/i,
      /tool_calls.*must be followed/i,
      /message.*struct/i,
      /invalid.*message.*pattern/i,
      /assistant.*tool_call.*no.*tool/i,
    ],
  },
  {
    category: 'CAPABILITY_LOSS',
    patterns: [
      /tool.*not found/i,
      /unknown tool/i,
      /no tool named/i,
      /server.*not.*initialized/i,
      /MCP.*unavailable/i,
      /mcp.*not.*connected/i,
      /tool.*unavailable/i,
      /server.*dead/i,
      /capability.*drift/i,
    ],
  },
  {
    category: 'CONFIGURATION_ERROR',
    patterns: [
      /no.*api.?key/i,
      /api_key.*not.*found/i,
      /missing.*credential/i,
      /invalid.*api.?key/i,
      /401/i,
      /unauthorized/i,
      /authentication.*failed/i,
      /NO_KEY/,
      /INVALID_KEY/,
    ],
    exclude: [/401k/i],
  },
  {
    category: 'CONTEXT_OVERFLOW',
    patterns: [
      /context_length_exceeded/i,
      /prompt too long/i,
      /maximum context length/i,
      /token limit/i,
      /context length/i,
      /too many tokens/i,
    ],
  },
  {
    category: 'INVALID_REQUEST',
    patterns: [/bad request/i, /invalid request/i, /missing required/i, /invalid parameter/i, /invalid message/i, /API_ERROR:4/i],
    exclude: [/context_length/i, /token limit/i, /401/i, /unauthorized/i],
  },
  {
    category: 'TOOL_SCHEMA_ERROR',
    patterns: [
      /tool call.*schema/i,
      /tool.*parameter/i,
      /invalid.*argument/i,
      /function.*not found/i,
      /no tool/i,
      /unknown tool/i,
      /arguments.*invalid/i,
      /validation error.*tool/i,
    ],
  },
  {
    category: 'FATAL',
    patterns: [/out of memory/i, /oom/i, /enomem/i, /crash/i, /segfault/i, /segmentation fault/i, /fatal/i, /unrecoverable/i],
  },
]

/**
 * 计算指数退避延迟（毫秒）
 */
export function computeBackoff(baseMs: number, attempt: number, jitter = true): number {
  const delay = baseMs * Math.pow(2, attempt)
  return jitter ? delay + Math.floor(Math.random() * 1000) : delay
}

/**
 * 分类错误并返回策略
 */
export function classify(error: string): ClassificationResult {
  if (!error) {
    return {
      category: 'FATAL',
      strategy: STRATEGIES.FATAL,
      retryDelayMs: 0,
      originalError: error,
    }
  }

  for (const rule of MATCH_RULES) {
    const matched = rule.patterns.some((p) => p.test(error))
    if (!matched) continue

    if (rule.exclude) {
      const excluded = rule.exclude.some((p) => p.test(error))
      if (excluded) continue
    }

    const strategy = STRATEGIES[rule.category]
    const retryDelayMs = strategy.shouldRetry && strategy.backoffBaseMs > 0 ? computeBackoff(strategy.backoffBaseMs, 0) : 0

    log('INFO', 'error_classified', {
      category: rule.category,
      error: error.slice(0, 200),
      retryDelayMs,
    })

    return {
      category: rule.category,
      strategy,
      retryDelayMs,
      originalError: error,
    }
  }

  // 裸 400 没有匹配到具体规则 → CORRUPTED_STATE（不是 INVALID_REQUEST，因为 LLM 400 通常是 state corruption）
  if (/^400$|^400\b|400 error|API_ERROR:400/i.test(error) && !/context|length|token|too large/i.test(error)) {
    const strategy = STRATEGIES.CORRUPTED_STATE
    return {
      category: 'CORRUPTED_STATE',
      strategy,
      retryDelayMs: 0,
      originalError: error,
    }
  }

  // 无匹配 → FATAL
  log('WARN', 'error_unclassified', { error: error.slice(0, 200) })
  return {
    category: 'FATAL',
    strategy: STRATEGIES.FATAL,
    retryDelayMs: 0,
    originalError: error,
  }
}

/**
 * 获取友好的用户消息
 */
export function getUserMessage(category: ErrorCategory, originalError: string): string {
  const strategy = STRATEGIES[category]
  if (category === 'FATAL') {
    return `${strategy.message}\n错误: ${originalError.slice(0, 200)}`
  }
  return strategy.message
}
