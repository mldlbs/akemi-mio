import { log } from '../logger/Logger'

// =============================================================================
// 错误分类器 — 将 LLM/工具调用错误分类为不同类别，分配恢复策略
// =============================================================================

export type ErrorCategory =
  | 'RETRYABLE' // 429/500/502/503/timeout/网络
  | 'CONTEXT_OVERFLOW' // prompt 超长 / context_length_exceeded
  | 'INVALID_REQUEST' // 400 / 参数格式错误 / 消息校验失败
  | 'TOOL_SCHEMA_ERROR' // 工具调用参数不匹配 schema
  | 'FATAL' // OOM / crash / 不可恢复

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
    patterns: [
      /insufficient tool messages/i,
      /bad request/i,
      /invalid request/i,
      /missing required/i,
      /invalid parameter/i,
      /invalid message/i,
    ],
    exclude: [/context_length/i, /token limit/i],
  },
  {
    category: 'TOOL_SCHEMA_ERROR',
    patterns: [
      /tool call.*schema/i,
      /tool.*parameter/i,
      /invalid.*argument/i,
      /function.*not found/i,
      /no tool/i,
      /tool.*not found/i,
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

  // 裸 400 没有匹配到具体规则 → INVALID_REQUEST
  if (/^400$|^400\b|400 error/i.test(error) && !/context|length|token|too large/i.test(error)) {
    const strategy = STRATEGIES.INVALID_REQUEST
    return {
      category: 'INVALID_REQUEST',
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
