import { useAgentStore } from './agentStore'
import { useDeviceStore } from './deviceStore'
import { useSessionStore } from './sessionStore'
import { usePlansStore } from './plansStore'
import { useWorkflowStore } from './workflowStore'
import { useHistoryViewStore } from './historyViewStore'

export function resetAllStores() {
  useAgentStore.setState({
    agentState: 'idle',
    pendingText: '',
    displayText: '',
    transcribed: '',
    toolStatus: null,
    tools: [],
  })
  useDeviceStore.setState({
    active: false,
    ttsPlaying: false,
    error: undefined,
    sessionHealth: '100:HEALTHY:RUNNING',
    personaLevel: 'core',
    settingsOpen: false,
  })
  useSessionStore.setState({
    sessions: [],
    sessionsLoading: true,
    activeSessionId: '',
    historyMessages: [],
    historyLoading: false,
    skipDbLoad: false,
  })
  usePlansStore.setState({
    activePlan: null,
    planHistory: [],
    otparStages: [],
  })
  useWorkflowStore.setState({
    definitions: [],
    workflowRuns: [],
    loading: true,
  })
  useHistoryViewStore.setState({
    viewing: false,
    sessionId: null,
    sessionLabel: '',
    messages: [],
    loading: false,
    error: null,
  })
}
