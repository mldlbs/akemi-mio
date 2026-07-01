import { useAgentStore } from './agentStore'
import { useDeviceStore } from './deviceStore'
import { useSessionStore } from './sessionStore'
import { usePlansStore } from './plansStore'
import { useWorkflowStore } from './workflowStore'

export function resetAllStores() {
  useAgentStore.setState({
    agentState: 'idle',
    pendingText: '',
    displayText: '',
    transcribed: '',
    toolStatus: null,
    toolRunning: [],
    toolCompleted: [],
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
    runs: [],
    loading: true,
  })
}
