import { create } from 'zustand'

export type AgentState = 'idle' | 'thinking' | 'tool_executing' | 'replying'

interface ToolEventData {
  id: string
  tool: string
  args?: Record<string, any>
  result?: string
  error?: string
  latencyMs?: number
}

interface AgentStateData {
  agentState: AgentState
  pendingText: string
  displayText: string
  transcribed: string
  toolStatus: { type: string; tool: string; message: string } | null
  toolRunning: ToolEventData[]
  toolCompleted: ToolEventData[]
}

interface AgentActions {
  setAgentState: (state: AgentState) => void
  setPendingText: (text: string) => void
  appendPendingText: (chunk: string) => void
  setDisplayText: (text: string) => void
  setTranscribed: (text: string) => void
  setToolStatus: (status: AgentStateData['toolStatus']) => void
  addToolRunning: (tool: ToolEventData) => void
  removeToolRunning: (id: string) => void
  addToolCompleted: (tool: ToolEventData) => void
  clearToolRunning: () => void
  clearToolCompleted: () => void
  resetAgent: () => void
}

type AgentStore = AgentStateData & AgentActions

const initialAgent: AgentStateData = {
  agentState: 'idle',
  pendingText: '',
  displayText: '',
  transcribed: '',
  toolStatus: null,
  toolRunning: [],
  toolCompleted: [],
}

export const useAgentStore = create<AgentStore>((set) => ({
  ...initialAgent,

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
  addToolRunning: (tool) => set((s) => ({ toolRunning: [...s.toolRunning, tool] })),
  removeToolRunning: (id) => set((s) => ({ toolRunning: s.toolRunning.filter((t) => t.id !== id) })),
  addToolCompleted: (tool) => set((s) => ({ toolCompleted: [...s.toolCompleted, tool] })),
  clearToolRunning: () => set({ toolRunning: [] }),
  clearToolCompleted: () => set({ toolCompleted: [] }),
  resetAgent: () => set(initialAgent),
}))
