import { VoiceInput } from './components/VoiceInput'
import { TopBar } from './components/TopBar'
import { Sidebar } from './components/Sidebar'
import { MainArea } from './components/MainArea'
import { InputBar } from './components/InputBar'
import { ChatSlot } from './components/ChatSlot'
import { ToolSlot } from './components/ToolSlot'
import { PreviewSlot } from './components/PreviewSlot'
import { SettingsModal } from './components/SettingsModal'
import { useSlots } from './slots/SlotContext'
import { useSessions, useAIOutput, useTools, useDeviceStatus } from './hooks'

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
        agentSlot={
          <button className="cap-toggle-btn" onClick={() => window.electronAPI.openAgentWindow()} title="Agent 面板">
            <i className="ri-robot-2-line" />
          </button>
        }
      />
      <div className="app-body">
        <Sidebar sessions={sessions} activeSessionId={activeSessionId} onSelectChat={handleSelectChat} />
        <MainArea>
          {/* ChatSlot 始终渲染；用户主动切换到 tool/preview 时显示替换层 */}
          {uiState.activeSlot === 'tool' ? (
            <ToolSlot running={toolRunning} completed={toolCompleted} />
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
