import { LocalProviderAdapter } from '@akemi-mio/capabilities/tool/definitions/LocalProviderAdapter'
import type { MCPToolDefinition, MCPToolResult } from './types'
import { setMemoryService as setDepsMemoryService } from '@akemi-mio/capabilities/tool/deps'
import { WORKSPACE_DIR as WS_DIR } from '@akemi-mio/capabilities/tool/utils/workspace'

const _adapter = new LocalProviderAdapter()

let _memoryService: any = null
export function setMemoryService(ms: any): void {
  _memoryService = ms
  setDepsMemoryService(ms)
}

/**
 * 获取 LocalProviderAdapter 实例，用于运行时工具热替换。
 * 主要用于 Evolution 自动优化工具后的实时生效。
 */
export function getLocalProviderAdapter(): LocalProviderAdapter {
  return _adapter
}

/**
 * LocalProvider — 向后兼容适配器。
 * 所有工具实现已迁移到 src/main/tool/definitions/ 下独立文件，
 * 通过 LocalProviderAdapter 统一派发。
 */
export class LocalProvider {
  readonly name = '@builtin/core'

  getToolDefinitions(): MCPToolDefinition[] {
    return _adapter.getToolDefinitions()
  }

  async callTool(name: string, args: Record<string, any>): Promise<MCPToolResult> {
    return _adapter.callTool(name, args)
  }
}

// 保持被 ServerManager 引用的导出
export const WORKSPACE_DIR: string = WS_DIR
