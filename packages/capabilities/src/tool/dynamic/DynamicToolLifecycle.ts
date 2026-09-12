/**
 * DynamicToolLifecycle — 动态工具生命周期管理
 *
 * 管理在对话过程中注册的临时工具的生命周期：
 * - 会话（session）级别：对话结束后自动清理
 * - 全局级别：应用关闭时清理
 *
 * ## 生命周期规则
 *
 * 1. 工具通过 `register_tool` 注册时，自动关联当前会话 ID
 * 2. 会话结束时（cleanupSession），会话内所有动态工具被注销
 * 3. 应用关闭时（cleanupAll），所有动态工具被清理
 * 4. 工具记录包含注册时间、提供者名、元数据
 *
 * ## 与 ToolProviderRegistry 的关系
 *
 * 此模块是 ToolProviderRegistry 的高层管理器：
 * - 记录哪个工具属于哪个会话
 * - 提供会话级批量清理
 * - 不替代 ToolProviderRegistry（底层注册仍由 registry 处理）
 *
 * ## 与 ToolGeneratorService 的差异
 *
 * ToolGeneratorService 生成的工具使用 '@dynamic/' 前缀提供者名，
 * 但清理逻辑分散在各处。DynamicToolLifecycle 提供统一的生命周期入口。
 *
 * 工具注册路径对比：
 *
 * | 方式              | 提供者前缀            | 生命周期管理               |
 * |------------------|---------------------|---------------------------|
 * | create_tool      | @dynamic/           | 依赖外部 cleanup, 无会话关联 |
 * | register_tool    | @session/           | DynamicToolLifecycle 管理  |
 * | 内置工具          | @builtin/core       | 无（持久存在）              |
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { toolProviderRegistry } from '@akemi-mio/capabilities/tool/registry'
import { adaptToToolProvider } from '@akemi-mio/capabilities/tool/IToolProvider'
import { formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'
import type { Tool } from '@akemi-mio/capabilities/tool/types'
import type { MCPToolResult } from '@akemi-mio/intelligence-mcp/types'

// =============================================================================
// 类型定义
// =============================================================================

/** 会话级别动态工具记录 */
export interface DynamicToolRecord {
  /** 工具名 */
  name: string
  /** 所属提供者名 */
  providerName: string
  /** 所属会话 ID */
  sessionId: string
  /** 注册时间戳 */
  registeredAt: number
  /** 工具描述 */
  description: string
  /** 输入参数 Schema */
  inputJSONSchema: Tool['inputJSONSchema']
  /** 自定义标签 */
  tags: string[]
}

/** 会话级清理选项 */
export interface CleanupOptions {
  /** 清理时要触发的 onUnregister 回调 */
  triggerOnUnregister: boolean
  /** 是否记录清理日志 */
  verbose: boolean
}

const DEFAULT_CLEANUP_OPTIONS: CleanupOptions = {
  triggerOnUnregister: true,
  verbose: true,
}

// =============================================================================
// 服务端会话提供者前缀
// =============================================================================

/** 会话动态工具提供者前缀 */
export const SESSION_PROVIDER_PREFIX = '@session/'

// =============================================================================
// DynamicToolLifecycle
// =============================================================================

export class DynamicToolLifecycle {
  /** 会话 ID → 工具名列表 */
  private sessionTools = new Map<string, Set<string>>()

  /** 工具名 → 记录 */
  private toolRecords = new Map<string, DynamicToolRecord>()

  /** 全局计数器（用于生成唯一提供者名） */
  private providerCounter = 0

  // =============================================================================
  // 注册
  // =============================================================================

