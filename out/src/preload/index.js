import { contextBridge, ipcRenderer } from 'electron';
const electronAPI = {
    closeWindow: () => ipcRenderer.invoke('window:close'),
    transcribe: (audio) => ipcRenderer.invoke('asr:transcribe', audio),
    chat: (text, requestId, sessionId, noTts) => ipcRenderer.invoke('ai:chat', text, requestId, sessionId, noTts),
    speak: (text) => ipcRenderer.invoke('tts:speak', text),
    stopSpeaking: () => ipcRenderer.invoke('tts:stop'),
    stopConversation: () => ipcRenderer.invoke('conversation:stop'),
    getState: () => ipcRenderer.invoke('state:get'),
    getWakeWords: () => ipcRenderer.invoke('config:getWakeWords'),
    onStateUpdate: (callback) => {
        const handler = (_event, state) => callback(state);
        ipcRenderer.on('state:update', handler);
        return () => {
            ipcRenderer.removeListener('state:update', handler);
        };
    },
    onAIChunk: (callback) => {
        const handler = (_event, text) => callback(text);
        ipcRenderer.on('ai:chunk', handler);
        return () => {
            ipcRenderer.removeListener('ai:chunk', handler);
        };
    },
    onTTSAudio: (callback) => {
        const handler = (_event, filePath) => callback(filePath);
        ipcRenderer.on('tts:play_audio', handler);
        return () => {
            ipcRenderer.removeListener('tts:play_audio', handler);
        };
    },
    onTTSBuffer: (callback) => {
        const handler = (_event, buf) => callback(buf.buffer);
        ipcRenderer.on('tts:play_audio_buffer', handler);
        return () => {
            ipcRenderer.removeListener('tts:play_audio_buffer', handler);
        };
    },
    onToolStatus: (callback) => {
        const handler = (_event, status) => callback(status);
        ipcRenderer.on('tool:status', handler);
        return () => {
            ipcRenderer.removeListener('tool:status', handler);
        };
    },
    getCredential: (key) => ipcRenderer.invoke('credentials:get', key),
    setCredential: (key, value) => ipcRenderer.invoke('credentials:set', key, value),
    deleteCredential: (key) => ipcRenderer.invoke('credentials:delete', key),
    getMessageHistory: (limit) => ipcRenderer.invoke('messages:getHistory', limit),
    getSessions: () => ipcRenderer.invoke('messages:getSessions'),
    getMessagesBySession: (sessionId) => ipcRenderer.invoke('messages:getBySession', sessionId),
    onMessageNew: (callback) => {
        const handler = (_event, msg) => callback(msg);
        ipcRenderer.on('message:new', handler);
        return () => {
            ipcRenderer.removeListener('message:new', handler);
        };
    },
    // Auto-update
    checkUpdate: () => ipcRenderer.invoke('update:check'),
    downloadUpdate: () => ipcRenderer.invoke('update:download'),
    installUpdate: () => ipcRenderer.invoke('update:install'),
    onUpdateStatus: (callback) => {
        const handler = (_event, status) => callback(status);
        ipcRenderer.on('update:status', handler);
        return () => {
            ipcRenderer.removeListener('update:status', handler);
        };
    },
    // ── Coding Agent UI ──
    // 工具调用事件（ChatExecutor 实际发出含 id/latencyMs 的 payload）
    onToolInvoked: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('agent:tool_invoked', handler);
        return () => ipcRenderer.removeListener('agent:tool_invoked', handler);
    },
    onToolCompleted: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('agent:tool_completed', handler);
        return () => ipcRenderer.removeListener('agent:tool_completed', handler);
    },
    onToolFailed: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('agent:tool_failed', handler);
        return () => ipcRenderer.removeListener('agent:tool_failed', handler);
    },
    // 计划事件
    onPlanCreated: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('agent:plan_created', handler);
        return () => ipcRenderer.removeListener('agent:plan_created', handler);
    },
    onPlanStep: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('agent:plan_step', handler);
        return () => ipcRenderer.removeListener('agent:plan_step', handler);
    },
    onPlanCompleted: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('agent:plan_completed', handler);
        return () => ipcRenderer.removeListener('agent:plan_completed', handler);
    },
    // OTPAR 阶段事件
    onAgentObserve: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('agent:observe', handler);
        return () => ipcRenderer.removeListener('agent:observe', handler);
    },
    onAgentThink: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('agent:think', handler);
        return () => ipcRenderer.removeListener('agent:think', handler);
    },
    onAgentReflect: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('agent:reflect', handler);
        return () => ipcRenderer.removeListener('agent:reflect', handler);
    },
    // 输入输出
    onInputReceived: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('agent:input_received', handler);
        return () => ipcRenderer.removeListener('agent:input_received', handler);
    },
    onResponseGenerated: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('agent:response_generated', handler);
        return () => ipcRenderer.removeListener('agent:response_generated', handler);
    },
    // Guardrail & 错误
    onGuardrail: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('agent:guardrail', handler);
        return () => ipcRenderer.removeListener('agent:guardrail', handler);
    },
    onBudgetExhausted: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('agent:budgetExhausted', handler);
        return () => ipcRenderer.removeListener('agent:budgetExhausted', handler);
    },
    onBudgetRestored: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('agent:budgetRestored', handler);
        return () => ipcRenderer.removeListener('agent:budgetRestored', handler);
    },
    onAgentError: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('agent:error', handler);
        return () => ipcRenderer.removeListener('agent:error', handler);
    },
    // 工作流运行事件
    onWorkflowRunCreated: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('workflow:run_created', handler);
        return () => ipcRenderer.removeListener('workflow:run_created', handler);
    },
    onWorkflowRunUpdated: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('workflow:run_updated', handler);
        return () => ipcRenderer.removeListener('workflow:run_updated', handler);
    },
    onWorkflowRunStep: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('workflow:run_step', handler);
        return () => ipcRenderer.removeListener('workflow:run_step', handler);
    },
    // Invoke handlers
    getActivePlan: () => ipcRenderer.invoke('agent:getActivePlan'),
    listPlans: () => ipcRenderer.invoke('agent:listPlans'),
    openAgentWindow: () => ipcRenderer.invoke('agent:openWindow'),
    closeAgentWindow: () => ipcRenderer.invoke('agent:closeWindow'),
    // 人格切换事件
    onPersonaUpdated: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('persona:updated', handler);
        return () => ipcRenderer.removeListener('persona:updated', handler);
    },
    // ── Workflow System ──
    listWorkflowDefinitions: () => ipcRenderer.invoke('workflow:listDefinitions'),
    getWorkflowDefinition: (id) => ipcRenderer.invoke('workflow:getDefinition', id),
    listWorkflowRuns: (limit) => ipcRenderer.invoke('workflow:listRuns', limit),
    getWorkflowRun: (runId) => ipcRenderer.invoke('workflow:getRun', runId),
    deleteWorkflowDefinition: (id) => ipcRenderer.invoke('workflow:deleteDefinition', id),
    saveWorkflowDefinition: (def) => ipcRenderer.invoke('workflow:saveDefinition', def),
    startWorkflow: (id) => ipcRenderer.invoke('workflow:startWorkflow', id),
    // ── Writing Status ──
    getWritingStatus: () => ipcRenderer.invoke('writing:getStatus'),
};
contextBridge.exposeInMainWorld('electronAPI', electronAPI);
