import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRenderer } from 'electron'

export function createElectronAPI(ipc: IpcRenderer) {
  return {
    closeWindow: (): Promise<{ success: boolean }> => ipc.invoke('window:close'),
    minimizeWindow: (): Promise<{ success: boolean }> => ipc.invoke('window:minimize'),
    maximizeWindow: (): Promise<{ success: boolean; isMaximized: boolean }> => ipc.invoke('window:maximize'),
    isMaximized: (): Promise<{ isMaximized: boolean }> => ipc.invoke('window:isMaximized'),
    toggleFullscreen: (): Promise<{ success: boolean; isFullScreen: boolean }> => ipc.invoke('window:fullscreen'),

    transcribe: (audio: ArrayBuffer): Promise<{ text: string; request_id?: string; error?: string }> => ipc.invoke('asr:transcribe', audio),

    // ── ASR 热词管理 ──
    toggleAsrHotwords: (enabled: boolean): Promise<{ enabled: boolean }> => ipc.invoke('asr:toggle-hotwords', enabled),
    getAsrHotwordState: (): Promise<{ enabled: boolean; entryCount: number; hotwords: string[]; totalInputs: number }> =>
      ipc.invoke('asr:hotword-state'),

    // ── ASR 个性化词表管理 ──
    getVocabState: (): Promise<{
      words: Array<{ word: string; count: number; domain: string; lastSeen: number; firstSeen: number }>
      domainStats: Array<{ label: string; count: number }>
      totalWords: number
      enabled: boolean
    }> => ipc.invoke('asr:vocabulary:list'),

    deleteVocabWord: (word: string): Promise<{ success: boolean }> => ipc.invoke('asr:vocabulary:delete', word),

    clearVocabData: (): Promise<{ success: boolean }> => ipc.invoke('asr:vocabulary:clear'),

    refreshVocabContext: (): Promise<{ success: boolean; error?: string }> => ipc.invoke('asr:context:refresh'),

    // ── 语音工具编排 ──
    matchVoiceIntent: (
      text: string,
      useLlmFallback?: boolean,
    ): Promise<{
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
      _source?: string
      _analysis?: string
      _confidence?: number
    }> => ipc.invoke('voice:matchIntent', text, useLlmFallback),

    executeVoiceChain: (
      intent: string,
      slots: Record<string, string>,
    ): Promise<{
      success: boolean
      steps: Array<{ tool: string; success: boolean; output: string; error?: string; durationMs: number }>
      summary: string
    }> => ipc.invoke('voice:executeChain', intent, slots),

    // ── LLM 意图解析（fallback）──
    llmParseIntent: (
      text: string,
    ): Promise<{
      success: boolean
      parsed: {
        intent: string
        description: string
        matched: boolean
        slots: Record<string, string>
        tools: Array<{ tool: string; args: Record<string, string> }>
        confirmMessage: string
        requireConfirmation: boolean
        analysis?: string
        confidence?: number
      } | null
      fallbackText: string
      error?: string
    }> => ipc.invoke('voice:llmParseIntent', text),

    // ── 语音确认会话 ──
    voiceConfirmStart: (params: {
      intentName: string
      confirmMessage: string
      slots: Record<string, string>
      tools: Array<{ tool: string; args: Record<string, string> }>
      timeoutMs?: number
    }): Promise<{ success: boolean; sessionId?: string; state?: string; error?: string }> =>
      ipc.invoke('voice:confirm:start', params),

    voiceConfirmFeed: (text: string): Promise<{
      success: boolean
      state?: string
      result?: string
      slots?: Record<string, string>
      error?: string
    }> => ipc.invoke('voice:confirm:feed', text),

    voiceConfirmState: (): Promise<{
      active: boolean
      state: string
      sessionId: string
      intentName: string
      confirmMessage: string
      slots: Record<string, string>
      elapsedMs: number
    }> => ipc.invoke('voice:confirm:state'),

    voiceConfirmReset: (): Promise<{ success: boolean }> =>
      ipc.invoke('voice:confirm:reset'),

    // ── 一站式语音编排 ──
    orchestratorFull: (
      text: string,
      options?: {
        useLlmFallback?: boolean
        autoTts?: boolean
        requireConfirm?: boolean
        confirmTimeoutMs?: number
      },
    ): Promise<{
      matched: boolean
      awaitingConfirm?: boolean
      intent?: {
        name: string
        description: string
        confirmMessage: string
        toolSequence: Array<{ tool: string; args: Record<string, string> }>
        slots: Record<string, string>
      }
      result?: { success: boolean; steps: Array<any>; summary: string }
      sessionId?: string
      state?: string
      text?: string
      error?: string
    }> => ipc.invoke('voice:orchestrate:full', text, options),

    orchestratorConfirmAndExecute: (
      intentName: string,
      slots: Record<string, string>,
    ): Promise<{ success: boolean; result?: { success: boolean; steps: Array<any>; summary: string }; error?: string }> =>
      ipc.invoke('voice:orchestrate:confirmAndExecute', intentName, slots),

    chat: (text: string, requestId?: string, sessionId?: string, noTts?: boolean): Promise<{ reply?: string; error?: string }> =>
      ipc.invoke('ai:chat', text, requestId, sessionId, noTts),

    speak: (text: string): Promise<void> => ipc.invoke('tts:speak', text),

    stopSpeaking: (): Promise<void> => ipc.invoke('tts:stop'),

    // ── 情感自适应语音 ──
    toggleEmotionTts: (enabled: boolean): Promise<{ success: boolean; enabled: boolean }> => ipc.invoke('tts:emotion:toggle', enabled),

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

    // ── 行为情绪检测 ──
    toggleBehaviorEmotion: (enabled: boolean): Promise<{ success: boolean; enabled: boolean }> =>
      ipc.invoke('tts:behaviorEmotion:toggle', enabled),

    getBehaviorEmotionState: (): Promise<{
      success: boolean
      enabled: boolean
      result: Record<string, unknown> | null
      metrics: Record<string, unknown> | null
    }> => ipc.invoke('tts:behaviorEmotion:state'),

    onBehaviorEmotionEnabled: (callback: (data: { enabled: boolean }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { enabled: boolean }) => callback(data)
      ipc.on('tts:behaviorEmotion:enabled', handler)
      return () => {
        ipc.removeListener('tts:behaviorEmotion:enabled', handler)
      }
    },

    /** 记录一次撤回/重做操作（撤销消息等），用于行为情绪推断 */
    recordBehaviorRetraction: (): Promise<{ success: boolean; error?: string }> =>
      ipc.invoke('tts:behaviorEmotion:recordRetraction'),

    // ── TTS 引擎路由 ──
    setEnginePreference: (pref: string): Promise<{ success: boolean; preference?: string; error?: string }> =>
      ipc.invoke('tts:engine-preference:set', pref),

    getEnginePreference: (): Promise<{ success: boolean; preference?: string }> => ipc.invoke('tts:engine-preference:get'),

    getTtsRouterState: (): Promise<{
      success: boolean
      preference?: string
      lastDecision?: Record<string, unknown> | null
      weights?: { qualityWeight: number; latencyWeight: number }
    }> => ipc.invoke('tts:router-state'),

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

    onTTSVoiceState: (callback: (state: {
      state: 'speaking' | 'idle'
      emotionParams: { voice: string; rate: string; pitch: string; label: string }
      text: string
      timestamp: number
      estimatedDurationMs?: number
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: any) => callback(state)
      ipc.on('tts:voice-state', handler)
      return () => {
        ipc.removeListener('tts:voice-state', handler)
      }
    },

    onToolStatus: (callback: (status: { type: string; tool: string; message: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: { type: string; tool: string; message: string }) => callback(status)
      ipc.on('tool:status', handler)
      return () => {
        ipc.removeListener('tool:status', handler)
      }
    },

    // ── 情感记忆语音叙事 ──
    triggerEmotionalNarrative: (): Promise<{ success: boolean; message?: string; error?: string }> =>
      ipc.invoke('emotional-narrative:trigger'),

    cancelEmotionalNarrative: (): Promise<{ success: boolean }> =>
      ipc.invoke('emotional-narrative:cancel'),

    getEmotionalNarrativeState: (): Promise<{
      success: boolean
      state?: string
      currentSegment?: number
      totalSegments?: number
      isActive?: boolean
    }> => ipc.invoke('emotional-narrative:state'),

    getEmotionalNarrativeContext: (): Promise<{
      success: boolean
      summary?: { dominantLabel: string; trend: string; entries: number } | null
    }> => ipc.invoke('emotional-narrative:context'),

    onEmotionalNarrativeStart: (callback: (data: {
      trend: string
      totalSegments: number
      contextSummary: string
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: {
        trend: string
        totalSegments: number
        contextSummary: string
      }) => callback(data)
      ipc.on('emotional-narrative:start', handler)
      return () => { ipc.removeListener('emotional-narrative:start', handler) }
    },

    onEmotionalNarrativeSegment: (callback: (data: {
      text: string
      index: number
      total: number
      label: string
      durationMs: number
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: {
        text: string
        index: number
        total: number
        label: string
        durationMs: number
      }) => callback(data)
      ipc.on('emotional-narrative:segment', handler)
      return () => { ipc.removeListener('emotional-narrative:segment', handler) }
    },

    onEmotionalNarrativeEnd: (callback: (data: {
      totalSegments: number
      totalDurationMs: number
      success: boolean
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: {
        totalSegments: number
        totalDurationMs: number
        success: boolean
      }) => callback(data)
      ipc.on('emotional-narrative:end', handler)
      return () => { ipc.removeListener('emotional-narrative:end', handler) }
    },

    onEmotionalNarrativeCancel: (callback: () => void) => {
      const handler = () => callback()
      ipc.on('emotional-narrative:cancel', handler)
      return () => { ipc.removeListener('emotional-narrative:cancel', handler) }
    },

    getCredential: (key: string): Promise<string | null> => ipc.invoke('credentials:get', key),

    getAllCredentials: (): Promise<Record<string, string>> => ipc.invoke('credentials:getAll'),

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

    onPlanFocusSwitched: (
      callback: (data: { planId: string; planTitle: string; status: string; stepCount: number; doneCount: number }) => void,
    ) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipc.on('agent:plan_focus_switched', handler)
      return () => ipc.removeListener('agent:plan_focus_switched', handler)
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

    // ── 隐式反馈驱动的语音自适应 ──
    recordImplicitFeedback: (action: string): Promise<{ success: boolean; error?: string }> =>
      ipc.invoke('tts:implicitFeedback:recordAction', action),

    toggleImplicitFeedback: (enabled: boolean): Promise<{ success: boolean; enabled: boolean }> =>
      ipc.invoke('tts:implicitFeedback:toggle', enabled),

    getImplicitFeedbackState: (): Promise<{
      success: boolean
      enabled: boolean
      recommendation: Record<string, unknown> | null
      status: { modelInitialized: boolean; totalSamples: number; historySize: number }
    }> => ipc.invoke('tts:implicitFeedback:state'),

    triggerImplicitFeedbackUpdate: (): Promise<{ success: boolean }> => ipc.invoke('tts:implicitFeedback:updateModel'),

    resetImplicitFeedback: (): Promise<{ success: boolean }> => ipc.invoke('tts:implicitFeedback:reset'),

    onImplicitFeedbackEnabled: (callback: (data: { enabled: boolean }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { enabled: boolean }) => callback(data)
      ipc.on('tts:implicitFeedback:enabled', handler)
      return () => {
        ipc.removeListener('tts:implicitFeedback:enabled', handler)
      }
    },

    // ── TTS 语音字幕 ──
    onTtsSubtitle: (callback: (data: {
      text: string
      estimatedDurationMs: number
      id: string
      startTime: number
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: {
        text: string
        estimatedDurationMs: number
        id: string
        startTime: number
      }) => callback(data)
      ipc.on('tts:subtitle', handler)
      return () => {
        ipc.removeListener('tts:subtitle', handler)
      }
    },

    getSubtitleEnabled: (): Promise<{ enabled: boolean }> => ipc.invoke('tts:subtitle:getEnabled'),

    setSubtitleEnabled: (enabled: boolean): Promise<{ success: boolean; enabled: boolean }> => ipc.invoke('tts:subtitle:setEnabled', enabled),

    onSubtitleToggle: (callback: (data: { enabled: boolean }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { enabled: boolean }) => callback(data)
      ipc.on('tts:subtitle:toggle', handler)
      return () => {
        ipc.removeListener('tts:subtitle:toggle', handler)
      }
    },

    // ── Writing Status ──
    getWritingStatus: (): Promise<{ stories: any[]; totalStories: number; totalScenes: number }> => ipc.invoke('writing:getStatus'),

    // ── 音频特征分析与氛围映射 ──
    analyzeAudioFeatures: (
      audio: ArrayBuffer,
    ): Promise<{
      success: boolean
      features?: {
        energy: number
        energyVariance: number
        energyTrend: number
        pitchHz: number
        pitchVariance: number
        pitchRange: number
        avgZeroCrossingRate: number
        zcrVariance: number
        speechRate: number
        silenceRatio: number
        voiceSegmentCount: number
        durationSec: number
      }
      atmosphere?: {
        tension: number
        joy: number
        sadness: number
        calmness: number
        mystery: number
        romance: number
        dominantLabel: string
        confidence: number
        description: string
      }
      error?: string
    }> => ipc.invoke('audio:analyzeFeatures', audio),

    // ── 语音灵感捕获与情节引导 ──
    processWritingInspiration: (
      text: string,
    ): Promise<{
      rawText: string
      entities: { characters: string[]; events: string[]; emotions: string[]; plotTurns: string[] }
      guidedPrompt: string
      processingMs: number
      hasContent: boolean
    }> => ipc.invoke('writing:inspiration:process', text),

    getWritingHotwords: (): Promise<{ hotwords: string[] }> => ipc.invoke('writing:inspiration:hotwords'),

    // ── 语音引导的剧情续写 ──
    initVoiceContinuation: (params: {
      storyName: string
      chapterNum: number
    }): Promise<{
      storyName: string
      chapterNum: number
      storyId: string | null
      previousChapter: { title: string; content: string } | null
      totalChapters: number
      readerExpectations: string
    }> => ipc.invoke('writing:continuation:init', params),

    executeVoiceContinuation: (params: {
      storyName: string
      chapterNum: number
      userVoiceText?: string
      atmosphere?: {
        tension: number
        joy: number
        sadness: number
        calmness: number
        mystery: number
        romance: number
        dominantLabel: string
        confidence: number
        description: string
      } | null
    }): Promise<{
      success: boolean
      chapterTitle: string
      content: string
      sceneId: string | null
      userVoiceText: string
      atmosphere?: {
        tension: number
        joy: number
        sadness: number
        calmness: number
        mystery: number
        romance: number
        dominantLabel: string
        confidence: number
        description: string
      } | null
      error?: string
      processingMs: number
    }> => ipc.invoke('writing:continuation:execute', params),

    // ── Evolution ──
    evolutionStatus: (): Promise<{ lastRun: number | null; consecutiveFailures: number; isBusy: boolean }> =>
      ipc.invoke('evolution:status'),
    evolutionTrigger: (): Promise<{ success: boolean; error?: string }> => ipc.invoke('evolution:trigger'),

    // ── Evolution Dashboard ──
    onEvolutionDashboard: (
      callback: (data: {
        stage: string
        progress: number
        summary: string
        errorCount: number
        fixedCount: number
        queueSize: number
        lastRunAt: number | null
        schedulerState: string
        safetyMode: string
        consecutiveFailures: number
        visible: boolean
        updatedAt: number
      }) => void,
    ) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipc.on('evolution:dashboard', handler)
      return () => {
        ipc.removeListener('evolution:dashboard', handler)
      }
    },

    // ── 自进化实时仪表盘（高频 1Hz 推送） ──
    onEvolutionDashboardLive: (
      callback: (data: {
        current: {
          schedulerState: string
          currentStage: string
          progress: number
          summary: string
          errorCount: number
          fixedCount: number
          queueSize: number
          consecutiveFailures: number
          lastRunAt: number | null
          plan: {
            hasActive: boolean
            title: string
            completedSteps: number
            totalSteps: number
            percentComplete: number
            currentStep: string
          } | null
          timestamp: number
        }
        history: Array<{
          schedulerState: string
          currentStage: string
          progress: number
          summary: string
          errorCount: number
          fixedCount: number
          queueSize: number
          consecutiveFailures: number
          lastRunAt: number | null
          plan: {
            hasActive: boolean
            title: string
            completedSteps: number
            totalSteps: number
            percentComplete: number
            currentStep: string
          } | null
          timestamp: number
        }>
        active: boolean
      }) => void,
    ) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipc.on('evolution:dashboard:live', handler)
      return () => {
        ipc.removeListener('evolution:dashboard:live', handler)
      }
    },

    toggleEvolutionDashboard: (): Promise<{ success: boolean; visible: boolean }> => ipc.invoke('evolution:dashboard:toggle'),

    // ── 自进化实时仪表盘控制 ──
    getEvolutionDashboardLiveConfig: (): Promise<{ enabled: boolean; opacity: number }> => ipc.invoke('evolution:dashboard:live:getConfig'),

    setEvolutionDashboardLiveConfig: (config: Partial<{ enabled: boolean; opacity: number }>): Promise<{ success: boolean }> =>
      ipc.invoke('evolution:dashboard:live:setConfig', config),

    // ── Desktop Toolbar (桌面任务控制浮层) ──
    invokeDesktopTool: (toolName: string, args: Record<string, string>): Promise<{ success: boolean; result?: string; error?: string }> =>
      ipc.invoke('desktop:invokeTool', toolName, args),

    // ── 桌面悬浮任务面板（TaskPanel） ──
    getTaskPanelState: (): Promise<{ success: boolean; state?: any; error?: string }> =>
      ipc.invoke('taskPanel:getState'),

    toggleTaskPanelVisibility: (): Promise<{ success: boolean; visible: boolean }> =>
      ipc.invoke('taskPanel:toggleVisibility'),

    setTaskPanelVisibility: (visible: boolean): Promise<{ success: boolean; visible: boolean }> =>
      ipc.invoke('taskPanel:setVisibility', visible),

    invokeTaskPanelQuickAction: (actionId: string, args?: Record<string, string>): Promise<{ success: boolean; result?: string; error?: string }> =>
      ipc.invoke('taskPanel:invokeQuickAction', actionId, args || {}),

    recordTaskPanelAction: (action: { tool: string; status: 'running' | 'success' | 'error'; summary: string }): Promise<{ success: boolean }> =>
      ipc.invoke('taskPanel:recordAction', action),

    // ── 排版内容语音校验与预览 ──
    verifyTypography: (
      text: string,
    ): Promise<{
      success: boolean
      report?: {
        formattedText: string
        plainText: string
        recognizedText: string
        sentences: Array<{
          originalSentence: string
          recognizedSentence: string
          editDistance: number
          length: number
          diffRate: number
          suspicious: boolean
          diffSegments: Array<{
            type: 'match' | 'substitution' | 'deletion' | 'insertion'
            original: string
            recognized: string
            start: number
            end: number
          }>
        }>
        summary: {
          totalSentences: number
          suspiciousSentences: number
          totalDiffRate: number
          hasDiscrepancies: boolean
          audioDurationMs: number
          verificationMs: number
        }
        audioFile?: string
      }
      error?: string
    }> => ipc.invoke('typing:verify', text),

    readAloudTypography: (
      text: string,
    ): Promise<{
      success: boolean
      audioFile?: string
      durationMs: number
      error?: string
    }> => ipc.invoke('typing:readAloud', text),

    // ── 行为感知壁纸 ──
    onBehaviorState: (
      callback: (state: {
        activityState: string
        fullscreen: boolean
        focused: boolean
        appCategory: string
        windowTitle: string
        idleTimeMs: number
        mode: string
        context: string
        thresholds: {
          idleThresholdMs: number
          focusThresholdMs: number
          multitaskingSwitchCount: number
          multitaskingWindowMs: number
          privacyFadeDelayMs: number
        }
        modeDurationMs: number
        confidence: number
        breakElapsedMs: number
        recentSwitches: Array<{
          fromCategory: string
          toCategory: string
        }>
      }) => void,
    ) => {
      const handler = (_event: Electron.IpcRendererEvent, state: any) => callback(state)
      ipc.on('behavior:state', handler)
      return () => {
        ipc.removeListener('behavior:state', handler)
      }
    },

    // ── 行为预测哑提醒（主进程 → 渲染进程） ──
    onBehaviorPrediction: (
      callback: (data: {
        topic: string
        description: string
        confidence: number
        associatedTool?: string
        preloaded: boolean
        eventId: string
        expiresAt: number
      }) => void,
    ) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipc.on('behavior:prediction', handler)
      return () => {
        ipc.removeListener('behavior:prediction', handler)
      }
    },

    // ── 行为频率计数（桌面快捷入口） ──
    getBehaviorTopActions: (n?: number): Promise<{
      success: boolean
      actions: Array<{
        actionId: string
        category: string
        label: string
        icon: string
        trigger: string
        toolName?: string
        frequency: number
        lastUsedAt: number
      }>
      timestamp: number
      error?: string
    }> => ipc.invoke('wallpaper:getTopActions', n),

    onBehaviorTopActions: (
      callback: (data: {
        actions: Array<{
          actionId: string
          category: string
          label: string
          icon: string
          trigger: string
          toolName?: string
          frequency: number
          lastUsedAt: number
        }>
        timestamp: number
      }) => void,
    ) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipc.on('wallpaper:top-actions', handler)
      return () => {
        ipc.removeListener('wallpaper:top-actions', handler)
      }
    },

    recordBehaviorAction: (actionId: string): Promise<{ success: boolean; error?: string }> =>
      ipc.invoke('wallpaper:recordAction', actionId),

    getWallpaperConfig: (): Promise<{
      enabled: boolean
      idleOverlay: boolean
      adaptiveOpacity: boolean
      normalOpacity: number
      codeOpacity: number
      fullscreenOpacity: number
      idleOpacity: number
      evoLocked: boolean
    }> => ipc.invoke('wallpaper:getConfig'),

    setWallpaperConfig: (
      config: Partial<{
        enabled: boolean
        idleOverlay: boolean
        adaptiveOpacity: boolean
        normalOpacity: number
        codeOpacity: number
        fullscreenOpacity: number
        idleOpacity: number
        evoLocked: boolean
      }>,
    ): Promise<{ success: boolean }> => ipc.invoke('wallpaper:setConfig', config),

    // ── 工具调用参数组合智能默认值 ──
    getToolParamDefaults: (
      toolName: string,
      limit?: number,
    ): Promise<{
      success: boolean
      combinations: Array<{
        args: Record<string, any>
        frequency: number
        successRate: number
        rating: number
        lastUsed: number
        firstSeen: number
      }>
      error?: string
    }> => ipc.invoke('tool:getParamDefaults', toolName, limit),

    recordToolParamFeedback: (
      toolName: string,
      args: Record<string, any>,
      rating: number,
    ): Promise<{ success: boolean; error?: string }> => ipc.invoke('tool:recordParamFeedback', toolName, args, rating),

    // ── 自进化系统监控 ──
    onMonitoringMetrics: (
      callback: (data: {
        system: {
          heapUsedMB: number
          heapTotalMB: number
          rssMB: number
          eventLoopLagMs: number
          cpuUsage: number
          uptime: number
          timestamp: number
        }
        evolution: {
          stage: string
          progress: number
          summary: string
          errorCount: number
          fixedCount: number
          queueSize: number
          lastRunAt: number | null
          schedulerState: string
          consecutiveFailures: number
        } | null
        plan: {
          hasActivePlan: boolean
          planTitle: string
          totalSteps: number
          completedSteps: number
          percentComplete: number
          currentStep: string
        } | null
        recentChanges: Array<{ filePath: string; type: string; timestamp: number; summary: string }>
        evoLocked: boolean
      }) => void,
    ) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipc.on('monitoring:metrics', handler)
      return () => {
        ipc.removeListener('monitoring:metrics', handler)
      }
    },

    getEvolutionPlanStatus: (): Promise<{
      hasActivePlan: boolean
      planTitle: string
      totalSteps: number
      completedSteps: number
      percentComplete: number
      currentStep: string
    }> => ipc.invoke('evolution:planStatus'),

    getEvoLock: (): Promise<{ locked: boolean }> => ipc.invoke('wallpaper:getEvoLock'),

    setEvoLock: (locked: boolean): Promise<{ success: boolean; locked: boolean }> => ipc.invoke('wallpaper:setEvoLock', locked),

    // ── 壁纸 CSS 热重载 ──
    onWallpaperStylesUpdated: (callback: (css: string, filename?: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, css: string, filename?: string) => callback(css, filename)
      ipc.on('wallpaper:styles-updated', handler)
      return () => {
        ipc.removeListener('wallpaper:styles-updated', handler)
      }
    },

    reloadWallpaperStyles: (css: string): Promise<{ success: boolean }> => ipc.invoke('wallpaper:reloadStyles', css),

    // ── 壁纸交互模式（Ctrl+Space 激活） ──
    onWallpaperToggleInteractive: (callback: (data: { active: boolean }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { active: boolean }) => callback(data)
      ipc.on('wallpaper:interactive:toggle', handler)
      return () => {
        ipc.removeListener('wallpaper:interactive:toggle', handler)
      }
    },

    getWallpaperInteractiveConfig: (): Promise<{ enabled: boolean; shortcut: string }> =>
      ipc.invoke('wallpaper:interactive:getConfig'),

    setWallpaperInteractiveEnabled: (enabled: boolean): Promise<{ success: boolean }> =>
      ipc.invoke('wallpaper:interactive:setEnabled', enabled),

    // ── 博客写作看板 ──
    getBlogKanbanStatus: (): Promise<{
      sessions: Array<{
        sessionId: string
        topic: string
        targetPlatform: string
        currentStageId: string
        currentStageLabel: string
        stageProgress: number
        currentStageIndex: number
        totalStages: number
        completedStages: number
        skippedStages: number
        percentComplete: number
        completed: boolean
        stageStatuses: Array<{ stageId: string; label: string; status: string; index: number }>
        createdAt: number
        lastActivityAt: number
        progressText: string
      }>
      totalActiveSessions: number
      hasActiveSessions: boolean
      timestamp: number
    }> => ipc.invoke('wallpaper:blogKanban:getStatus'),

    refreshBlogKanban: (): Promise<{ success: boolean }> =>
      ipc.invoke('wallpaper:blogKanban:refresh'),

    onBlogKanbanUpdate: (callback: (data: {
      sessions: Array<{
        sessionId: string
        topic: string
        targetPlatform: string
        currentStageId: string
        currentStageLabel: string
        stageProgress: number
        currentStageIndex: number
        totalStages: number
        completedStages: number
        skippedStages: number
        percentComplete: number
        completed: boolean
        stageStatuses: Array<{ stageId: string; label: string; status: string; index: number }>
        createdAt: number
        lastActivityAt: number
        progressText: string
      }>
      totalActiveSessions: number
      hasActiveSessions: boolean
      timestamp: number
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipc.on('wallpaper:blog-kanban:update', handler)
      return () => {
        ipc.removeListener('wallpaper:blog-kanban:update', handler)
      }
    },

    // ── 桌面记忆浮窗 ──
    onMemoryContextData: (
      callback: (data: {
        cards: Array<{
          id: string
          content: string
          type: string
          confidence: number
          tier: string
          topics: string[]
          behaviorScore: number
          isPinned: boolean
          createdAt: number
          updatedAt: number
        }>
        updatedAt: number
        hasData: boolean
        displayType: string
        error?: string
      }) => void,
    ) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipc.on('wallpaper:memoryContext', handler)
      return () => {
        ipc.removeListener('wallpaper:memoryContext', handler)
      }
    },

    getMemoryContextConfig: (): Promise<{
      enabled: boolean
      displayType: string
      pollIntervalMs: number
      maxCards: number
      mouseThrough: boolean
    }> => ipc.invoke('wallpaper:memoryContextConfig:get'),

    setMemoryContextConfig: (
      config: Partial<{
        enabled: boolean
        displayType: string
        pollIntervalMs: number
        maxCards: number
        mouseThrough: boolean
      }>,
    ): Promise<{ success: boolean; error?: string }> => ipc.invoke('wallpaper:memoryContextConfig:set', config),

    refreshMemoryContext: (): Promise<{ success: boolean; error?: string }> => ipc.invoke('wallpaper:memoryContext:refresh'),

    // ── 对话语境信息浮层 ──
    onConversationContextData: (
      callback: (data: {
        summary: string
        summaryConfidence: number
        activeTasks: Array<{
          taskId: string
          title: string
          status: string
          completedSteps: number
          totalSteps: number
          progressPercent: number
          updatedAt: number
        }>
        completedTasks: number
        totalTasks: number
        progressPercent: number
        updatedAt: number
        hasData: boolean
        error?: string
      }) => void,
    ) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipc.on('wallpaper:conversationContext', handler)
      return () => {
        ipc.removeListener('wallpaper:conversationContext', handler)
      }
    },

    getConversationContextConfig: (): Promise<{
      enabled: boolean
      position: string
      maxTasks: number
      showSummary: boolean
      showTasks: boolean
      showProgress: boolean
    }> => ipc.invoke('wallpaper:conversationContext:getConfig'),

    setConversationContextConfig: (
      config: Partial<{
        enabled: boolean
        position: string
        maxTasks: number
        showSummary: boolean
        showTasks: boolean
        showProgress: boolean
      }>,
    ): Promise<{ success: boolean; error?: string }> => ipc.invoke('wallpaper:conversationContext:setConfig', config),

    navigateToConversation: (conversationId: string): Promise<{ success: boolean; error?: string }> =>
      ipc.invoke('wallpaper:openConversation', conversationId),

    // ── 文件整理进度可视化 ──
    onOrganizerProgress: (
      callback: (data: {
        status: string
        totalFiles: number
        completedFiles: number
        failedFiles: number
        skippedFiles: number
        currentFile: string | null
        currentTarget: string | null
        percentComplete: number
        recentMoves: Array<{
          filePath: string
          sourcePath: string
          targetPath: string
          ruleId: string
          ruleSource: string
          status: string
          durationMs?: number
          error?: string
          reason?: string
          timestamp: number
        }>
        startTime: number | null
        endTime: number | null
        summary: string
        isPaused: boolean
        updatedAt: number
      }) => void,
    ) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipc.on('organizer:progress', handler)
      return () => {
        ipc.removeListener('organizer:progress', handler)
      }
    },

    organizerPause: (): Promise<{ success: boolean }> => ipc.invoke('organizer:pause'),
    organizerResume: (): Promise<{ success: boolean }> => ipc.invoke('organizer:resume'),
    organizerSkip: (): Promise<{ success: boolean }> => ipc.invoke('organizer:skip'),

    // ── M6.3 Guardrail Metrics Query API ──

    getGuardrailMetricsSummary: (): Promise<{
      totalChecked: number
      totalWarning: number
      totalTerminated: number
      totalContinue: number
      totalSignalsHealthy: number
      totalSignalsDegrading: number
      totalSignalsStalled: number
      windowCount: number
    }> => ipc.invoke('guardrail:metrics:summary'),

    queryGuardrailMetrics: (
      since: number,
      until: number,
    ): Promise<
      Array<{
        id: string
        windowSince: number
        windowUntil: number
        checkedCount: number
        warningCount: number
        terminatedCount: number
        continueCount: number
        totalSignalsHealthy: number
        totalSignalsDegrading: number
        totalSignalsStalled: number
        updatedAt: number
      }>
    > => ipc.invoke('guardrail:metrics:query', since, until),

    getGuardrailMetricsLatest: (): Promise<{
      id: string
      windowSince: number
      windowUntil: number
      checkedCount: number
      warningCount: number
      terminatedCount: number
      continueCount: number
      totalSignalsHealthy: number
      totalSignalsDegrading: number
      totalSignalsStalled: number
      updatedAt: number
    } | null> => ipc.invoke('guardrail:metrics:latest'),

    getGuardrailProjectionState: (): Promise<
      | { status: 'READY'; lastBuiltAt: number; windowCount: number }
      | { status: 'REBUILDING'; startedAt: number; windowsBuilt: number }
      | { status: 'UNAVAILABLE'; reason: string }
    > => ipc.invoke('guardrail:metrics:state'),

    // ── 快捷任务编排（QuickTask） ──

    getQuickTasks: (): Promise<{ success: boolean; tasks: any[]; error?: string }> => ipc.invoke('quickTask:getAll'),

    quickTaskRecommendNow: (): Promise<{ success: boolean; tasks: any[]; error?: string }> => ipc.invoke('quickTask:recommendNow'),

    quickTaskExecute: (taskId: string): Promise<{ success: boolean; task?: any; error?: string }> => ipc.invoke('quickTask:execute', taskId),

    quickTaskDismiss: (taskId: string): Promise<{ success: boolean; task?: any; error?: string }> => ipc.invoke('quickTask:dismiss', taskId),

    quickTaskSnooze: (taskId: string): Promise<{ success: boolean; task?: any; error?: string }> => ipc.invoke('quickTask:snooze', taskId),

    quickTaskEdit: (taskId: string, steps: Array<{ tool: string; label: string; args?: Record<string, unknown> }>): Promise<{ success: boolean; task?: any; error?: string }> => ipc.invoke('quickTask:edit', taskId, steps),

    getQuickTaskSnapshot: (): Promise<{ success: boolean; snapshot?: any; error?: string }> => ipc.invoke('quickTask:getSnapshot'),

    quickTaskSetSensitivity: (threshold: number): Promise<{ success: boolean; error?: string }> => ipc.invoke('quickTask:setSensitivity', threshold),

    quickTaskAnalyze: (): Promise<{ success: boolean; tasks: any[]; error?: string }> => ipc.invoke('quickTask:analyze'),

    quickTaskStart: (): Promise<{ success: boolean; error?: string }> => ipc.invoke('quickTask:start'),

    quickTaskStop: (): Promise<{ success: boolean; error?: string }> => ipc.invoke('quickTask:stop'),

    // ── 快捷任务推送事件（主→渲染） ──

    onQuickTaskRecommend: (callback: (data: { tasks: any[]; timestamp: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { tasks: any[]; timestamp: number }) => callback(data)
      ipc.on('quick_task:recommend', handler)
      return () => {
        ipc.removeListener('quick_task:recommend', handler)
      }
    },

    onQuickTaskUpdate: (callback: (data: { task: any; action: string; timestamp: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { task: any; action: string; timestamp: number }) => callback(data)
      ipc.on('quick_task:update', handler)
      return () => {
        ipc.removeListener('quick_task:update', handler)
      }
    },

    // ── 语音记忆书签 ──
    voiceBookmarkCreate: (
      summary: string,
      conversationContext: Array<{ role: 'user' | 'assistant'; content: string; createdAt: number }>,
      options?: { audioText?: string; tags?: string[]; isFavorite?: boolean },
    ): Promise<{
      success: boolean
      bookmark?: { id: string; summary: string; audioPath: string; tags: string[]; bookmarkedAt: number }
      error?: string
    }> => ipc.invoke('voice-bookmark:create', summary, conversationContext, options),

    voiceBookmarkList: (
      limit?: number,
      offset?: number,
    ): Promise<{
      success: boolean
      bookmarks: Array<{
        id: string
        summary: string
        audioPath: string
        audioText: string
        tags: string[]
        isFavorite: boolean
        bookmarkedAt: number
        conversationContext: Array<{ role: string; content: string; createdAt: number }>
        ttsDurationMs: number
      }>
      error?: string
    }> => ipc.invoke('voice-bookmark:list', limit, offset),

    voiceBookmarkSearch: (
      query: string,
    ): Promise<{
      success: boolean
      bookmarks: Array<{
        id: string
        summary: string
        audioPath: string
        audioText: string
        tags: string[]
        isFavorite: boolean
        bookmarkedAt: number
        conversationContext: Array<{ role: string; content: string; createdAt: number }>
        ttsDurationMs: number
      }>
      error?: string
    }> => ipc.invoke('voice-bookmark:search', query),

    voiceBookmarkGet: (
      id: string,
    ): Promise<{
      success: boolean
      bookmark?: {
        id: string
        summary: string
        audioPath: string
        audioText: string
        tags: string[]
        isFavorite: boolean
        bookmarkedAt: number
        conversationContext: Array<{ role: string; content: string; createdAt: number }>
        ttsDurationMs: number
      }
      error?: string
    }> => ipc.invoke('voice-bookmark:get', id),

    voiceBookmarkDelete: (id: string): Promise<{ success: boolean; error?: string }> =>
      ipc.invoke('voice-bookmark:delete', id),

    voiceBookmarkGetAudioPath: (id: string): Promise<{ success: boolean; audioPath?: string; error?: string }> =>
      ipc.invoke('voice-bookmark:audioPath', id),

    voiceBookmarkToggleFavorite: (id: string): Promise<{ success: boolean; isFavorite?: boolean; error?: string }> =>
      ipc.invoke('voice-bookmark:toggleFavorite', id),

    voiceBookmarkGetFavorites: (): Promise<{
      success: boolean
      bookmarks: Array<{
        id: string
        summary: string
        audioPath: string
        audioText: string
        tags: string[]
        isFavorite: boolean
        bookmarkedAt: number
        conversationContext: Array<{ role: string; content: string; createdAt: number }>
        ttsDurationMs: number
      }>
      error?: string
    }> => ipc.invoke('voice-bookmark:favorites'),

    // ── 博客语音服务（口述录音 & 审核批注） ──
    blogSaveAudio: (
      audio: ArrayBuffer,
      type: 'dictation' | 'annotation',
      options?: {
        sessionId?: string
        paragraphIndex?: number
        durationSec?: number
        transcribedText?: string
        label?: string
      },
    ): Promise<{
      success: boolean
      entry?: {
        id: string
        type: string
        durationSec: number
        transcribedText?: string
        createdAt: number
      }
      error?: string
    }> => ipc.invoke('blog:saveAudio', audio, type, options),

    blogListAudio: (
      type?: 'dictation' | 'annotation',
      limit?: number,
    ): Promise<Array<{
      id: string
      type: string
      sessionId?: string
      paragraphIndex?: number
      durationSec: number
      transcribedText?: string
      createdAt: number
      label?: string
    }>> => ipc.invoke('blog:listAudio', type, limit),

    blogGetAudioPath: (
      entryId: string,
    ): Promise<{ success: boolean; audioPath?: string; error?: string }> =>
      ipc.invoke('blog:getAudioPath', entryId),

    blogDeleteAudio: (
      entryId: string,
    ): Promise<{ success: boolean; error?: string }> => ipc.invoke('blog:deleteAudio', entryId),

    // ── 语音便签壁纸 ──
    voicenoteToggle: (): Promise<{ success: boolean; state: any }> => ipc.invoke('voicenote:toggle'),

    voicenoteGetState: (): Promise<{ success: boolean; state: any }> => ipc.invoke('voicenote:getState'),

    voicenoteSetText: (text: string): Promise<{ success: boolean }> => ipc.invoke('voicenote:setText', text),

    voicenoteAppendText: (text: string): Promise<{ success: boolean }> => ipc.invoke('voicenote:appendText', text),

    voicenoteClear: (): Promise<{ success: boolean }> => ipc.invoke('voicenote:clear'),

    voicenoteCopy: (): Promise<{ success: boolean }> => ipc.invoke('voicenote:copy'),

    voicenoteSave: (): Promise<{ success: boolean; path?: string; error?: string }> => ipc.invoke('voicenote:save'),

    voicenoteSetDisplayMode: (mode: 'fixed' | 'scroll'): Promise<{ success: boolean }> =>
      ipc.invoke('voicenote:setDisplayMode', mode),

    onVoicenoteStateChange: (callback: (state: any) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: any) => callback(state)
      ipc.on('voicenote:state-changed', handler)
      return () => {
        ipc.removeListener('voicenote:state-changed', handler)
      }
    },

    // ── 工具链编排进度 ──
    onOrchestrationProgress: (callback: (data: {
      type: string
      planId: string
      stepId?: string
      stepName?: string
      completedSteps: number
      totalSteps: number
      percent: number
      message: string
      error?: string
      timestamp: number
      stepStatuses: Array<{
        id: string
        name: string
        status: string
        toolName: string
      }>
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipc.on('orchestration:progress', handler)
      return () => {
        ipc.removeListener('orchestration:progress', handler)
      }
    },

    // ── 语音 ODE 求解会话 ──
    odeFeed: (
      text: string,
    ): Promise<{
      active: boolean
      state?: string
      parsed?: {
        equation?: string
        initialCondition?: string
        interval?: [number, number]
        method?: string
        stepSize?: number
      }
      solution?: {
        xFinal: number
        yFinal: number
        method: string
        steps: number
        plotPath?: string
        analyticalNote?: string | null
      } | null
      sessionId?: string
      error?: string
      matched?: boolean
    }> => ipc.invoke('voice:ode:feed', text),

    odeState: (): Promise<{
      active: boolean
      state: string
      sessionId: string
      parsed: any
      hasSolution: boolean
    }> => ipc.invoke('voice:ode:state'),

    odeReset: (): Promise<{ success: boolean }> => ipc.invoke('voice:ode:reset'),

    // ── 语音 ODE 求解事件（主进程 → 渲染进程，状态变更通知） ──
    onOdeStateChange: (callback: (data: {
      sessionId: string
      state: string
      hasSolution: boolean
      solution?: {
        xFinal: number
        yFinal: number
        method: string
        steps: number
      }
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
      ipc.on('ode:state-change', handler)
      return () => {
        ipc.removeListener('ode:state-change', handler)
      }
    },
  }
}

const electronAPI = createElectronAPI(ipcRenderer)
contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = ReturnType<typeof createElectronAPI>
