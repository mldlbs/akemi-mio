import { contextBridge, ipcRenderer } from 'electron'

const electronAPI = {
  closeWindow: (): Promise<{ success: boolean }> => ipcRenderer.invoke('window:close'),
  minimizeWindow: (): Promise<{ success: boolean }> => ipcRenderer.invoke('window:minimize'),

  transcribe: (audio: ArrayBuffer): Promise<{ text: string; request_id?: string; error?: string }> =>
    ipcRenderer.invoke('asr:transcribe', audio),

  chat: (text: string, requestId?: string, sessionId?: string, noTts?: boolean): Promise<{ reply?: string; error?: string }> =>
    ipcRenderer.invoke('ai:chat', text, requestId, sessionId, noTts),

  speak: (text: string): Promise<void> => ipcRenderer.invoke('tts:speak', text),

  stopSpeaking: (): Promise<void> => ipcRenderer.invoke('tts:stop'),

  stopConversation: (): Promise<{ success: boolean }> => ipcRenderer.invoke('conversation:stop'),

  getState: (): Promise<{ asr: string; error?: string }> => ipcRenderer.invoke('state:get'),

  getWakeWords: (): Promise<string[]> => ipcRenderer.invoke('config:getWakeWords'),

  onStateUpdate: (callback: (state: Record<string, unknown>) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: Record<string, unknown>) => callback(state)
    ipcRenderer.on('state:update', handler)
    return () => {
      ipcRenderer.removeListener('state:update', handler)
    }
  },

  onAIChunk: (callback: (text: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, text: string) => callback(text)
    ipcRenderer.on('ai:chunk', handler)
    return () => {
      ipcRenderer.removeListener('ai:chunk', handler)
    }
  },

  onTTSAudio: (callback: (filePath: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, filePath: string) => callback(filePath)
    ipcRenderer.on('tts:play_audio', handler)
    return () => {
      ipcRenderer.removeListener('tts:play_audio', handler)
    }
  },

  onTTSBuffer: (callback: (buffer: ArrayBuffer) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, buf: Uint8Array) => callback(buf.buffer as ArrayBuffer)
    ipcRenderer.on('tts:play_audio_buffer', handler)
    return () => {
      ipcRenderer.removeListener('tts:play_audio_buffer', handler)
    }
  },

  onToolStatus: (callback: (status: { type: string; tool: string; message: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: { type: string; tool: string; message: string }) => callback(status)
    ipcRenderer.on('tool:status', handler)
    return () => {
      ipcRenderer.removeListener('tool:status', handler)
    }
  },

  getCredential: (key: string): Promise<string | null> => ipcRenderer.invoke('credentials:get', key),

  setCredential: (key: string, value: string): Promise<true> => ipcRenderer.invoke('credentials:set', key, value),

  deleteCredential: (key: string): Promise<true> => ipcRenderer.invoke('credentials:delete', key),

  getMessageHistory: (
    limit?: number,
  ): Promise<{ id: string; source: string; role: string; content: string; category: string; sessionId?: string; createdAt: number }[]> =>
    ipcRenderer.invoke('messages:getHistory', limit),

  getSessions: (): Promise<
    { id: string; source: string; category: string; label: string; messageCount: number; lastActivityAt: number; createdAt: number }[]
  > => ipcRenderer.invoke('messages:getSessions'),

  getMessagesBySession: (
    sessionId: string,
  ): Promise<{ id: string; source: string; role: string; content: string; category: string; sessionId?: string; createdAt: number }[]> =>
    ipcRenderer.invoke('messages:getBySession', sessionId),

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
    ipcRenderer.on('message:new', handler)
    return () => {
      ipcRenderer.removeListener('message:new', handler)
    }
  },

  // Auto-update
  checkUpdate: (): Promise<{ available: boolean; version?: string; error?: string }> => ipcRenderer.invoke('update:check'),

  downloadUpdate: (): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('update:download'),

  installUpdate: (): Promise<{ success: boolean }> => ipcRenderer.invoke('update:install'),

  onUpdateStatus: (callback: (status: Record<string, unknown>) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: Record<string, unknown>) => callback(status)
    ipcRenderer.on('update:status', handler)
    return () => {
      ipcRenderer.removeListener('update:status', handler)
    }
  },

  // ── Coding Agent UI ──

  // 工具调用事件（ChatExecutor 实际发出含 id/latencyMs 的 payload）
  onToolInvoked: (callback: (data: { tool: string; args: Record<string, any>; id: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('agent:tool_invoked', handler)
    return () => ipcRenderer.removeListener('agent:tool_invoked', handler)
  },

  onToolCompleted: (callback: (data: { tool: string; result: string; id: string; latencyMs: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('agent:tool_completed', handler)
    return () => ipcRenderer.removeListener('agent:tool_completed', handler)
  },

  onToolFailed: (callback: (data: { tool: string; error: string; id: string; latencyMs: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('agent:tool_failed', handler)
    return () => ipcRenderer.removeListener('agent:tool_failed', handler)
  },

  // 计划事件
  onPlanCreated: (callback: (data: { planId: string; title: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('agent:plan_created', handler)
    return () => ipcRenderer.removeListener('agent:plan_created', handler)
  },

  onPlanStep: (callback: (data: { planId: string; stepIndex: number; status: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('agent:plan_step', handler)
    return () => ipcRenderer.removeListener('agent:plan_step', handler)
  },

  onPlanCompleted: (callback: (data: { planId: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('agent:plan_completed', handler)
    return () => ipcRenderer.removeListener('agent:plan_completed', handler)
  },

  // OTPAR 阶段事件
  onAgentObserve: (
    callback: (data: { requestId: string; step: number; proceduresFound: number; patternsFound: number; durationMs: number }) => void,
  ) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('agent:observe', handler)
    return () => ipcRenderer.removeListener('agent:observe', handler)
  },

  onAgentThink: (callback: (data: { requestId: string; step: number; toolCallCount: number; strategyPrompted: boolean }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('agent:think', handler)
    return () => ipcRenderer.removeListener('agent:think', handler)
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
    ipcRenderer.on('agent:reflect', handler)
    return () => ipcRenderer.removeListener('agent:reflect', handler)
  },

  // 输入输出
  onInputReceived: (callback: (data: { text: string; requestId: string; source: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('agent:input_received', handler)
    return () => ipcRenderer.removeListener('agent:input_received', handler)
  },

  onResponseGenerated: (callback: (data: { text: string; requestId: string; source: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('agent:response_generated', handler)
    return () => ipcRenderer.removeListener('agent:response_generated', handler)
  },

  // Guardrail & 错误
  onGuardrail: (callback: (data: { type: string } & Record<string, any>) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('agent:guardrail', handler)
    return () => ipcRenderer.removeListener('agent:guardrail', handler)
  },

  onBudgetExhausted: (callback: (data: { resource: string; utilization: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('agent:budgetExhausted', handler)
    return () => ipcRenderer.removeListener('agent:budgetExhausted', handler)
  },

  onBudgetRestored: (callback: (data: { resource: string; utilization: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('agent:budgetRestored', handler)
    return () => ipcRenderer.removeListener('agent:budgetRestored', handler)
  },

  onAgentError: (callback: (data: { error: string; requestId: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('agent:error', handler)
    return () => ipcRenderer.removeListener('agent:error', handler)
  },

  // 工作流运行事件
  onWorkflowRunCreated: (callback: (data: { runId: string; workflowDefId: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('workflow:run_created', handler)
    return () => ipcRenderer.removeListener('workflow:run_created', handler)
  },

  onWorkflowRunUpdated: (callback: (data: { runId: string; status: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('workflow:run_updated', handler)
    return () => ipcRenderer.removeListener('workflow:run_updated', handler)
  },

  onWorkflowRunStep: (callback: (data: { runId: string; stepId: string; status: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('workflow:run_step', handler)
    return () => ipcRenderer.removeListener('workflow:run_step', handler)
  },

  // 工作流定义变更 → UI 刷新
  onWorkflowDefCreated: (callback: (data: { workflowDefId: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('workflow:def_created', handler)
    return () => ipcRenderer.removeListener('workflow:def_created', handler)
  },

  // Invoke handlers
  getActivePlan: (): Promise<{
    id: string
    title: string
    description: string
    steps: { id: string; description: string; status: string; result?: string }[]
    status: string
    createdAt: number
    updatedAt: number
  } | null> => ipcRenderer.invoke('agent:getActivePlan'),

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
  > => ipcRenderer.invoke('agent:listPlans'),

  openAgentWindow: (): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('agent:openWindow'),

  closeAgentWindow: (): Promise<{ success: boolean }> => ipcRenderer.invoke('agent:closeWindow'),

  // 人格切换事件
  onPersonaUpdated: (callback: (data: { level: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { level: string }) => callback(data)
    ipcRenderer.on('persona:updated', handler)
    return () => ipcRenderer.removeListener('persona:updated', handler)
  },

  // ── Workflow System ──
  listWorkflowDefinitions: (): Promise<any[]> => ipcRenderer.invoke('workflow:listDefinitions'),
  getWorkflowDefinition: (id: string): Promise<any> => ipcRenderer.invoke('workflow:getDefinition', id),
  listWorkflowRuns: (limit?: number): Promise<any[]> => ipcRenderer.invoke('workflow:listRuns', limit),
  getWorkflowRun: (runId: string): Promise<any> => ipcRenderer.invoke('workflow:getRun', runId),
  deleteWorkflowDefinition: (id: string): Promise<{ success: boolean }> => ipcRenderer.invoke('workflow:deleteDefinition', id),
  saveWorkflowDefinition: (def: any): Promise<{ success: boolean }> => ipcRenderer.invoke('workflow:saveDefinition', def),
  startWorkflow: (id: string): Promise<{ success: boolean; runId?: string; error?: string }> =>
    ipcRenderer.invoke('workflow:startWorkflow', id),
  enableWorkflowDefinition: (id: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('workflow:enableDefinition', id),
  disableWorkflowDefinition: (id: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('workflow:disableDefinition', id),
  stopWorkflowRun: (runId: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('workflow:stopRun', runId),
  duplicateWorkflowDefinition: (id: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('workflow:duplicateDefinition', id),
  deleteWorkflowRun: (runId: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('workflow:deleteRun', runId),

  // ── Writing Status ──
  getWritingStatus: (): Promise<{ stories: any[]; totalStories: number; totalScenes: number }> => ipcRenderer.invoke('writing:getStatus'),

  // ── Evolution ──
  evolutionStatus: (): Promise<{ lastRun: number | null; consecutiveFailures: number; isBusy: boolean }> =>
    ipcRenderer.invoke('evolution:status'),
  evolutionTrigger: (): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('evolution:trigger'),
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = typeof electronAPI
