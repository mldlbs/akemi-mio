/**
 * DynamicToolPermission — 动态工具权限控制
 *
 * 为动态注册的工具提供分级权限机制：
 * - 防止未授权的敏感操作（文件系统、网络、命令执行）
 * - 提供预设权限模板（permission levels）
 * - 运行时权限检查
 *
 * ## 权限级别
 *
 * | 级别       | 值  | 允许的操作                        | 适用场景                 |
 * |-----------|-----|----------------------------------|------------------------|
 * | NONE      | 0   | 仅纯计算（无副作用）                | 数据格式化、计算辅助       |
 * | READONLY  | 1   | 纯计算 + 读取环境变量               | 信息查询、状态检查         |
 * | FILES     | 2   | READONLY + 文件读写                | 文件处理、配置修改         |
 * | NETWORK   | 3   | FILES + 网络请求（fetch）          | API 调用、数据获取        |
 * | CUSTOM    | 4   | 自定义权限（白名单模式）             | 特定场景的高级工具         |
 *
 * ## 权限评估流程
 *
 * register_tool 调用 → 权限级别检查 → handler 代码安全检查 → 注册
 *                            ↓
 *                    级别不足则拒绝注册
 *
 * ## 安全备注
 *
 * 此权限系统与 CapabilityEngine（Phase 4）互补：
 * - CapabilityEngine：控制工具执行时的操作授权
 * - DynamicToolPermission：控制工具注册时的代码安全
 *
 * 与 ConstitutionEngine 的关系：
 * - ConstitutionEngine：保护项目路径不受写入
 * - DynamicToolPermission：阻止危险代码的注册
 */

import { log } from '../../logger/Logger'

// =============================================================================
// 权限级别枚举
// =============================================================================

export enum PermissionLevel {
  /** 无权限：仅纯计算，无副作用 */
  NONE = 0,
  /** 只读：纯计算 + 读取环境信息 */
  READONLY = 1,
  /** 文件访问：READONLY + 文件读写 */
  FILES = 2,
  /** 网络访问：FILES + 网络请求 */
  NETWORK = 3,
  /** 自定义：白名单模式 */
  CUSTOM = 4,
}

/** 权限级别标签 */
export const PERMISSION_LABELS: Record<PermissionLevel, string> = {
  [PermissionLevel.NONE]: 'none',
  [PermissionLevel.READONLY]: 'readonly',
  [PermissionLevel.FILES]: 'files',
  [PermissionLevel.NETWORK]: 'network',
  [PermissionLevel.CUSTOM]: 'custom',
}

/** 字符串到权限级别的映射 */
const PERMISSION_FROM_STRING: Record<string, PermissionLevel> = {
  none: PermissionLevel.NONE,
  readonly: PermissionLevel.READONLY,
  read: PermissionLevel.READONLY,
  files: PermissionLevel.FILES,
  file: PermissionLevel.FILES,
  network: PermissionLevel.NETWORK,
  net: PermissionLevel.NETWORK,
  custom: PermissionLevel.CUSTOM,
}

/** 权限级别描述 */
const PERMISSION_DESCRIPTIONS: Record<PermissionLevel, string> = {
  [PermissionLevel.NONE]: '仅纯计算操作（数学运算、字符串处理、数据转换），无任何外部访问',
  [PermissionLevel.READONLY]: '纯计算 + 有限只读操作，无写入、无网络',
  [PermissionLevel.FILES]: '文件读写 + 只读操作，无网络请求',
  [PermissionLevel.NETWORK]: '文件读写 + 网络请求',
  [PermissionLevel.CUSTOM]: '自定义白名单权限',
}

// =============================================================================
// 权限级别解析
// =============================================================================

/**
 * 将字符串权限值解析为 PermissionLevel。
 * 支持：'none' | 'readonly' | 'files' | 'network' | 'custom'
 */
