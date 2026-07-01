import { useIPCEvent } from './useIPCEvent'
import { useAgentStore } from '../store/agentStore'
import type { ToolEvent } from '../slots/types'

export function useTools() {
  const store = useAgentStore()

  // tool:status 'start' 标志新一轮对话开始，清空旧 tool 列表
  useIPCEvent(window.electronAPI.onToolStatus, (status: { type: string }) => {
    if (status.type === 'start') {
      store.clearToolRunning()
      store.clearToolCompleted()
    }
  })

  useIPCEvent(window.electronAPI.onToolInvoked, (data: ToolEvent) => {
    const id = data.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    store.addToolRunning({ id, tool: data.tool, args: data.args })
  })

  useIPCEvent(window.electronAPI.onToolCompleted, (data: ToolEvent) => {
    const id = data.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    store.removeToolRunning(id)
    store.addToolCompleted({ id, tool: data.tool, latencyMs: data.latencyMs, result: data.result })
  })

  useIPCEvent(window.electronAPI.onToolFailed, (data: ToolEvent) => {
    const id = data.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    store.removeToolRunning(id)
    store.addToolCompleted({ id, tool: data.tool, latencyMs: data.latencyMs, error: data.error })
  })

  return {
    toolRunning: store.toolRunning,
    toolCompleted: store.toolCompleted,
  } as const
}
