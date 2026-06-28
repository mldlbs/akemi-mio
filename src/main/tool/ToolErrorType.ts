/**
 * ToolErrorType — 工具调用错误分类
 *
 * 单一事实来源，替代 ToolAvailabilityCache 和 ToolScheduler 中
 * 各自维护的硬编码字符串列表。
 *
 * 分类原则：
 *   TOOL_MISSING / MCP_ERROR → 工具本身不可用，缓存 30 分钟
 *   ENVIRONMENT / PERMISSION / ARGUMENT → 本次调用失败，但不缓存，LLM 可换路
 *   TRANSIENT → 可重试
 */

export enum ToolErrorType {
  TRANSIENT = 'TRANSIENT',
  ENVIRONMENT = 'ENVIRONMENT',
  PERMISSION = 'PERMISSION',
  ARGUMENT = 'ARGUMENT',
  TOOL_MISSING = 'TOOL_MISSING',
  MCP_ERROR = 'MCP_ERROR',
  UNKNOWN = 'UNKNOWN',
}

interface MatchRule {
  type: ToolErrorType
  patterns: RegExp[]
}

/** 优先级从高到低（首个匹配胜出） */
const MATCH_RULES: MatchRule[] = [
  {
    type: ToolErrorType.MCP_ERROR,
    patterns: [/MCP disconnected/i, /The operation was aborted/i, /ECONNREFUSED/i, /connection refused/i, /MCP 服务器不可用/],
  },
  {
    type: ToolErrorType.TOOL_MISSING,
    patterns: [/未知工具/, /unknown tool/i, /tool not registered/i, /tool not found/i],
  },
  {
    type: ToolErrorType.PERMISSION,
    patterns: [/EACCES/i, /permission denied/i, /权限不足/, /Access denied/i, /不允许执行命令/],
  },
  {
    type: ToolErrorType.ENVIRONMENT,
    patterns: [
      /command not found/i,
      /is not recognized as an internal/i,
      /is not recognized as an operable/i,
      /pm2 not found/i,
      /nginx: command not found/i,
      /docker[^\s]* (not found|not running|daemon not running)/i,
      /没有那个命令/,
      /找不到命令/,
    ],
  },
  {
    type: ToolErrorType.TRANSIENT,
    patterns: [/tool timeout/i, /\btimeout\b/i, /ETIMEDOUT/i, /ENETUNREACH/i, /socket hang up/i, /ECONNRESET/i],
  },
  {
    type: ToolErrorType.ARGUMENT,
    patterns: [
      /目录不存在/,
      /路径不存在/,
      /路径是目录/,
      /path 参数必须为字符串/,
      /超出项目根目录/,
      /超出工作区目录/,
      /子目录不存在/,
      /不能直接写入/,
      /ENOENT/,
      /EISDIR/,
      /No such file or directory/i,
      /is not defined/i,
      /Cannot find module/i,
      /JSONDecodeError/,
      /Expecting value/,
      /Invalid signal specification/i,
      /未在.*中找到匹配的文本/,
      /找不到/,
      /没有找到/,
      /不存在/,
    ],
  },
]

/**
 * 分类工具调用错误消息
 * 返回枚举值，下游据此决定是否缓存、是否重试、如何引导 LLM
 */
export function classifyToolError(message: string): ToolErrorType {
  if (!message) return ToolErrorType.UNKNOWN

  for (const rule of MATCH_RULES) {
    for (const p of rule.patterns) {
      if (p.test(message)) return rule.type
    }
  }

  return ToolErrorType.UNKNOWN
}