export function parsePermissionLevel(value: string): PermissionLevel {
  const key = value.toLowerCase().trim()
  const level = PERMISSION_FROM_STRING[key]
  if (level !== undefined) return level

  // 尝试数字解析
  const num = parseInt(value, 10)
  if (!isNaN(num) && num >= 0 && num <= 4) {
    return num as PermissionLevel
  }

  return PermissionLevel.NONE
}

// =============================================================================
// 权限配置
// =============================================================================

/** 单次注册的权限配置 */
export interface ToolPermissionConfig {
  /** 权限级别 */
  level: PermissionLevel

  /** CUSTOM 模式下的白名单 API 列表（如 ['fetch', 'writeFile']） */
  allowedApis?: string[]

  /** 文件访问白名单路径前缀（仅 FILES 及以上级别有效） */
  allowedPaths?: string[]

  /** 网络请求白名单域名（仅 NETWORK 级别有效） */
  allowedDomains?: string[]

  /** handler 超时（毫秒），默认 15000 */
  timeoutMs?: number
}

/** 默认权限配置 */
const DEFAULT_PERMISSION: ToolPermissionConfig = {
  level: PermissionLevel.READONLY,
  timeoutMs: 15_000,
}

// =============================================================================
// 权限检查结果
// =============================================================================

export interface PermissionCheckResult {
  /** 是否通过 */
  allowed: boolean
  /** 拒绝原因 */
  reason?: string
  /** 所需的最低级别 */
  requiredLevel?: PermissionLevel
  /** 当前级别 */
  currentLevel?: PermissionLevel
}

// =============================================================================
// API 权限映射
// =============================================================================

/** 各 API 所需的最低权限级别 */
const API_REQUIRED_LEVEL: Record<string, PermissionLevel> = {
  // 纯计算（NONE 即可）
  Math: PermissionLevel.NONE,
  JSON: PermissionLevel.NONE,
  String: PermissionLevel.NONE,
  Array: PermissionLevel.NONE,
  Date: PermissionLevel.NONE,
  RegExp: PermissionLevel.NONE,

  // 环境读取（READONLY）
  process: PermissionLevel.READONLY,
  env: PermissionLevel.READONLY,

  // 文件系统（FILES）
  readFile: PermissionLevel.FILES,
  writeFile: PermissionLevel.FILES,
  readdir: PermissionLevel.FILES,
  mkdir: PermissionLevel.FILES,
  unlink: PermissionLevel.FILES,
  fs: PermissionLevel.FILES,
  path: PermissionLevel.FILES,

  // 网络（NETWORK）
  fetch: PermissionLevel.NETWORK,
  http: PermissionLevel.NETWORK,
  https: PermissionLevel.NETWORK,
  WebSocket: PermissionLevel.NETWORK,
  XMLHttpRequest: PermissionLevel.NETWORK,
}

// =============================================================================
// DynamicToolPermission
// =============================================================================

export class DynamicToolPermission {
  /** 全局最大权限级别（注册时不能超过此值） */
  private globalMaxLevel: PermissionLevel = PermissionLevel.NETWORK

  /** 会话级别权限覆盖 */
  private sessionMaxLevels = new Map<string, PermissionLevel>()

  /** 自定义白名单：API 名 → 允许的会话列表 */
  private apiWhitelist = new Map<string, Set<string>>()

  /** 登记的黑名单 API */
  private blacklistedApis = new Set<string>(['exec', 'spawn', 'fork', 'execFile', 'eval', 'Function'])

  // =============================================================================
  // 配置
  // =============================================================================

  /**
   * 设置全局最大权限级别。
   * 任何会话的注册请求都不能超过此级别。
   */
  setGlobalMaxLevel(level: PermissionLevel): void {
    this.globalMaxLevel = level
    log('INFO', 'dynamic_permission_global_max', {
      level: PERMISSION_LABELS[level],
    })
  }

  /**
   * 设置会话的最大权限级别（覆盖全局设置）。
   */
  setSessionMaxLevel(sessionId: string, level: PermissionLevel): void {
    if (level > this.globalMaxLevel) {
      log('WARN', 'dynamic_permission_session_exceeds_global', {
        sessionId,
        sessionLevel: PERMISSION_LABELS[level],
        globalLevel: PERMISSION_LABELS[this.globalMaxLevel],
      })
      level = this.globalMaxLevel
    }
    this.sessionMaxLevels.set(sessionId, level)
  }