  /**
   * 在指定会话中注册一个动态工具。
   *
   * @param sessionId 会话 ID（如 requestId 或 conversationId）
   * @param name 工具名
   * @param description 工具描述
   * @param inputJSONSchema 输入 JSON Schema
   * @param handler 工具处理器
   * @param tags 可选标签
   * @returns 提供者名
   */
  registerTool(
    sessionId: string,
    name: string,
    description: string,
    inputJSONSchema: Tool['inputJSONSchema'],
    handler: (args: Record<string, any>) => Promise<MCPToolResult>,
    tags: string[] = [],
  ): string {
    // 检查工具名冲突
    const existingTool = toolProviderRegistry.getTool(name)
    if (existingTool) {
      // 允许同名但属于同一会话的覆盖
      const existingRecord = this.toolRecords.get(name)
      if (existingRecord && existingRecord.sessionId !== sessionId) {
        throw new Error(`工具 "${name}" 已被其他会话注册。请使用不同的工具名，或先清理其他会话的工具。`)
      }
      // 如果同一会话内已注册，先注销
      if (existingRecord && existingRecord.sessionId === sessionId) {
        this.unregisterTool(name, sessionId)
      }
      // 如果工具来自内置或其他持久提供者，不允许覆盖
      if (!existingRecord) {
        throw new Error(`工具 "${name}" 与内置工具冲突，无法注册`)
      }
    }

    // 生成提供者名
    this.providerCounter++
    const providerName = `${SESSION_PROVIDER_PREFIX}${name}_${this.providerCounter}`

    // 封装 handler（添加日志和超时）
    const wrappedHandler = async (args: Record<string, any>): Promise<MCPToolResult> => {
      try {
        const result = await handler(args)
        return result
      } catch (err: any) {
        return formatToolError(`动态工具 "${name}" 执行失败: ${err.message}`)
      }
    }

    // 注册到 ToolProviderRegistry
    toolProviderRegistry.register(adaptToToolProvider(providerName, `会话动态工具 (${sessionId}): ${description}`, [
      {
        name,
        description,
        inputJSONSchema,
        handler: wrappedHandler,
      },
    ]))

    // 记录
    const record: DynamicToolRecord = {
      name,
      providerName,
      sessionId,
      registeredAt: Date.now(),
      description,
      inputJSONSchema,
      tags,
    }

    this.toolRecords.set(name, record)

    // 关联到会话
    if (!this.sessionTools.has(sessionId)) {
      this.sessionTools.set(sessionId, new Set())
    }
    this.sessionTools.get(sessionId)!.add(name)

    log('INFO', 'dynamic_tool_registered', {
      name,
      sessionId,
      providerName,
      tags,
    })

    return providerName
  }

  /**
   * 注册一个使用沙箱执行的动态工具。
   * handler 代码在 DynamicToolSandbox 中执行。
   *
   * @param sessionId 会话 ID
   * @param name 工具名
   * @param description 工具描述
   * @param inputJSONSchema 输入 JSON Schema
   * @param handlerBody 纯 JavaScript handler 函数体
   * @param tags 可选标签
   * @param sandboxConfig 沙箱配置
   * @returns 注册结果
   */
  async registerToolWithSandbox(
    sessionId: string,
    name: string,
    description: string,
    inputJSONSchema: Tool['inputJSONSchema'],
    handlerBody: string,
    tags: string[] = [],
  ): Promise<{ success: boolean; providerName?: string; error?: string }> {
    try {
      // 导入沙箱
      const { executeInSandbox, checkHandlerSafety } = await import('./DynamicToolSandbox')

      // 安全检查
      const violations = checkHandlerSafety(handlerBody, { allowNetwork: false, allowFileSystem: false })
      if (violations.length > 0) {
        const details = violations.map((v) => v.description).join(', ')
        return { success: false, error: `代码安全检查未通过：检测到危险 API (${details})。如有正当需求，请调整权限设置。` }
      }

      // 构建沙箱执行 handler
      const handler = async (args: Record<string, any>): Promise<MCPToolResult> => {
        // 注入 args 到沙箱上下文
        const code = `
          const args = ${JSON.stringify(args)};
          ${handlerBody}
        `

        const result = await executeInSandbox(code, {}, { timeoutMs: 15_000 })

        if (!result.success) {
          return formatToolError(`动态工具执行失败: ${result.error}`)
        }

        return formatToolResult(result.value)
      }

      const providerName = this.registerTool(sessionId, name, description, inputJSONSchema, handler, tags)
      return { success: true, providerName }
    } catch (err: any) {
      return { success: false, error: `沙箱注册失败: ${err.message}` }
    }
  }

  // =============================================================================
  // 注销
  // =============================================================================

  /**
   * 注销单个动态工具。
   * 仅允许同一会话注销自己的工具。
   *
   * @param name 工具名
   * @param sessionId 会话 ID（仅该会话可以注销自己的工具）
   * @returns 是否成功注销
   */
  unregisterTool(name: string, sessionId: string): boolean {
    const record = this.toolRecords.get(name)
    if (!record) {
      log('WARN', 'dynamic_tool_unregister_not_found', { name })
      return false
    }

    if (record.sessionId !== sessionId) {
      log('WARN', 'dynamic_tool_unregister_wrong_session', {
        name,
        expectedSession: record.sessionId,
        actualSession: sessionId,
      })
      return false
    }

    return this.forceUnregister(name)
  }

