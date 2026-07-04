import { create } from 'zustand'
import type { ToolState, ToolEvent } from '../tool/toolTypes'
import {
  createPending,
  transitionToRunning,
  transitionToSuccess,
  transitionToError,
  transitionToTimeout,
  transitionToCancelled,
} from '../tool/toolTypes'

export type AgentState = 'idle' | 'thinking' | 'tool_executing' | 'replying'

interface AgentStateData {
  agentState: AgentState
  pendingText: string
  displayText: string
  transcribed: string
  toolStatus: { type: string; tool: string; message: string } | null
  tools: ToolState[]
}

interface AgentActions {
  setAgentState: (state: AgentState) => void
  setPendingText: (text: string) => void
  appendPendingText: (chunk: string) => void
  setDisplayText: (text: string) => void
  setTranscribed: (text: string) => void
  setToolStatus: (status: AgentStateData['toolStatus']) => void
  addTool: (event: ToolEvent) => void
  clearTools: () => void
  resetAgent: () => void
}

type AgentStore = AgentStateData & AgentActions

const initialAgentState: AgentStateData = {
  agentState: 'idle',
  pendingText: '',
  displayText: '',
  transcribed: '',
  toolStatus: null,
  tools: [],
}

export const useAgentStore = create<AgentStore>((set) => ({
  ...initialAgentState,

  setAgentState: (agentState) => set({ agentState }),
  setPendingText: (pendingText) => set({ pendingText }),
  appendPendingText: (chunk) =>
    set((s) => ({
      pendingText: s.pendingText + chunk,
      agentState: s.agentState === 'thinking' || s.agentState === 'idle' ? 'replying' : s.agentState,
    })),
  setDisplayText: (displayText) => set({ displayText }),
  setTranscribed: (transcribed) => set({ transcribed }),
  setToolStatus: (toolStatus) =>
    set((s) => ({
      toolStatus,
      agentState: toolStatus?.type === 'start' ? 'tool_executing' : s.agentState === 'tool_executing' ? 'replying' : s.agentState,
    })),

  addTool: (event) =>
    set((s) => {
      const existing = s.tools.find((t) => t.id === event.id)

      // New tool from a start event — create via pending → running chain
      if (!existing) {
        if (event.type !== 'tool.started') return s
        const pending = createPending(event)
        const running = transitionToRunning(pending, event)
        return { tools: [...s.tools, running] }
      }

      // Existing tool — apply transition based on event type
      let next: ToolState
      switch (event.type) {
        case 'tool.started':
          next = transitionToRunning(existing, event)
          break
        case 'tool.succeeded':
          next = transitionToSuccess(existing, event)
          break
        case 'tool.failed':
          next = transitionToError(existing, event)
          break
        case 'tool.timedout':
          next = transitionToTimeout(existing, event)
          break
        case 'tool.cancelled':
          next = transitionToCancelled(existing, event)
          break
        default:
          return s
      }
      return { tools: s.tools.map((t) => (t.id === event.id ? next : t)) }
    }),

  clearTools: () => set({ tools: [] }),

  resetAgent: () => set(initialAgentState),
}))
