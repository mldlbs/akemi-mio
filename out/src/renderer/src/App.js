import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { VoiceInput } from './components/VoiceInput';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { MainArea } from './components/MainArea';
import { InputBar } from './components/InputBar';
import { ChatSlot } from './components/ChatSlot';
import { ToolSlot } from './components/ToolSlot';
import { PreviewSlot } from './components/PreviewSlot';
import { WorkflowSlot } from './components/WorkflowSlot';
import { SettingsModal } from './components/SettingsModal';
import { useSlots } from './slots/SlotContext';
import { useSessions, useAIOutput, useTools, useDeviceStatus, usePlans, useWorkflowDefinitions } from './hooks';
function App() {
    const { sessions, activeSessionId, historyMessages, historyLoading, handleSelectChat } = useSessions();
    const device = useDeviceStatus();
    const { pendingText, displayText, transcribed, toolStatus, agentState, handleResult } = useAIOutput(activeSessionId, device.active, device.setError);
    const { uiState } = useSlots();
    const { toolRunning, toolCompleted } = useTools();
    const { activePlan, otparStages } = usePlans();
    const { definitions: workflowDefs, runs: workflowRuns, activeRuns: workflowActiveRuns, loading: wfLoading, refresh: refreshWorkflows, } = useWorkflowDefinitions();
    return (_jsxs("div", { className: "app-shell", children: [_jsx(TopBar, { conversationActive: device.active, ttsPlaying: device.ttsPlaying, error: device.error, sessionHealth: device.sessionHealth, personaLevel: device.personaLevel, onOpenSettings: () => device.setSettingsOpen(true), agentState: agentState, agentSlot: _jsx("button", { className: "cap-toggle-btn", onClick: () => window.electronAPI.openAgentWindow(), title: "Agent \u9762\u677F", children: _jsx("i", { className: "ri-robot-2-line" }) }) }), _jsxs("div", { className: "app-body", children: [_jsx(Sidebar, { sessions: sessions, activeSessionId: activeSessionId, onSelectChat: handleSelectChat }), _jsx(MainArea, { children: uiState.activeSlot === 'tool' ? (_jsx(ToolSlot, { running: toolRunning, completed: toolCompleted })) : uiState.activeSlot === 'workflow' ? (_jsx(WorkflowSlot, { activePlan: activePlan, otparStages: otparStages, workflowDefs: workflowDefs, workflowRuns: workflowRuns, workflowActiveRuns: workflowActiveRuns, wfLoading: wfLoading, onRefreshDefs: refreshWorkflows })) : uiState.activeSlot === 'preview' ? (_jsx(PreviewSlot, {})) : (_jsx(ChatSlot, { messages: historyMessages, pendingText: pendingText, displayText: displayText, transcribed: transcribed, toolStatus: toolStatus, agentState: agentState, toolRunning: toolRunning, toolCompleted: toolCompleted, historyLoading: historyLoading })) })] }), _jsx(InputBar, { onSend: handleResult, agentState: agentState, voiceSlot: _jsx(VoiceInput, { onResult: handleResult, onConversationChange: device.setActive, ttsPlaying: device.ttsPlaying }) }), _jsx(SettingsModal, { open: device.settingsOpen, onClose: () => device.setSettingsOpen(false) })] }));
}
export default App;
