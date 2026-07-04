import { useIPCEvent } from './useIPCEvent'
import { useAgentStore } from '../store/agentStore'
import type { ToolIPCEvent } from '../slots/types'

export function useTools() {
  const store = useAgentStore()

  // tool:status 'start' 标志新一轮对话开始，清空 tool 列表
  useIPCEvent(window.electronAPI.onToolStatus, (status: { type: string }) => {
    if (status.type === 'start') {
      store.clearTools()
    }
  })

  useIPCEvent(window.electronAPI.onToolInvoked, (data: ToolIPCEvent) => {
    const id = data.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    store.addTool({
      type: 'tool.started',
      id,
      tool: data.tool,
      args: data.args,
      timestamp: Date.now(),
    })
  })

  useIPCEvent(window.electronAPI.onToolCompleted, (data: ToolIPCEvent) => {
    const id = data.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    store.addTool({
      type: 'tool.succeeded',
      id,
      result: data.result ?? '',
      latencyMs: data.latencyMs ?? 0,
      timestamp: Date.now(),
    })
  })

  useIPCEvent(window.electronAPI.onToolFailed, (data: ToolIPCEvent) => {
    const id = data.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    store.addTool({
      type: 'tool.failed',
      id,
      error: data.error ?? 'unknown error',
      latencyMs: data.latencyMs ?? 0,
      timestamp: Date.now(),
    })
  })

  return {
    tools: store.tools,
  } as const
}
