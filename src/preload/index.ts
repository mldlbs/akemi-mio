import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRenderer } from 'electron'

export function createElectronAPI(ipc: IpcRenderer) {
  return {
    closeWindow: (): Promise<{ success: boolean }> => ipc.invoke('window:close'),
    minimizeWindow: (): Promise<{ success: boolean }> => ipc.invoke('window:minimize'),

    transcribe: (audio: ArrayBuffer): Promise<{ text: string; request_id?: string; error?: string }> => ipc.invoke('asr:transcribe', audio),

    // ── 语音工具编排 ──
    matchVoiceIntent: (text: string): Promise<{
      matched: boolean
      intent?: {
        name: string
        description: string
        confirmMessage: string
        toolSequence: Array<{ tool: string; args: Record<string, string> }>
        slots: Record<string, string>
      }
      fallbackText?: string
      error?: string
    }> => ipc.invoke('voice:matchIntent', text),

    executeVoiceChain: (
      intent: string,
      slots: Record<string, string>,
    ): Promise<{
      success: boolean
      steps: Array<{ tool: string; success: boolean; output: string; error?: string; durationMs: number }>
      summary: string
    }> => ipc.invoke('voice:executeChain', intent, slots),

    chat: (text: string, requestId?: string, sessionId?: string, noTts?: boolean): Promise<{ reply?: string; error?: string }> =>
      ipc.invoke('ai:chat', text, requestId, sessionId, noTts),

    speak: (text: string): Promise<void> => ipc.invoke('tts:speak', text),

    stopSpeaking: (): Promise<void> => ipc.invoke('tts:stop'),

    // ── 情感自适应语音 ──
    toggleEmotionTts: (enabled: boolean): Promise<{ success: boolean; enabled: boolean }> =>
      ipc.invoke('tts:emotion:toggle', enabled),

    getEmotionTtsState: (): Promise<{ success: boolean; enabled: boolean; params: Record<string, unknown> | null }> =>
      ipc.invoke('tts:emotion:state'),

    onTtsEmotion: (
      callback: (data: {
        polarity: string
        contentType: string
        score: number
        voice: string
        label: string
        matchedWords: string[]
      }) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: { polarity: string; contentType: string; score: number; voice: string; label: string; matchedWords: string[] },
      ) => callback(data)
      ipc.on('tts:emotion', handler)
      return () => {
        ipc.removeListener('tts:emotion', handler)
      }
    },

    onTtsEmotionEnabled: (callback: (data: { enabled: boolean }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { enabled: boolean }) => callback(data)
      ipc.on('tts:emotion:enabled', handler)
      return () => {
        ipc.removeListener('tts:emotion:enabled', handler)
      }
    },

    stopConversation: (): Promise<{ success: boolean }> => ipc.invoke('conversation:stop'),

    getState: (): Promise<{ asr: string; error?: string }> => ipc.invoke('state:get'),

    getWakeWords: (): Promise<string[]> => ipc.invoke('config:getWakeWords'),

    onStateUpdate: (callback: (state: Record<string, unknown>) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: Record<string, unknown>) => callback(state)
      ipc.on('state:update', handler)
      return () => {
        ipc.removeListener('state:update', handler)
      }
    },

    onAIChunk: (callback: (text: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, text: string) => callback(text)
      ipc.on('ai:chunk', handler)
      return () => {
        ipc.removeListener('ai:chunk', handler)
      }
    },

    onTTSAudio: (callback: (filePath: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, filePath: string) => callback(filePath)
      ipc.on('tts:play_audio', handler)
      return () => {
        ipc.removeListener('tts:play_audio', handler)
      }
    },

    onTTSBuffer: (callback: (buffer: ArrayBuffer) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, buf: Uint8Array) => callback(buf.buffer as ArrayBuffer)
      ipc.on('tts:play_audio_buffer', handler)
      return () => {
        ipc.removeListener('tts:play_audio_buffer', handler)
      }
    },

    onToolStatus: (callback: (status: { type: string; tool: string; message: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: { type: string; tool: string; message: string }) => callback(status)
      ipc.on('tool:status', handler)
      return () => {
        ipc.removeListener('tool:status', handler)
      }
    },

    getCredential: (key: string): Promise<string | null> => ipc.invoke('credentials:get', key),

    setCredential: (key: string, value: string): Promise<true> => ipc.invoke('credentials:set', key, value),

    deleteCredential: (key: string): Promise<true> => ipc.invoke('credentials:delete', key),

    getMessageHistory: (
      limit?: number,
    ): Promise<{ id: string; source: string; role: string; content: string; category: string; sessionId?: string; createdAt: number }[]> =>
      ipc.invoke('messages:getHistory', limit),

    getSessions: (): Promise<
      { id: string; source: string; category: string; label: string; messageCount: number; lastActivityAt: number; createdAt: number }[]
    > => ipc.invoke('messages:getSessions'),

    getMessagesBySession: (
      sessionId: string,
    ): Promise<{ id: string; source: string; role: string; content: string; category: string; sessionId?: string; createdAt: number }[]> =>
      ipc.invoke('messages:getBySession', sessionId),

    onMessageNew: (
      callback: (msg: {
        id: string
        source: string
        role: string
        content: string
        category: string
        sessionId?: string
        createdAt: number
      }) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        msg: { id: string; source: string; role: string; content: string; category: string; sessionId?: string; createdAt: number },
      ) => callback(msg)
      ipc.on('message:new', handler)
      return () => {
        ipc.removeListener('message:new', handler)
      }
    },

    checkUpdate: (): Promise<{ available: boolean; version?: string; error?: string }> => ipc.invoke('update:check'),

    downloadUpdate: (): Promise<{ success: boolean; error?: string }> => ipc.invoke('update:download'),

    installUpdate: (): Promise<{ success: boolean }> => ipc.invoke('update:install'),

    onUpdateStatus: (callback: (status: Record<string, unknown>) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: Record<string, unknown>) => callback(status)
      ipc.on('update:status', handler)
      return () => {
        ipc.removeListener('update:status', handler)
      }
    },

    // ── Coding Agent UI ──

    onToolInvoked: (callback: (data: { tool: string; args: Record<string, any>; id: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipc.on('agent:tool_invoked', handler)
      return () => ipc.removeListener('agent:tool_invoked', handler)
    },

    onToolCompleted: (callback: (data: { tool: string; result: string; id: string; latencyMs: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipc.on('agent:tool_completed', handler)
      return () => ipc.removeListener('agent:tool_completed', handler)
    },

    onToolFailed: (callback: (data: { tool: string; error: string; id: string; latencyMs: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipc.on('agent:tool_failed', handler)
      return () => ipc.removeListener('agent:tool_failed', handler)
    },

    onPlanCreated: (callback: (data: { planId: string; title: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipc.on('agent:plan_created', handler)
      return () => ipc.removeListener('agent:plan_created', handler)
    },

    onPlanStep: (callback: (data: { planId: string; stepIndex: number; status: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipc.on('agent:plan_step', handler)
      return () => ipc.removeListener('agent:plan_step', handler)
    },

    onPlanCompleted: (callback: (data: { planId: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipc.on('agent:plan_completed', handler)
      return () => ipc.removeListener('agent:plan_completed', handler)
    },

    onAgentObserve: (
      callback: (data: { requestId: string; step: number; proceduresFound: number; patternsFound: number; durationMs: number }) => void,
    ) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipc.on('agent:observe', handler)
      return () => ipc.removeListener('agent:observe', handler)
    },

    onAgentThink: (callback: (data: { requestId: string; step: number; toolCallCount: number; strategyPrompted: boolean }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipc.on('agent:think', handler)
      return () => ipc.removeListener('agent:think', handler)
    },

    onAgentReflect: (
      callback: (data: {
        requestId: string
        step: number
        toolResults: number
        successCount: number
        summary: string
        durationMs: number
      }) => void,
    ) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipc.on('agent:reflect', handler)
      return () => ipc.removeListener('agent:reflect', handler)
    },

    onInputReceived: (callback: (data: { text: string; requestId: string; source: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipc.on('agent:input_received', handler)
      return () => ipc.removeListener('agent:input_received', handler)
    },

    onResponseGenerated: (callback: (data: { text: string; requestId: string; source: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipc.on('agent:response_generated', handler)
      return () => ipc.removeListener('agent:response_generated', handler)
    },

    onGuardrail: (callback: (data: { type: string } & Record<string, any>) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipc.on('agent:guardrail', handler)
      return () => ipc.removeListener('agent:guardrail', handler)
    },

    onBudgetExhausted: (callback: (data: { resource: string; utilization: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipc.on('agent:budgetExhausted', handler)
      return () => ipc.removeListener('agent:budgetExhausted', handler)
    },

    onBudgetRestored: (callback: (data: { resource: string; utilization: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipc.on('agent:budgetRestored', handler)
      return () => ipc.removeListener('agent:budgetRestored', handler)
    },

    onAgentError: (callback: (data: { error: string; requestId: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipc.on('agent:error', handler)
      return () => ipc.removeListener('agent:error', handler)
    },

    onWorkflowRunCreated: (callback: (data: { runId: string; workflowDefId: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipc.on('workflow:run_created', handler)
      return () => ipc.removeListener('workflow:run_created', handler)
    },

    onWorkflowRunUpdated: (callback: (data: { runId: string; status: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipc.on('workflow:run_updated', handler)
      return () => ipc.removeListener('workflow:run_updated', handler)
    },

    onWorkflowRunStep: (callback: (data: { runId: string; stepId: string; status: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipc.on('workflow:run_step', handler)
      return () => ipc.removeListener('workflow:run_step', handler)
    },

    onWorkflowDefCreated: (callback: (data: { workflowDefId: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipc.on('workflow:def_created', handler)
      return () => ipc.removeListener('workflow:def_created', handler)
    },

    getActivePlan: (): Promise<{
      id: string
      title: string
      description: string
      steps: { id: string; description: string; status: string; result?: string }[]
      status: string
      createdAt: number
      updatedAt: number
    } | null> => ipc.invoke('agent:getActivePlan'),

    listPlans: (): Promise<
      {
        id: string
        title: string
        description: string
        steps: { id: string; description: string; status: string; result?: string }[]
        status: string
        createdAt: number
        updatedAt: number
      }[]
    > => ipc.invoke('agent:listPlans'),

    openAgentWindow: (): Promise<{ success: boolean; error?: string }> => ipc.invoke('agent:openWindow'),

    closeAgentWindow: (): Promise<{ success: boolean }> => ipc.invoke('agent:closeWindow'),

    onPersonaUpdated: (callback: (data: { level: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { level: string }) => callback(data)
      ipc.on('persona:updated', handler)
      return () => {
        ipc.removeListener('persona:updated', handler)
      }
    },

    // ── Workflow System ──
    listWorkflowDefinitions: (): Promise<any[]> => ipc.invoke('workflow:listDefinitions'),
    getWorkflowDefinition: (id: string): Promise<any> => ipc.invoke('workflow:getDefinition', id),
    listWorkflowRuns: (limit?: number): Promise<any[]> => ipc.invoke('workflow:listRuns', limit),
    getWorkflowRun: (runId: string): Promise<any> => ipc.invoke('workflow:getRun', runId),
    deleteWorkflowDefinition: (id: string): Promise<{ success: boolean }> => ipc.invoke('workflow:deleteDefinition', id),
    saveWorkflowDefinition: (def: any): Promise<{ success: boolean }> => ipc.invoke('workflow:saveDefinition', def),
    startWorkflow: (id: string): Promise<{ success: boolean; runId?: string; error?: string }> => ipc.invoke('workflow:startWorkflow', id),
    enableWorkflowDefinition: (id: string): Promise<{ success: boolean; error?: string }> => ipc.invoke('workflow:enableDefinition', id),
    disableWorkflowDefinition: (id: string): Promise<{ success: boolean; error?: string }> => ipc.invoke('workflow:disableDefinition', id),
    stopWorkflowRun: (runId: string): Promise<{ success: boolean; error?: string }> => ipc.invoke('workflow:stopRun', runId),
    duplicateWorkflowDefinition: (id: string): Promise<{ success: boolean; error?: string }> =>
      ipc.invoke('workflow:duplicateDefinition', id),
    deleteWorkflowRun: (runId: string): Promise<{ success: boolean; error?: string }> => ipc.invoke('workflow:deleteRun', runId),
    approveGate: (runId: string, stepId: string, decision: string, modifiedInput?: string): Promise<{ success: boolean; error?: string }> =>
      ipc.invoke('workflow:approveGate', runId, stepId, decision, modifiedInput),

    // ── Writing Status ──
    getWritingStatus: (): Promise<{ stories: any[]; totalStories: number; totalScenes: number }> => ipc.invoke('writing:getStatus'),

    // ── Evolution ──
    evolutionStatus: (): Promise<{ lastRun: number | null; consecutiveFailures: number; isBusy: boolean }> =>
      ipc.invoke('evolution:status'),
    evolutionTrigger: (): Promise<{ success: boolean; error?: string }> => ipc.invoke('evolution:trigger'),
  }
}

const electronAPI = createElectronAPI(ipcRenderer)
contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = ReturnType<typeof createElectronAPI>
