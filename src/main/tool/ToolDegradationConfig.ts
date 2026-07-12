/**
 * ToolDegradationConfig — 工具降级与回退配置接口
 *
 * 允许用户自定义降级规则：当某个工具因特定错误类型失败时，
 * 自动切换到替代工具。
 *
 * 配置注入方式：
 * 1. 编程式：ToolFallbackRegistry.addRule()
 * 2. JSON 配置：通过加载外部配置文件
 * 3. 运行时热更新：通过 IPC 或 UI 接口
 */

import { ToolErrorType } from './ToolErrorType'

// =============================================================================
// 类型定义
// =============================================================================

/** 降级规则触发条件 */
export type DegradationCondition =
  | { type: 'any_error' }
  | { type: 'specific_error'; errorType: ToolErrorType }
  | { type: 'error_pattern'; pattern: RegExp }

/** 单条降级规则 */
export interface DegradationRule {
  /** 规则唯一 ID，自动生成 */
  readonly id?: string
  /** 主工具名（触发降级的工具） */
  primaryTool: string
  /** 备选工具名 */
  fallbackTool: string
  /** 触发条件 */
  condition: DegradationCondition
  /** 最大回退重试次数（0 = 不重试，仅一次回退） */
  maxFallbackRetries?: number
  /** 回退退避基数（毫秒），默认 500 */
  fallbackBackoffMs?: number
  /** 规则描述 */
  description?: string
  /** 是否启用，默认 true */
  enabled?: boolean
}

/** 降级策略选项 */
export interface DegradationStrategy {
  /** 启用自动降级，默认 true */
  autoDegradation: boolean
  /** 启用自动重试，默认 true（覆盖 ToolSchedulerConfig.maxRetries） */
  autoRetry: boolean
  /** 最大回退链深度（A→B→C 最多 2 层），默认 2 */
  maxFallbackChainDepth: number
  /** 是否允许跨服务器回退（如本地工具→外部 MCP 工具），默认 false */
  crossServerFallback: boolean
  /** 降级时是否记录详细日志，默认 true */
  verboseLogging: boolean
}

/** 完整降级配置 */
export interface DegradationConfig {
  strategy: DegradationStrategy
  rules: DegradationRule[]
}

// =============================================================================
// 默认配置
// =============================================================================

const DEFAULT_STRATEGY: DegradationStrategy = {
  autoDegradation: true,
  autoRetry: true,
  maxFallbackChainDepth: 2,
  crossServerFallback: false,
  verboseLogging: true,
}

/**
 * 内置默认降级规则。
 * 按优先级排列：匹配条件越精确的规则排在越前面。
 */
const DEFAULT_RULES: DegradationRule[] = [
  // ── 文件读取类 ──
  {
    primaryTool: 'read_file',
    fallbackTool: 'read_multiple_files',
    condition: { type: 'any_error' },
    description: 'read_file 失败时尝试 read_multiple_files（单文件模式）',
  },
  {
    primaryTool: 'read_multiple_files',
    fallbackTool: 'read_file',
    condition: { type: 'any_error' },
    description: 'read_multiple_files 失败时降级为单文件逐个读取',
  },
  {
    primaryTool: 'grep',
    fallbackTool: 'search_files',
    condition: { type: 'any_error' },
    description: 'grep 失败时尝试 search_files（glob 搜索）',
  },
  // ── 文件写入类 ──
  {
    primaryTool: 'write_file',
    fallbackTool: 'append_file',
    condition: { type: 'specific_error', errorType: ToolErrorType.PERMISSION },
    description: 'write_file 因权限失败时尝试 append_file',
  },
  // ── 命令执行类 ──
  {
    primaryTool: 'run_command',
    fallbackTool: 'run_command',
    condition: { type: 'any_error' },
    description: 'run_command 失败时尝试使用不同 shell',
    // 注意：run_command→run_command 的 fallback 由 ToolScheduler 特殊处理
    // 如果系统检测到 shell 类型（cmd/bash），会自动切换
  },
  // ── SSH 类 ──
  {
    primaryTool: 'centos_exec',
    fallbackTool: 'run_command',
    condition: { type: 'specific_error', errorType: ToolErrorType.TRANSIENT },
    description: 'SSH 执行超时时尝试本地命令执行',
    crossServerFallback: true,
  },
  {
    primaryTool: 'centos_read_file',
    fallbackTool: 'read_file',
    condition: { type: 'any_error' },
    description: 'SSH 远程文件读取失败时尝试本地读取',
    crossServerFallback: true,
  },
  // ── 工具管理类 ──
  {
    primaryTool: 'list_skills',
    fallbackTool: 'list_tools',
    condition: { type: 'any_error' },
    description: 'list_skills 失败时尝试 list_tools',
  },
  {
    primaryTool: 'query_memories',
    fallbackTool: 'search_memories',
    condition: { type: 'any_error' },
    description: 'query_memories 失败时尝试 search_memories',
  },
]

// =============================================================================
// 全局默认配置
// =============================================================================

export const DEFAULT_DEGRADATION_CONFIG: DegradationConfig = {
  strategy: DEFAULT_STRATEGY,
  rules: DEFAULT_RULES,
}

/**
 * 辅助函数：根据主工具名和失败条件查找匹配的降级规则。
 * 按条件优先级排序：specific_error > error_pattern > any_error
 */
export function findMatchingRules(
  rules: DegradationRule[],
  primaryTool: string,
  errorType: ToolErrorType,
  errorMessage: string,
): DegradationRule[] {
  const matched: DegradationRule[] = []

  for (const rule of rules) {
    if (rule.primaryTool !== primaryTool) continue
    if (rule.enabled === false) continue

    const cond = rule.condition
    switch (cond.type) {
      case 'any_error':
        matched.push(rule)
        break
      case 'specific_error':
        if (cond.errorType === errorType) {
          matched.push(rule)
        }
        break
      case 'error_pattern':
        if (cond.pattern.test(errorMessage)) {
          matched.push(rule)
        }
        break
    }
  }

  // 排序：specific_error > error_pattern > any_error
  // 相同类型保持原顺序（注册顺序优先）
  const order = { 'specific_error': 0, 'error_pattern': 1, 'any_error': 2 }
  matched.sort((a, b) => {
    const orderA = order[a.condition.type as keyof typeof order] ?? 3
    const orderB = order[b.condition.type as keyof typeof order] ?? 3
    return orderA - orderB
  })

  return matched
}
