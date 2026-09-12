/**
 * ToolInvocationRouter — LLM tool_call 分发层
 *
 * ADR-015 P1.3a 决策 9:
 * - LLM 返回的 tool_call 先经由此路由器
 * - capability 函数 → CapabilityService.invoke()
 * - 普通工具 → ServerManager.callTool()
 *
 * ServerManager 不感知 Capability（C-9）。
 *
 * 数据流：
 * ```
 * LLM tool_call (function_name, args)
 *     |
 *     v
 * ToolInvocationRouter
 *     |
 *     ├── capability 名 → ToolInvocationRouter.dispatchCapability()
 *     │                       │
 *     │                       v
 *     │                   CapabilityService.resolve(capability)
 *     │                       │
 *     │                       v
 *     │                   CapabilityService.invoke(binding, args)
 *     │                       │
 *     │                       v
 *     │                   capability.selected + invoked/completed events
 *     │
 *     └── 普通工具 → ServerManager.callTool(name, args)
 *                         │
 *                         v
 *                     tool.invoked/completed events (existing)
 * ```
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import type { ServerManager } from '@akemi-mio/intelligence-mcp/ServerManager'
import type { CapabilityServiceImpl } from '../capability/CapabilityServiceImpl'
import type { ToolSchemaProvider } from './ToolSchemaProvider'

/** 路由结果 */
export interface DispatchResult {
  /** 实际执行结果 */
  result: string
  /** 路由类型：capability 或 tool */
  routedAs: 'capability' | 'tool'
  /** 如果路由到 capability，记录 capability id */
  capability?: string
}

export class ToolInvocationRouter {
  private serverManager: ServerManager
  private capabilityService: CapabilityServiceImpl | null = null
  private schemaProvider: ToolSchemaProvider

  constructor(serverManager: ServerManager, schemaProvider: ToolSchemaProvider, capabilityService?: CapabilityServiceImpl) {
    this.serverManager = serverManager
    this.schemaProvider = schemaProvider
    this.capabilityService = capabilityService ?? null
  }

  /** 设置或替换 capability service（延迟绑定） */
  setCapabilityService(service: CapabilityServiceImpl | null): void {
    this.capabilityService = service
  }

  /**
   * 分发单条 tool_call。
   *
   * @param name function name
   * @param args function arguments
   * @returns DispatchResult
   */
  async dispatch(name: string, args: Record<string, unknown>): Promise<DispatchResult> {
    // P1.3b Observation #2: call_raw_tool — 记录来源分类
    if (this.schemaProvider.isCallRawTool(name)) {
      const reason = (args._reason as string) ?? 'unknown'
      const toolName = (args.toolName as string) ?? ''
      const toolArgs = (args.args as Record<string, unknown>) ?? {}
      if (!toolName) {
        return { result: 'Error: call_raw_tool requires "toolName" parameter', routedAs: 'tool' }
      }
      log('INFO', 'tool_router.raw_tool_fallback', { toolName, reason })
      return this.dispatchTool(toolName, toolArgs)
    }

    const isCap = this.schemaProvider.isCapabilityTool(name)
    if (isCap && this.capabilityService) {
      return this.dispatchCapability(name, args)
    }
    return this.dispatchTool(name, args)
  }

  /**
   * 分发到 CapabilityService。
   * 发射 capability.selected → capability.invoked → capability.completed 事件。
   */
  private async dispatchCapability(capability: string, input: Record<string, unknown>): Promise<DispatchResult> {
    if (!this.capabilityService) {
      log('WARN', 'tool_router.capability_no_service', { capability })
      // 降级到普通工具路由
      return this.dispatchTool(capability, input)
    }

    // 将 sanitized function name 解析回原始 capability id
    const capId = this.schemaProvider.resolveCapabilityName?.(capability) ?? capability

    // 1. 发射 capability.selected（P1.3a 观测）
    eventBus.emit('capability.selected', {
      capability: capId,
      source: 'llm_function_call',
      toolCallId: '',
      input,
    })

    // 2. resolve + invoke
    const binding = await this.capabilityService.resolve(capId)
    if (!binding) {
      log('WARN', 'tool_router.resolve_failed', { capability: capId })
      return {
        result: `Error: Capability "${capId}" could not be resolved. The capability might not be available.`,
        routedAs: 'capability',
        capability: capId,
      }
    }

    try {
      const result = await this.capabilityService.invoke(binding, input)
      const text = typeof result === 'string' ? result : JSON.stringify(result)
      log('INFO', 'tool_router.capability_success', { capability: capId, tool: binding.tool })
      return { result: text, routedAs: 'capability', capability: capId }
    } catch (err: any) {
      log('WARN', 'tool_router.capability_failed', { capability: capId, error: err.message })
      return {
        result: `Error executing capability "${capId}": ${err.message}`,
        routedAs: 'capability',
        capability: capId,
      }
    }
  }

  /**
   * 分发到 ServerManager（原始工具路径）。
   * 无降级 — 必须是 ServerManager 可识别的工具。
   */
  private async dispatchTool(name: string, args: Record<string, unknown>): Promise<DispatchResult> {
    const result = await this.serverManager.callTool(name, args)
    return { result, routedAs: 'tool' }
  }
}

