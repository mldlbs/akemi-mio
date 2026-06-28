import { VoiceInput } from './components/VoiceInput'
import { TopBar } from './components/TopBar'
import { Sidebar } from './components/Sidebar'
import { MainArea } from './components/MainArea'
import { InputBar } from './components/InputBar'
import { ChatSlot } from './components/ChatSlot'
import { ToolSlot } from './components/ToolSlot'
import { PreviewSlot } from './components/PreviewSlot'
import { WorkflowSlot } from './components/WorkflowSlot'
import { DevPlanSlot } from './components/DevPlanSlot'
import { OtparSlot } from './components/OtparSlot'
import { ErrorBoundary } from './components/ErrorBoundary'
import { SettingsModal } from './components/SettingsModal'
import { useSlots } from './slots/SlotContext'
import { useSessions, useAIOutput, useTools, useDeviceStatus, usePlans, useWorkflowDefinitions } from './hooks'

export type { MessageItem } from './slots/types'

function App() {
  const { sessions, activeSessionId, historyMessages, historyLoading, handleSelectChat } = useSessions()
  const device = useDeviceStatus()
  const { pendingText, displayText, transcribed, toolStatus, agentState, handleResult } = useAIOutput(
    activeSessionId,
    device.active,
    device.setError,
  )
  const { uiState } = useSlots()
  const { toolRunning, toolCompleted } = useTools()
  const { activePlan, otparStages } = usePlans()
  const {
    definitions: workflowDefs,
    runs: workflowRuns,
    activeRuns: workflowActiveRuns,
    loading: wfLoading,
    refresh: refreshWorkflows,
  } = useWorkflowDefinitions()

  return (
    <div className="app-shell">
      <TopBar
        conversationActive={device.active}
        ttsPlaying={device.ttsPlaying}
        error={device.error}
        sessionHealth={device.sessionHealth}
        personaLevel={device.personaLevel}
        onOpenSettings={() => device.setSettingsOpen(true)}
        agentState={agentState}
      />
      <div className="app-body">
        <Sidebar sessions={sessions} activeSessionId={activeSessionId} onSelectChat={handleSelectChat} />
        <MainArea>
          {uiState.activeSlot === 'tool' ? (
            <ToolSlot running={toolRunning} completed={toolCompleted} />
          ) : uiState.activeSlot === 'otpar' ? (
            <ErrorBoundary>
              <OtparSlot otparStages={otparStages} />
            </ErrorBoundary>
          ) : uiState.activeSlot === 'devplan' ? (
            <ErrorBoundary>
              <DevPlanSlot activePlan={activePlan} />
            </ErrorBoundary>
          ) : uiState.activeSlot === 'workflow' ? (
            <ErrorBoundary>
              <WorkflowSlot
                workflowDefs={workflowDefs}
                workflowRuns={workflowRuns}
                workflowActiveRuns={workflowActiveRuns}
                wfLoading={wfLoading}
                onRefreshDefs={refreshWorkflows}
              />
            </ErrorBoundary>
          ) : uiState.activeSlot === 'preview' ? (
            <PreviewSlot />
          ) : (
            <ChatSlot
              messages={historyMessages}
              pendingText={pendingText}
              displayText={displayText}
              transcribed={transcribed}
              toolStatus={toolStatus}
              agentState={agentState}
              toolRunning={toolRunning}
              toolCompleted={toolCompleted}
              historyLoading={historyLoading}
            />
          )}
        </MainArea>
      </div>
      <InputBar
        onSend={handleResult}
        agentState={agentState}
        voiceSlot={<VoiceInput onResult={handleResult} onConversationChange={device.setActive} ttsPlaying={device.ttsPlaying} />}
      />
      <SettingsModal open={device.settingsOpen} onClose={() => device.setSettingsOpen(false)} />
    </div>
  )
}

export default App
