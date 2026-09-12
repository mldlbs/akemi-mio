/**
 * ProblemErrorType — Evolution 问题修复结果分类
 *
 * 迁移自 tool/ToolErrorType 的设计模式：
 * 将分散在 ProblemQueue 和 PipelineOrchestrator 中的硬编码判断逻辑
 * 收敛为单一事实来源，统一问题分类标准。
 *
 * 分类原则：
 *   UNFIXABLE / ENVIRONMENT → 问题本身无法修复或环境不支持，跳过重试
 *   TRANSIENT              → 临时故障，可重试
 *   REGRESSION             → 修复引发了回归，需回滚
 *   TIMEOUT                → 超时中断，可重试（延长超时）
 *   UNKNOWN                → 未知原因，保守重试
 */

// ── 修复结果分类枚举 ──

export enum ProblemErrorType {
  /** 临时故障：网络闪断、竞争条件、资源暂时不可用 → 可重试 */
  TRANSIENT = 'TRANSIENT',
  /** 环境缺失：缺少编译工具链、依赖未安装、运行时不存在 → 跳过重试 */
  ENVIRONMENT = 'ENVIRONMENT',
  /** 不可修复：文件不存在、设计限制、根本原因在外部的硬约束 → 跳过重试 */
  UNFIXABLE = 'UNFIXABLE',
  /** 回归：修复破坏了正常功能 → 需回滚而非重试 */
  REGRESSION = 'REGRESSION',
  /** 超时：修复执行超时 → 可重试（配合更长超时） */
  TIMEOUT = 'TIMEOUT',
  /** 未知 → 保守重试 */
  UNKNOWN = 'UNKNOWN',
}

// ── 匹配规则 ──

interface MatchRule {
  type: ProblemErrorType
  patterns: RegExp[]
}

/** 优先级从高到低（首个匹配胜出） */
const MATCH_RULES: MatchRule[] = [
  {
    type: ProblemErrorType.UNFIXABLE,
    patterns: [
      /file not found/i,
      /no such file/i,
      /ENOENT/i,
      /does not exist/i,
      /找不到文件/,
      /路径不存在/,
      /not a directory/i,
      /EISDIR/i,
      /cannot find module/i,
      /module not found/i,
      /无法修复/,
      /unsupported/i,
      /not supported/i,
      /not implemented/i,
      /不支持/,
      /未实现/,
      /依赖冲突/,
      /dependency conflict/i,
      /circular dependency/i,
      /循环依赖/,
      /版本不兼容/,
      /version conflict/i,
    ],
  },
  {
    type: ProblemErrorType.ENVIRONMENT,
    patterns: [
      /command not found/i,
      /not recognized as an internal/i,
      /not recognized as an operable/i,
      /没有那个命令/,
      /找不到命令/,
      /EACCES/i,
      /permission denied/i,
      /权限不足/,
      /disk full/i,
      /磁盘空间不足/,
      /out of memory/i,
      /内存不足/,
      /port already in use/i,
      /端口被占用/,
      /address already in use/i,
      /npm ERR/i,
      /yarn error/i,
      /pip install failed/i,
      /git not found/i,
      /docker.*not found/i,
      /node.*not found/i,
      /python.*not found/i,
    ],
  },
  {
    type: ProblemErrorType.REGRESSION,
    patterns: [
      /regression detected/i,
      /previously passing.*now failing/i,
      /测试从通过变为失败/,
      /回滚/,
      /rollback/i,
      /修复后出现/,
      /introduced.*error/i,
      /broke.*test/i,
      /导致.*测试失败/,
    ],
  },
  {
    type: ProblemErrorType.TIMEOUT,
    patterns: [
      /execution timeout/i,
      /timed out/i,
      /超过.*时间/,
      /执行超时/,
      /deadline exceeded/i,
      /deadline.*exceeded/i,
      /abort.*timeout/i,
    ],
  },
  {
    type: ProblemErrorType.TRANSIENT,
    patterns: [
      /ETIMEDOUT/i,
      /ENETUNREACH/i,
      /ECONNRESET/i,
      /ECONNREFUSED/i,
      /socket hang up/i,
      /network.*error/i,
      /网络.*错误/,
      /连接.*失败/,
      /timeout/i,
      /超时/,
      /temporary/i,
      /temporarily/i,
      /暂时.*不可用/,
      /rate limit/i,
      /too many requests/i,
      /请求过频/,
      /busy/i,
      /resource temporarily/i,
      /资源临时/,
      /retry later/i,
    ],
  },
]

/**
 * 分类问题修复错误消息
 *
 * @param message 修复失败的错误消息或总结文本
 * @returns 分类枚举值，下游据此决定重试策略
 */
export function classifyProblemError(message: string): ProblemErrorType {
  if (!message) return ProblemErrorType.UNKNOWN

  for (const rule of MATCH_RULES) {
    for (const p of rule.patterns) {
      if (p.test(message)) return rule.type
    }
  }

  return ProblemErrorType.UNKNOWN
}

/**
 * 判断给定类型的错误是否应该重试
 *
 * 可重试类型：TRANSIENT, TIMEOUT, UNKNOWN
 * 不可重试类型：UNFIXABLE, ENVIRONMENT
 * REGRESSION 需特别处理（回滚而非重试）
 */
export function shouldRetryOnError(errorType: ProblemErrorType): boolean {
  switch (errorType) {
    case ProblemErrorType.TRANSIENT:
    case ProblemErrorType.TIMEOUT:
    case ProblemErrorType.UNKNOWN:
      return true
    case ProblemErrorType.UNFIXABLE:
    case ProblemErrorType.ENVIRONMENT:
      return false
    case ProblemErrorType.REGRESSION:
      // 回归不应简单重试，应由上层决定回滚策略
      return false
  }
}

/**
 * 判断给定类型的错误是否应进入冷却缓存
 *
 * 可缓存类型：UNFIXABLE, ENVIRONMENT（同类问题无需再试）
 * 不可缓存类型：TRANSIENT, TIMEOUT, REGRESSION（状态可能变化）
 */
export function shouldCacheErrorType(errorType: ProblemErrorType): boolean {
  return errorType === ProblemErrorType.UNFIXABLE || errorType === ProblemErrorType.ENVIRONMENT
}