  /**
   * 获取会话的有效最大级别。
   */
  getSessionMaxLevel(sessionId: string): PermissionLevel {
    return this.sessionMaxLevels.get(sessionId) ?? this.globalMaxLevel
  }

  /**
   * 重置会话权限为全局默认。
   */
  resetSessionLevel(sessionId: string): void {
    this.sessionMaxLevels.delete(sessionId)
  }

  // =============================================================================
  // 权限检查
  // =============================================================================

  /**
   * 检查给定权限配置是否允许注册。
   *
   * @param config 请求的权限配置
   * @param sessionId 会话 ID
   * @returns 检查结果
   */
  checkRegistration(
    config: ToolPermissionConfig,
    sessionId: string,
  ): PermissionCheckResult {
    const maxLevel = this.getSessionMaxLevel(sessionId)

    if (config.level > maxLevel) {
      return {
        allowed: false,
        reason: `权限级别不足：请求级别 ${PERMISSION_LABELS[config.level]}(${config.level}) 超过会话最大级别 ${PERMISSION_LABELS[maxLevel]}(${maxLevel})`,
        requiredLevel: maxLevel,
        currentLevel: config.level,
      }
    }

    return { allowed: true }
  }

  /**
   * 检查 handler 代码中使用的 API 是否超出权限级别。
   *
   * @param handlerBody handler 代码体
   * @param config 权限配置
   * @returns 检查结果
   */
  checkHandlerApis(
    handlerBody: string,
    config: ToolPermissionConfig,
  ): PermissionCheckResult {
    const violations: string[] = []

    for (const [api, requiredLevel] of Object.entries(API_REQUIRED_LEVEL)) {
      if (requiredLevel > config.level) {
        // 检查 handler 中是否引用了此 API
        const pattern = new RegExp(`\\b${api}\\b`, 'g')
        if (pattern.test(handlerBody)) {
          // CUSTOM 模式下检查白名单
          if (config.level === PermissionLevel.CUSTOM && config.allowedApis) {
            if (config.allowedApis.includes(api)) continue
          }

          // 检查是否在黑名单中
          if (this.blacklistedApis.has(api)) {
            violations.push(`${api}(黑名单)`)
            continue
          }

          violations.push(`${api}(需要 ${PERMISSION_LABELS[requiredLevel]})`)
        }
      }
    }

    if (violations.length > 0) {
      return {
        allowed: false,
        reason: `Handler 使用的 API 超出权限级别 ${PERMISSION_LABELS[config.level]}：${violations.join(', ')}`,
        currentLevel: config.level,
      }
    }

    return { allowed: true }
  }

  // =============================================================================
  // 黑名单管理
  // =============================================================================

  /**
   * 添加一个 API 到黑名单（任何级别都不能使用）。
   */
  addToBlacklist(apiName: string): void {
    this.blacklistedApis.add(apiName)
  }

  /**
   * 从黑名单移除。
   */
  removeFromBlacklist(apiName: string): void {
    this.blacklistedApis.delete(apiName)
  }

  /**
   * 获取黑名单列表。
   */
  getBlacklist(): string[] {
    return Array.from(this.blacklistedApis)
  }

  // =============================================================================
  // 工具方法
  // =============================================================================

  /**
   * 获取权限级别的描述文本。
   */
  static getLevelDescription(level: PermissionLevel): string {
    return PERMISSION_DESCRIPTIONS[level] || '未知权限级别'
  }

  /**
   * 获取权限级别标签。
   */
  static getLevelLabel(level: PermissionLevel): string {
    return PERMISSION_LABELS[level] || `level_${level}`
  }
}

// =============================================================================
// 全局单例
// =============================================================================

export const dynamicToolPermission = new DynamicToolPermission()