  /**
   * 按名注销动态工具（不检查会话归属）。
   * 用于 Agent 主动调用的 unregister_tool 场景。
   */
  removeToolByName(name: string): boolean {
    const record = this.toolRecords.get(name)
    if (!record) return false

    const removed = toolProviderRegistry.unregister(record.providerName)

    if (removed) {
      this.toolRecords.delete(name)
      const sessionSet = this.sessionTools.get(record.sessionId)
      if (sessionSet) {
        sessionSet.delete(name)
        if (sessionSet.size === 0) {
          this.sessionTools.delete(record.sessionId)
        }
      }
      log('INFO', 'dynamic_tool_removed_by_name', { name })
    }

    return removed
  }

  /**
   * 强制注销工具（内部使用，不检查会话归属）。
   */
  private forceUnregister(name: string): boolean {
    const record = this.toolRecords.get(name)
    if (!record) return false

    const removed = toolProviderRegistry.unregister(record.providerName)

    if (removed) {
      this.toolRecords.delete(name)

      // 从会话记录中移除
      const sessionSet = this.sessionTools.get(record.sessionId)
      if (sessionSet) {
        sessionSet.delete(name)
        if (sessionSet.size === 0) {
          this.sessionTools.delete(record.sessionId)
        }
      }

      log('INFO', 'dynamic_tool_unregistered', {
        name,
        sessionId: record.sessionId,
      })
    }

    return removed
  }

  // =============================================================================
  // 会话级清理
  // =============================================================================

  /**
   * 清理指定会话的所有动态工具。
   * 在对话结束后调用，自动注销所有通过该会话注册的临时工具。
   *
   * @param sessionId 会话 ID
   * @param options 清理选项
   * @returns 清理的工具数量
   */
  cleanupSession(sessionId: string, options?: Partial<CleanupOptions>): number {
    const opts = { ...DEFAULT_CLEANUP_OPTIONS, ...options }
    const toolNames = this.sessionTools.get(sessionId)

    if (!toolNames || toolNames.size === 0) {
      if (opts.verbose) {
        log('DEBUG', 'dynamic_tool_cleanup_session_empty', { sessionId })
      }
      return 0
    }

    let count = 0
    for (const name of Array.from(toolNames)) {
      this.forceUnregister(name)
      count++
    }

    this.sessionTools.delete(sessionId)

    log('INFO', 'dynamic_tool_cleanup_session', {
      sessionId,
      count,
    })

    return count
  }

  /**
   * 清理除指定会话外的所有动态工具。
   * 用于会话切换时保持当前会话的工具。
   */
  cleanupExcept(sessionId: string): number {
    let count = 0
    const allSessions = Array.from(this.sessionTools.keys())

    for (const sid of allSessions) {
      if (sid !== sessionId) {
        count += this.cleanupSession(sid, { verbose: false })
      }
    }

    if (count > 0) {
      log('INFO', 'dynamic_tool_cleanup_except', { exceptSession: sessionId, count })
    }

    return count
  }

  // =============================================================================
  // 全局清理
  // =============================================================================

  /**
   * 清理所有动态工具（应用关闭时调用）。
   */
  cleanupAll(): number {
    const allSessions = Array.from(this.sessionTools.keys())
    let count = 0

    for (const sid of allSessions) {
      count += this.cleanupSession(sid, { verbose: false })
    }

    this.toolRecords.clear()
    this.providerCounter = 0

    log('INFO', 'dynamic_tool_cleanup_all', { count })
    return count
  }

  // =============================================================================
  // 查询
  // =============================================================================

  /**
   * 获取指定会话的所有动态工具记录。
   */
  getSessionTools(sessionId: string): DynamicToolRecord[] {
    const toolNames = this.sessionTools.get(sessionId)
    if (!toolNames) return []

    return Array.from(toolNames)
      .map((name) => this.toolRecords.get(name))
      .filter((r): r is DynamicToolRecord => r !== undefined)
  }

  /**
   * 获取所有动态工具记录。
   */
  getAllTools(): DynamicToolRecord[] {
    return Array.from(this.toolRecords.values())
  }

  /**
   * 获取工具记录。
   */
  getTool(name: string): DynamicToolRecord | undefined {
    return this.toolRecords.get(name)
  }

  /**
   * 获取活跃的会话 ID 列表。
   */
  getActiveSessionIds(): string[] {
    return Array.from(this.sessionTools.keys())
  }

  /**
   * 检查工具是否为动态注册的工具。
   */
  isDynamicTool(name: string): boolean {
    return this.toolRecords.has(name)
  }

  /**
   * 获取动态工具总数。
   */
  getCount(): number {
    return this.toolRecords.size
  }
}

// =============================================================================
// 全局单例
// =============================================================================

export const dynamicToolLifecycle = new DynamicToolLifecycle()

