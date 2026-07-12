import { VoiceInput } from './components/VoiceInput'
import { WritingInspirationCapture } from './components/WritingInspirationCapture'
import { TopBar } from './components/TopBar'
import { Sidebar } from './components/Sidebar'
import { MainArea } from './components/MainArea'
import { InputBar } from './components/InputBar'
import { ChatSlot } from './components/ChatSlot'
import { HistoryView } from './components/HistoryView'
import { ToolSlot } from './components/ToolSlot'
import { PreviewSlot } from './components/PreviewSlot'
import { WorkflowSlot } from './components/WorkflowSlot'
import { DevPlanSlot } from './components/DevPlanSlot'
import { OtparSlot } from './components/OtparSlot'
import { ErrorBoundary } from './components/ErrorBoundary'
import { SettingsModal } from './components/SettingsModal'
import { SystemDock } from './components/SystemDock'
import { RightPanel } from './components/RightPanel'
import { WallpaperOverlay } from './components/WallpaperOverlay'
import { useSlots } from './slots/SlotContext'
import { useSessions, useAIOutput, useTools, useDeviceStatus, usePlans, useWorkflowDefinitions } from './hooks'
import { useSessionStore } from './store/sessionStore'
import { useHistoryViewStore } from './store/historyViewStore'
import type { MessageItem } from './slots/types'

export type { MessageItem } from './slots/types'

// ── 启动性能诊断 ──
const PERF_MARKS: Record<string, number> = {}
function mark(name: string) {
  PERF_MARKS[name] = performance.now()
}
function dumpMarks(label: string) {
  const entries = Object.entries(PERF_MARKS)
  if (entries.length < 2) return
  entries.sort((a, b) => a[1] - b[1])
  const base = entries[0][1]
  const lines = entries.map(([n, t]) => `  ${n}: +${(t - base).toFixed(1)}ms`).join('\n')
  console.log(`[PERF] ${label}\n${lines}`)
}

function AppInner() {
  useSessions()
  const { activeSessionId } = useSessionStore()
  const device = useDeviceStatus()
  const { handleResult } = useAIOutput(activeSessionId, device.active, device.setError)
  useTools()
  usePlans()
  useWorkflowDefinitions()
  const { uiState } = useSlots()
  const { viewing } = useHistoryViewStore()

  return (
    <div className="app-shell">
      <TopBar onOpenSettings={() => device.setSettingsOpen(true)} />
      <div className="app-body">
        <Sidebar />
        <MainArea>
          {viewing ? (
            <HistoryView />
          ) : uiState.activeSlot === 'tool' ? (
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
        <RightPanel />
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

function App() {
  if (!window.electronAPI) {
    return (
      <div className="app-shell" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <div style={{ textAlign: 'center', color: '#888' }}>
          <h2>Akemi Mio</h2>
          <p style={{ marginTop: 8, fontSize: 13 }}>等待 Electron 连接…</p>
        </div>
      </div>
    )
  }
  return <AppInner />
}

export default App
