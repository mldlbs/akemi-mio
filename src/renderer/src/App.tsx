import { VoiceInput } from './components/VoiceInput'
import { WritingInspirationCapture } from './components/WritingInspirationCapture'
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
import { SystemDock } from './components/SystemDock'
import { WallpaperOverlay } from './components/WallpaperOverlay'
import { useSlots } from './slots/SlotContext'
import { useSessions, useAIOutput, useTools, useDeviceStatus, usePlans, useWorkflowDefinitions } from './hooks'
import { useSessionStore } from './store/sessionStore'
import type { MessageItem } from './slots/types'

export type { MessageItem } from './slots/types'

function App() {
  // 初始化 IPC 监听器（hooks 内部负责注册事件并写入 store）
  useSessions()
  const { activeSessionId } = useSessionStore()
  const device = useDeviceStatus()
  const { handleResult } = useAIOutput(activeSessionId, device.active, device.setError)
  useTools()
  usePlans()
  useWorkflowDefinitions()
  const { uiState } = useSlots()

  return (
    <div className="app-shell">
      <TopBar onOpenSettings={() => device.setSettingsOpen(true)} />
      <div className="app-body">
        <Sidebar />
        <MainArea>
          {uiState.activeSlot === 'tool' ? (
            <ToolSlot />
          ) : uiState.activeSlot === 'otpar' ? (
            <ErrorBoundary>
              <OtparSlot />
            </ErrorBoundary>
          ) : uiState.activeSlot === 'devplan' ? (
            <ErrorBoundary>
              <DevPlanSlot />
            </ErrorBoundary>
          ) : uiState.activeSlot === 'workflow' ? (
            <ErrorBoundary>
              <WorkflowSlot />
            </ErrorBoundary>
          ) : uiState.activeSlot === 'preview' ? (
            <PreviewSlot />
          ) : (
            <ChatSlot />
          )}
        </MainArea>
      </div>
      <InputBar
        onSend={handleResult}
        voiceSlot={
          <div className="inputbar-voice-group">
            <VoiceInput onResult={handleResult} />
            <WritingInspirationCapture onSendInspiration={handleResult} />
          </div>
        }
      />
      <SettingsModal />
      <SystemDock />
      <WallpaperOverlay />
    </div>
  )
}

export default App
