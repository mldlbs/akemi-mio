import { vi, type Mock } from 'vitest'
import type { ElectronAPI } from '../../../preload/index'

type MockedElectronAPI = {
  [K in keyof ElectronAPI]: ElectronAPI[K] extends (...args: infer A) => infer R ? Mock<R, A> : ElectronAPI[K]
}

export function createMockIPC(overrides?: Partial<MockedElectronAPI>): MockedElectronAPI {
  const mock: MockedElectronAPI = {
    // Window
    closeWindow: vi.fn<[], Promise<{ success: boolean }>>().mockResolvedValue({ success: true }),
    minimizeWindow: vi.fn<[], Promise<{ success: boolean }>>().mockResolvedValue({ success: true }),
    maximizeWindow: vi
      .fn<[], Promise<{ success: boolean; isMaximized: boolean }>>()
      .mockResolvedValue({ success: true, isMaximized: false }),
    isMaximized: vi.fn<[], Promise<{ isMaximized: boolean }>>().mockResolvedValue({ isMaximized: false }),
    toggleFullscreen: vi
      .fn<[], Promise<{ success: boolean; isFullScreen: boolean }>>()
      .mockResolvedValue({ success: true, isFullScreen: false }),

    // ASR / AI / TTS
    transcribe: vi.fn<[ArrayBuffer], Promise<{ text: string; request_id?: string; error?: string }>>().mockResolvedValue({ text: '' }),
    chat: vi
      .fn<[string, string?, string?, boolean?], Promise<{ reply?: string; error?: string }>>()
      .mockResolvedValue({ reply: 'Hello from mock' }),
    speak: vi.fn<[string], Promise<void>>().mockResolvedValue(undefined),
    stopSpeaking: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
    stopConversation: vi.fn<[], Promise<{ success: boolean }>>().mockResolvedValue({ success: true }),
    getState: vi.fn<[], Promise<{ asr: string; error?: string }>>().mockResolvedValue({ asr: 'idle' }),
    getWakeWords: vi.fn<[], Promise<string[]>>().mockResolvedValue(['澪', 'mio']),

    // ASR hotwords & vocabulary
    toggleAsrHotwords: vi.fn<[boolean], Promise<{ enabled: boolean }>>().mockResolvedValue({ enabled: true }),
    getAsrHotwordState: vi
      .fn<[], Promise<{ enabled: boolean; entryCount: number; hotwords: string[]; totalInputs: number }>>()
      .mockResolvedValue({ enabled: true, entryCount: 0, hotwords: [], totalInputs: 0 }),

    getVocabState: vi
      .fn<
        [],
        Promise<{
          words: Array<{ word: string; count: number; domain: string; lastSeen: number; firstSeen: number }>
          domainStats: Array<{ label: string; count: number }>
          totalWords: number
          enabled: boolean
        }>
      >()
      .mockResolvedValue({ words: [], domainStats: [], totalWords: 0, enabled: true }),

    deleteVocabWord: vi.fn<[string], Promise<{ success: boolean }>>().mockResolvedValue({ success: true }),

    clearVocabData: vi.fn<[], Promise<{ success: boolean }>>().mockResolvedValue({ success: true }),

    refreshVocabContext: vi.fn<[], Promise<{ success: boolean; error?: string }>>().mockResolvedValue({ success: true }),

    // Events (main -> renderer push)
    onStateUpdate: vi.fn<[(state: Record<string, unknown>) => void], () => void>().mockReturnValue(vi.fn()),
    onAIChunk: vi.fn<[(text: string) => void], () => void>().mockReturnValue(vi.fn()),
    onTTSAudio: vi.fn<[(filePath: string) => void], () => void>().mockReturnValue(vi.fn()),
    onTTSBuffer: vi.fn<[(buffer: ArrayBuffer) => void], () => void>().mockReturnValue(vi.fn()),
    onToolStatus: vi.fn<[(status: { type: string; tool: string; message: string }) => void], () => void>().mockReturnValue(vi.fn()),
    onMessageNew: vi
      .fn<
        [
          (msg: {
            id: string
            source: string
            role: string
            content: string
            category: string
            sessionId?: string
            createdAt: number
          }) => void,
        ],
        () => void
      >()
      .mockReturnValue(vi.fn()),

    // Credentials
    getCredential: vi.fn<[string], Promise<string | null>>().mockResolvedValue(null),
    getAllCredentials: vi.fn<[], Promise<Record<string, string>>>().mockResolvedValue({}),
    setCredential: vi.fn<[string, string], Promise<true>>().mockResolvedValue(true as const),
    deleteCredential: vi.fn<[string], Promise<true>>().mockResolvedValue(true as const),

    // Message/session
    getMessageHistory: vi
      .fn<
        [number?],
        Promise<{ id: string; source: string; role: string; content: string; category: string; sessionId?: string; createdAt: number }[]>
      >()
      .mockResolvedValue([]),
    getSessions: vi
      .fn<
        [],
        Promise<
          { id: string; source: string; category: string; label: string; messageCount: number; lastActivityAt: number; createdAt: number }[]
        >
      >()
      .mockResolvedValue([]),
    getMessagesBySession: vi
      .fn<
        [string],
        Promise<{ id: string; source: string; role: string; content: string; category: string; sessionId?: string; createdAt: number }[]>
      >()
      .mockResolvedValue([]),

    // Auto-update
    checkUpdate: vi.fn<[], Promise<{ available: boolean; version?: string; error?: string }>>().mockResolvedValue({ available: false }),
    downloadUpdate: vi.fn<[], Promise<{ success: boolean; error?: string }>>().mockResolvedValue({ success: true }),
    installUpdate: vi.fn<[], Promise<{ success: boolean }>>().mockResolvedValue({ success: true }),
    onUpdateStatus: vi.fn<[(status: Record<string, unknown>) => void], () => void>().mockReturnValue(vi.fn()),

    // Coding Agent UI — tool events
    onToolInvoked: vi.fn<[(data: { tool: string; args: Record<string, any>; id: string }) => void], () => void>().mockReturnValue(vi.fn()),
    onToolCompleted: vi
      .fn<[(data: { tool: string; result: string; id: string; latencyMs: number }) => void], () => void>()
      .mockReturnValue(vi.fn()),
    onToolFailed: vi
      .fn<[(data: { tool: string; error: string; id: string; latencyMs: number }) => void], () => void>()
      .mockReturnValue(vi.fn()),

    // Plan events
    onPlanCreated: vi.fn<[(data: { planId: string; title: string }) => void], () => void>().mockReturnValue(vi.fn()),
    onPlanStep: vi.fn<[(data: { planId: string; stepIndex: number; status: string }) => void], () => void>().mockReturnValue(vi.fn()),
    onPlanCompleted: vi.fn<[(data: { planId: string }) => void], () => void>().mockReturnValue(vi.fn()),

    // OTPAR
    onAgentObserve: vi
      .fn<
        [(data: { requestId: string; step: number; proceduresFound: number; patternsFound: number; durationMs: number }) => void],
        () => void
      >()
      .mockReturnValue(vi.fn()),
    onAgentThink: vi
      .fn<[(data: { requestId: string; step: number; toolCallCount: number; strategyPrompted: boolean }) => void], () => void>()
      .mockReturnValue(vi.fn()),
    onAgentReflect: vi
      .fn<
        [
          (data: {
            requestId: string
            step: number
            toolResults: number
            successCount: number
            summary: string
            durationMs: number
          }) => void,
        ],
        () => void
      >()
      .mockReturnValue(vi.fn()),

    // Input/output
    onInputReceived: vi.fn<[(data: { text: string; requestId: string; source: string }) => void], () => void>().mockReturnValue(vi.fn()),
    onResponseGenerated: vi
      .fn<[(data: { text: string; requestId: string; source: string }) => void], () => void>()
      .mockReturnValue(vi.fn()),

    // Guardrail & error
    onGuardrail: vi.fn<[(data: { type: string } & Record<string, any>) => void], () => void>().mockReturnValue(vi.fn()),
    onBudgetExhausted: vi.fn<[(data: { resource: string; utilization: number }) => void], () => void>().mockReturnValue(vi.fn()),
    onBudgetRestored: vi.fn<[(data: { resource: string; utilization: number }) => void], () => void>().mockReturnValue(vi.fn()),
    onAgentError: vi.fn<[(data: { error: string; requestId: string }) => void], () => void>().mockReturnValue(vi.fn()),
    onPersonaUpdated: vi.fn<[(data: { level: string }) => void], () => void>().mockReturnValue(vi.fn()),

    // Workflow events
    onWorkflowRunCreated: vi.fn<[(data: { runId: string; workflowDefId: string }) => void], () => void>().mockReturnValue(vi.fn()),
    onWorkflowRunUpdated: vi.fn<[(data: { runId: string; status: string }) => void], () => void>().mockReturnValue(vi.fn()),
    onWorkflowRunStep: vi
      .fn<[(data: { runId: string; stepId: string; status: string; agentResult?: string }) => void], () => void>()
      .mockReturnValue(vi.fn()),
    onWorkflowDefCreated: vi.fn<[(data: { workflowDefId: string }) => void], () => void>().mockReturnValue(vi.fn()),

    // Agent plans (invoke)
    getActivePlan: vi
      .fn<
        [],
        Promise<{
          id: string
          title: string
          description: string
          steps: { id: string; description: string; status: string; result?: string }[]
          status: string
          createdAt: number
          updatedAt: number
        } | null>
      >()
      .mockResolvedValue(null),
    listPlans: vi
      .fn<
        [],
        Promise<
          {
            id: string
            title: string
            description: string
            steps: { id: string; description: string; status: string; result?: string }[]
            status: string
            createdAt: number
            updatedAt: number
          }[]
        >
      >()
      .mockResolvedValue([]),
    openAgentWindow: vi.fn<[], Promise<{ success: boolean; error?: string }>>().mockResolvedValue({ success: true }),
    closeAgentWindow: vi.fn<[], Promise<{ success: boolean }>>().mockResolvedValue({ success: true }),

    // Workflow definitions & runs (invoke)
    listWorkflowDefinitions: vi.fn<[], Promise<any[]>>().mockResolvedValue([]),
    getWorkflowDefinition: vi.fn<[string], Promise<any>>().mockResolvedValue(null),
    listWorkflowRuns: vi.fn<[number?], Promise<any[]>>().mockResolvedValue([]),
    getWorkflowRun: vi.fn<[string], Promise<any>>().mockResolvedValue(null),
    deleteWorkflowDefinition: vi.fn<[string], Promise<{ success: boolean }>>().mockResolvedValue({ success: true }),
    saveWorkflowDefinition: vi.fn<[any], Promise<{ success: boolean }>>().mockResolvedValue({ success: true }),
    startWorkflow: vi
      .fn<[string], Promise<{ success: boolean; runId?: string; error?: string }>>()
      .mockResolvedValue({ success: true, runId: 'mock-run-1' }),
    enableWorkflowDefinition: vi.fn<[string], Promise<{ success: boolean; error?: string }>>().mockResolvedValue({ success: true }),
    disableWorkflowDefinition: vi.fn<[string], Promise<{ success: boolean; error?: string }>>().mockResolvedValue({ success: true }),
    stopWorkflowRun: vi.fn<[string], Promise<{ success: boolean; error?: string }>>().mockResolvedValue({ success: true }),
    duplicateWorkflowDefinition: vi.fn<[string], Promise<{ success: boolean; error?: string }>>().mockResolvedValue({ success: true }),
    deleteWorkflowRun: vi.fn<[string], Promise<{ success: boolean; error?: string }>>().mockResolvedValue({ success: true }),
    approveGate: vi
      .fn<[string, string, string, string?], Promise<{ success: boolean; error?: string }>>()
      .mockResolvedValue({ success: true }),

    // 隐式反馈驱动的语音自适应
    recordImplicitFeedback: vi.fn<[string], Promise<{ success: boolean; error?: string }>>().mockResolvedValue({ success: true }),
    toggleImplicitFeedback: vi
      .fn<[boolean], Promise<{ success: boolean; enabled: boolean }>>()
      .mockResolvedValue({ success: true, enabled: true }),
    getImplicitFeedbackState: vi
      .fn<
        [],
        Promise<{
          success: boolean
          enabled: boolean
          recommendation: Record<string, unknown> | null
          status: { modelInitialized: boolean; totalSamples: number; historySize: number }
        }>
      >()
      .mockResolvedValue({
        success: true,
        enabled: true,
        recommendation: null,
        status: { modelInitialized: false, totalSamples: 0, historySize: 0 },
      }),
    triggerImplicitFeedbackUpdate: vi.fn<[], Promise<{ success: boolean }>>().mockResolvedValue({ success: true }),
    resetImplicitFeedback: vi.fn<[], Promise<{ success: boolean }>>().mockResolvedValue({ success: true }),
    onImplicitFeedbackEnabled: vi.fn<[(data: { enabled: boolean }) => void], () => void>().mockReturnValue(vi.fn()),

    // Writing
    getWritingStatus: vi
      .fn<[], Promise<{ stories: any[]; totalStories: number; totalScenes: number }>>()
      .mockResolvedValue({ stories: [], totalStories: 0, totalScenes: 0 }),

    // Evolution
    evolutionStatus: vi
      .fn<[], Promise<{ lastRun: number | null; consecutiveFailures: number; isBusy: boolean }>>()
      .mockResolvedValue({ lastRun: null, consecutiveFailures: 0, isBusy: false }),
    evolutionTrigger: vi.fn<[], Promise<{ success: boolean; error?: string }>>().mockResolvedValue({ success: true }),

    // ── 快捷任务编排（QuickTask） ──
    getQuickTasks: vi
      .fn<[], Promise<{ success: boolean; tasks: any[]; error?: string }>>()
      .mockResolvedValue({ success: true, tasks: [] }),
    quickTaskRecommendNow: vi
      .fn<[], Promise<{ success: boolean; tasks: any[]; error?: string }>>()
      .mockResolvedValue({ success: true, tasks: [] }),
    quickTaskExecute: vi
      .fn<[string], Promise<{ success: boolean; task?: any; error?: string }>>()
      .mockResolvedValue({ success: true }),
    quickTaskDismiss: vi
      .fn<[string], Promise<{ success: boolean; task?: any; error?: string }>>()
      .mockResolvedValue({ success: true }),
    quickTaskSnooze: vi
      .fn<[string], Promise<{ success: boolean; task?: any; error?: string }>>()
      .mockResolvedValue({ success: true }),
    quickTaskEdit: vi
      .fn<[string, Array<{ tool: string; label: string; args?: Record<string, unknown> }>], Promise<{ success: boolean; task?: any; error?: string }>>()
      .mockResolvedValue({ success: true }),
    getQuickTaskSnapshot: vi
      .fn<[], Promise<{ success: boolean; snapshot?: any; error?: string }>>()
      .mockResolvedValue({ success: true, snapshot: null }),
    quickTaskSetSensitivity: vi
      .fn<[number], Promise<{ success: boolean; error?: string }>>()
      .mockResolvedValue({ success: true }),
    quickTaskAnalyze: vi
      .fn<[], Promise<{ success: boolean; tasks: any[]; error?: string }>>()
      .mockResolvedValue({ success: true, tasks: [] }),
    quickTaskStart: vi
      .fn<[], Promise<{ success: boolean; error?: string }>>()
      .mockResolvedValue({ success: true }),
    quickTaskStop: vi
      .fn<[], Promise<{ success: boolean; error?: string }>>()
      .mockResolvedValue({ success: true }),
    onQuickTaskRecommend: vi.fn<[(data: { tasks: any[]; timestamp: number }) => void], () => void>().mockReturnValue(vi.fn()),
    onQuickTaskUpdate: vi.fn<[(data: { task: any; action: string; timestamp: number }) => void], () => void>().mockReturnValue(vi.fn()),
  }

  return { ...mock, ...overrides } as MockedElectronAPI
}
