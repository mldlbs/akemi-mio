import { vi, type Mock } from 'vitest'
import type { ElectronAPI } from '../../../preload/index'

type MockedElectronAPI = {
  [K in keyof ElectronAPI]: ElectronAPI[K] extends (...args: infer A) => infer R ? Mock<(...args: A) => R> : ElectronAPI[K]
}

/**
 * 桩是不完整的：ElectronAPI 约 208 个键，本对象只覆盖测试实际用到的子集，其余方法
 * 在运行时并不存在（需要时通过 overrides 补）。字面量因此按 Partial 标注，返回值仍
 * 声明为完整的 MockedElectronAPI —— 这是有意的逃生舱，不是遗漏。
 *
 * 注：TS 在存在逐属性失配时会优先报 TS2322 而不报缺键，所以这个真实缺口长期被掩盖；
 * 把失配全部修好之后才浮出来（见本轮 tsc-web 日志）。
 */
export function createMockIPC(overrides?: Partial<MockedElectronAPI>): MockedElectronAPI {
  const mock: Partial<MockedElectronAPI> = {
    // Window
    closeWindow: vi.fn<(...args: []) => Promise<{ success: boolean }>>().mockResolvedValue({ success: true }),
    minimizeWindow: vi.fn<(...args: []) => Promise<{ success: boolean }>>().mockResolvedValue({ success: true }),
    maximizeWindow: vi
      .fn<(...args: []) => Promise<{ success: boolean; isMaximized: boolean }>>()
      .mockResolvedValue({ success: true, isMaximized: false }),
    isMaximized: vi.fn<(...args: []) => Promise<{ isMaximized: boolean }>>().mockResolvedValue({ isMaximized: false }),
    toggleFullscreen: vi
      .fn<(...args: []) => Promise<{ success: boolean; isFullScreen: boolean }>>()
      .mockResolvedValue({ success: true, isFullScreen: false }),

    // ASR / AI / TTS
    transcribe: vi.fn<(...args: [ArrayBuffer]) => Promise<{ text: string; request_id?: string; error?: string }>>().mockResolvedValue({ text: '' }),
    chat: vi
      .fn<(...args: [string, string?, string?, boolean?]) => Promise<{ reply?: string; error?: string }>>()
      .mockResolvedValue({ reply: 'Hello from mock' }),
    speak: vi.fn<(...args: [string]) => Promise<void>>().mockResolvedValue(undefined),
    stopSpeaking: vi.fn<(...args: []) => Promise<void>>().mockResolvedValue(undefined),
    stopConversation: vi.fn<(...args: []) => Promise<{ success: boolean }>>().mockResolvedValue({ success: true }),
    getState: vi.fn<(...args: []) => Promise<{ asr: string; error?: string }>>().mockResolvedValue({ asr: 'idle' }),
    getWakeWords: vi.fn<(...args: []) => Promise<string[]>>().mockResolvedValue(['澪', 'mio']),

    // ASR hotwords & vocabulary
    toggleAsrHotwords: vi.fn<(...args: [boolean]) => Promise<{ enabled: boolean }>>().mockResolvedValue({ enabled: true }),
    getAsrHotwordState: vi
      .fn<(...args: []) => Promise<{ enabled: boolean; entryCount: number; hotwords: string[]; totalInputs: number }>>()
      .mockResolvedValue({ enabled: true, entryCount: 0, hotwords: [], totalInputs: 0 }),

    getVocabState: vi
      .fn<(...args: []) => Promise<{
          words: Array<{ word: string; count: number; domain: string; lastSeen: number; firstSeen: number }>
          domainStats: Array<{ label: string; count: number }>
          totalWords: number
          enabled: boolean
        }>>()
      .mockResolvedValue({ words: [], domainStats: [], totalWords: 0, enabled: true }),

    deleteVocabWord: vi.fn<(...args: [string]) => Promise<{ success: boolean }>>().mockResolvedValue({ success: true }),

    clearVocabData: vi.fn<(...args: []) => Promise<{ success: boolean }>>().mockResolvedValue({ success: true }),

    refreshVocabContext: vi.fn<(...args: []) => Promise<{ success: boolean; error?: string }>>().mockResolvedValue({ success: true }),

    // Voice orchestration
    matchVoiceIntent: vi
      .fn<(...args: [string]) => Promise<{
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
        }>>()
      .mockResolvedValue({ matched: false }),
    executeVoiceChain: vi
      .fn<(...args: [string, Record<string, string>]) => Promise<{
          success: boolean
          steps: Array<{ tool: string; success: boolean; output: string; error?: string; durationMs: number }>
          summary: string
        }>>()
      .mockResolvedValue({ success: true, steps: [], summary: 'mock voice chain complete' }),

    // Wallpaper / overlay helpers used by App-mounted components
    getSubtitleEnabled: vi.fn<(...args: []) => Promise<{ enabled: boolean }>>().mockResolvedValue({ enabled: true }),
    onSubtitleToggle: vi.fn<(...args: [(data: { enabled: boolean }) => void]) => () => void>().mockReturnValue(vi.fn()),
    onTtsSubtitle: vi
      .fn<(...args: [(data: { text: string; estimatedDurationMs: number; id: string; startTime: number }) => void]) => () => void>()
      .mockReturnValue(vi.fn()),
    // 以下三条改为用 ElectronAPI 自身派生泛型：手写类型一旦与 preload 契约脱节就会
    // 在这里报错（曾经就是如此），派生后契约漂移会立刻暴露而非静默失配。
    getBehaviorTopActions: vi
      .fn<ElectronAPI['getBehaviorTopActions']>()
      .mockResolvedValue({ success: true, actions: [], timestamp: 0 }),
    onBehaviorTopActions: vi.fn<ElectronAPI['onBehaviorTopActions']>().mockReturnValue(vi.fn()),
    invokeDesktopTool: vi.fn<(...args: [string, Record<string, unknown>]) => Promise<{ success: boolean }>>().mockResolvedValue({ success: true }),
    onBehaviorState: vi.fn<ElectronAPI['onBehaviorState']>().mockReturnValue(vi.fn()),
    getWallpaperConfig: vi.fn<ElectronAPI['getWallpaperConfig']>().mockResolvedValue({
      enabled: false,
      idleOverlay: false,
      adaptiveOpacity: false,
      normalOpacity: 1,
      codeOpacity: 1,
      fullscreenOpacity: 1,
      idleOpacity: 1,
      evoLocked: false,
    }),

    // 工具参数组合智能默认值。ToolSlot 只要存在 success 态工具就会挂载
    // ToolParamSuggestions，其 useEffect 立即调用 getToolParamDefaults —— 之前这里缺桩，
    // 导致任何「有成功工具」的渲染用例都抛 TypeError（失败/取消/超时用例不触发，故长期只有
    // 部分用例红）。recordToolParamFeedback 只在用户点击采纳时调用，一并补上防后续踩坑。
    getToolParamDefaults: vi
      .fn<ElectronAPI['getToolParamDefaults']>()
      .mockResolvedValue({ success: true, combinations: [] }),
    recordToolParamFeedback: vi
      .fn<ElectronAPI['recordToolParamFeedback']>()
      .mockResolvedValue({ success: true }),

    // Events (main -> renderer push)
    onStateUpdate: vi.fn<(...args: [(state: Record<string, unknown>) => void]) => () => void>().mockReturnValue(vi.fn()),
    onAIChunk: vi.fn<(...args: [(text: string) => void]) => () => void>().mockReturnValue(vi.fn()),
    onTTSAudio: vi.fn<(...args: [(filePath: string) => void]) => () => void>().mockReturnValue(vi.fn()),
    onTTSBuffer: vi.fn<(...args: [(buffer: ArrayBuffer) => void]) => () => void>().mockReturnValue(vi.fn()),
    onToolStatus: vi.fn<(...args: [(status: { type: string; tool: string; message: string }) => void]) => () => void>().mockReturnValue(vi.fn()),
    onMessageNew: vi
      .fn<(...args: [
          (msg: {
            id: string
            source: string
            role: string
            content: string
            category: string
            sessionId?: string
            createdAt: number
          }) => void,
        ]) => () => void>()
      .mockReturnValue(vi.fn()),

    // Credentials
    getCredential: vi.fn<(...args: [string]) => Promise<string | null>>().mockResolvedValue(null),
    getAllCredentials: vi.fn<(...args: []) => Promise<Record<string, string>>>().mockResolvedValue({}),
    setCredential: vi.fn<(...args: [string, string]) => Promise<true>>().mockResolvedValue(true as const),
    deleteCredential: vi.fn<(...args: [string]) => Promise<true>>().mockResolvedValue(true as const),

    // Message/session
    getMessageHistory: vi
      .fn<(...args: [number?]) => Promise<{ id: string; source: string; role: string; content: string; category: string; sessionId?: string; createdAt: number }[]>>()
      .mockResolvedValue([]),
    getSessions: vi
      .fn<(...args: []) => Promise<
          { id: string; source: string; category: string; label: string; messageCount: number; lastActivityAt: number; createdAt: number }[]
        >>()
      .mockResolvedValue([]),
    getMessagesBySession: vi
      .fn<(...args: [string]) => Promise<{ id: string; source: string; role: string; content: string; category: string; sessionId?: string; createdAt: number }[]>>()
      .mockResolvedValue([]),

    // Auto-update
    checkUpdate: vi.fn<(...args: []) => Promise<{ available: boolean; version?: string; error?: string }>>().mockResolvedValue({ available: false }),
    downloadUpdate: vi.fn<(...args: []) => Promise<{ success: boolean; error?: string }>>().mockResolvedValue({ success: true }),
    installUpdate: vi.fn<(...args: []) => Promise<{ success: boolean }>>().mockResolvedValue({ success: true }),
    onUpdateStatus: vi.fn<(...args: [(status: Record<string, unknown>) => void]) => () => void>().mockReturnValue(vi.fn()),

    // Coding Agent UI — tool events
    onToolInvoked: vi.fn<(...args: [(data: { tool: string; args: Record<string, any>; id: string }) => void]) => () => void>().mockReturnValue(vi.fn()),
    onToolCompleted: vi
      .fn<(...args: [(data: { tool: string; result: string; id: string; latencyMs: number }) => void]) => () => void>()
      .mockReturnValue(vi.fn()),
    onToolFailed: vi
      .fn<(...args: [(data: { tool: string; error: string; id: string; latencyMs: number }) => void]) => () => void>()
      .mockReturnValue(vi.fn()),

    // Plan events
    onPlanCreated: vi.fn<(...args: [(data: { planId: string; title: string }) => void]) => () => void>().mockReturnValue(vi.fn()),
    onPlanStep: vi.fn<(...args: [(data: { planId: string; stepIndex: number; status: string }) => void]) => () => void>().mockReturnValue(vi.fn()),
    onPlanCompleted: vi.fn<(...args: [(data: { planId: string }) => void]) => () => void>().mockReturnValue(vi.fn()),

    // OTPAR
    onAgentObserve: vi
      .fn<(...args: [(data: { requestId: string; step: number; proceduresFound: number; patternsFound: number; durationMs: number }) => void]) => () => void>()
      .mockReturnValue(vi.fn()),
    onAgentThink: vi
      .fn<(...args: [(data: { requestId: string; step: number; toolCallCount: number; strategyPrompted: boolean }) => void]) => () => void>()
      .mockReturnValue(vi.fn()),
    onAgentReflect: vi
      .fn<(...args: [
          (data: {
            requestId: string
            step: number
            toolResults: number
            successCount: number
            summary: string
            durationMs: number
          }) => void,
        ]) => () => void>()
      .mockReturnValue(vi.fn()),

    // Input/output
    onInputReceived: vi.fn<(...args: [(data: { text: string; requestId: string; source: string }) => void]) => () => void>().mockReturnValue(vi.fn()),
    onResponseGenerated: vi
      .fn<(...args: [(data: { text: string; requestId: string; source: string }) => void]) => () => void>()
      .mockReturnValue(vi.fn()),

    // Guardrail & error
    onGuardrail: vi.fn<(...args: [(data: { type: string } & Record<string, any>) => void]) => () => void>().mockReturnValue(vi.fn()),
    onBudgetExhausted: vi.fn<(...args: [(data: { resource: string; utilization: number }) => void]) => () => void>().mockReturnValue(vi.fn()),
    onBudgetRestored: vi.fn<(...args: [(data: { resource: string; utilization: number }) => void]) => () => void>().mockReturnValue(vi.fn()),
    onAgentError: vi.fn<(...args: [(data: { error: string; requestId: string }) => void]) => () => void>().mockReturnValue(vi.fn()),
    onPersonaUpdated: vi.fn<(...args: [(data: { level: string }) => void]) => () => void>().mockReturnValue(vi.fn()),

    // Workflow events
    onWorkflowRunCreated: vi.fn<(...args: [(data: { runId: string; workflowDefId: string }) => void]) => () => void>().mockReturnValue(vi.fn()),
    onWorkflowRunUpdated: vi.fn<(...args: [(data: { runId: string; status: string }) => void]) => () => void>().mockReturnValue(vi.fn()),
    onWorkflowRunStep: vi
      .fn<(...args: [(data: { runId: string; stepId: string; status: string; agentResult?: string }) => void]) => () => void>()
      .mockReturnValue(vi.fn()),
    onWorkflowDefCreated: vi.fn<(...args: [(data: { workflowDefId: string }) => void]) => () => void>().mockReturnValue(vi.fn()),

    // Agent plans (invoke)
    getActivePlan: vi
      .fn<(...args: []) => Promise<{
          id: string
          title: string
          description: string
          steps: { id: string; description: string; status: string; result?: string }[]
          status: string
          createdAt: number
          updatedAt: number
        } | null>>()
      .mockResolvedValue(null),
    listPlans: vi
      .fn<(...args: []) => Promise<
          {
            id: string
            title: string
            description: string
            steps: { id: string; description: string; status: string; result?: string }[]
            status: string
            createdAt: number
            updatedAt: number
          }[]
        >>()
      .mockResolvedValue([]),
    openAgentWindow: vi.fn<(...args: []) => Promise<{ success: boolean; error?: string }>>().mockResolvedValue({ success: true }),
    closeAgentWindow: vi.fn<(...args: []) => Promise<{ success: boolean }>>().mockResolvedValue({ success: true }),

    // Workflow definitions & runs (invoke)
    listWorkflowDefinitions: vi.fn<(...args: []) => Promise<any[]>>().mockResolvedValue([]),
    getWorkflowDefinition: vi.fn<(...args: [string]) => Promise<any>>().mockResolvedValue(null),
    listWorkflowRuns: vi.fn<(...args: [number?]) => Promise<any[]>>().mockResolvedValue([]),
    getWorkflowRun: vi.fn<(...args: [string]) => Promise<any>>().mockResolvedValue(null),
    deleteWorkflowDefinition: vi.fn<(...args: [string]) => Promise<{ success: boolean }>>().mockResolvedValue({ success: true }),
    saveWorkflowDefinition: vi.fn<(...args: [any]) => Promise<{ success: boolean }>>().mockResolvedValue({ success: true }),
    startWorkflow: vi
      .fn<(...args: [string]) => Promise<{ success: boolean; runId?: string; error?: string }>>()
      .mockResolvedValue({ success: true, runId: 'mock-run-1' }),
    enableWorkflowDefinition: vi.fn<(...args: [string]) => Promise<{ success: boolean; error?: string }>>().mockResolvedValue({ success: true }),
    disableWorkflowDefinition: vi.fn<(...args: [string]) => Promise<{ success: boolean; error?: string }>>().mockResolvedValue({ success: true }),
    stopWorkflowRun: vi.fn<(...args: [string]) => Promise<{ success: boolean; error?: string }>>().mockResolvedValue({ success: true }),
    duplicateWorkflowDefinition: vi.fn<(...args: [string]) => Promise<{ success: boolean; error?: string }>>().mockResolvedValue({ success: true }),
    deleteWorkflowRun: vi.fn<(...args: [string]) => Promise<{ success: boolean; error?: string }>>().mockResolvedValue({ success: true }),
    approveGate: vi
      .fn<(...args: [string, string, string, string?]) => Promise<{ success: boolean; error?: string }>>()
      .mockResolvedValue({ success: true }),

    // 隐式反馈驱动的语音自适应
    recordImplicitFeedback: vi.fn<(...args: [string]) => Promise<{ success: boolean; error?: string }>>().mockResolvedValue({ success: true }),
    toggleImplicitFeedback: vi
      .fn<(...args: [boolean]) => Promise<{ success: boolean; enabled: boolean }>>()
      .mockResolvedValue({ success: true, enabled: true }),
    getImplicitFeedbackState: vi
      .fn<(...args: []) => Promise<{
          success: boolean
          enabled: boolean
          recommendation: Record<string, unknown> | null
          status: { modelInitialized: boolean; totalSamples: number; historySize: number }
        }>>()
      .mockResolvedValue({
        success: true,
        enabled: true,
        recommendation: null,
        status: { modelInitialized: false, totalSamples: 0, historySize: 0 },
      }),
    triggerImplicitFeedbackUpdate: vi.fn<(...args: []) => Promise<{ success: boolean }>>().mockResolvedValue({ success: true }),
    resetImplicitFeedback: vi.fn<(...args: []) => Promise<{ success: boolean }>>().mockResolvedValue({ success: true }),
    onImplicitFeedbackEnabled: vi.fn<(...args: [(data: { enabled: boolean }) => void]) => () => void>().mockReturnValue(vi.fn()),

    // Writing
    getWritingStatus: vi
      .fn<(...args: []) => Promise<{ stories: any[]; totalStories: number; totalScenes: number }>>()
      .mockResolvedValue({ stories: [], totalStories: 0, totalScenes: 0 }),

    // Evolution
    evolutionStatus: vi
      .fn<(...args: []) => Promise<{ lastRun: number | null; consecutiveFailures: number; isBusy: boolean }>>()
      .mockResolvedValue({ lastRun: null, consecutiveFailures: 0, isBusy: false }),
    evolutionTrigger: vi.fn<(...args: []) => Promise<{ success: boolean; error?: string }>>().mockResolvedValue({ success: true }),

    // ── 快捷任务编排（QuickTask） ──
    getQuickTasks: vi.fn<(...args: []) => Promise<{ success: boolean; tasks: any[]; error?: string }>>().mockResolvedValue({ success: true, tasks: [] }),
    quickTaskRecommendNow: vi
      .fn<(...args: []) => Promise<{ success: boolean; tasks: any[]; error?: string }>>()
      .mockResolvedValue({ success: true, tasks: [] }),
    quickTaskExecute: vi.fn<(...args: [string]) => Promise<{ success: boolean; task?: any; error?: string }>>().mockResolvedValue({ success: true }),
    quickTaskDismiss: vi.fn<(...args: [string]) => Promise<{ success: boolean; task?: any; error?: string }>>().mockResolvedValue({ success: true }),
    quickTaskSnooze: vi.fn<(...args: [string]) => Promise<{ success: boolean; task?: any; error?: string }>>().mockResolvedValue({ success: true }),
    quickTaskEdit: vi
      .fn<(...args: [string, Array<{ tool: string; label: string; args?: Record<string, unknown> }>]) => Promise<{ success: boolean; task?: any; error?: string }>>()
      .mockResolvedValue({ success: true }),
    getQuickTaskSnapshot: vi
      .fn<(...args: []) => Promise<{ success: boolean; snapshot?: any; error?: string }>>()
      .mockResolvedValue({ success: true, snapshot: null }),
    quickTaskSetSensitivity: vi.fn<(...args: [number]) => Promise<{ success: boolean; error?: string }>>().mockResolvedValue({ success: true }),
    quickTaskAnalyze: vi
      .fn<(...args: []) => Promise<{ success: boolean; tasks: any[]; error?: string }>>()
      .mockResolvedValue({ success: true, tasks: [] }),
    quickTaskStart: vi.fn<(...args: []) => Promise<{ success: boolean; error?: string }>>().mockResolvedValue({ success: true }),
    quickTaskStop: vi.fn<(...args: []) => Promise<{ success: boolean; error?: string }>>().mockResolvedValue({ success: true }),
    onQuickTaskRecommend: vi.fn<(...args: [(data: { tasks: any[]; timestamp: number }) => void]) => () => void>().mockReturnValue(vi.fn()),

    onQuickTaskUpdate: vi.fn<(...args: [(data: { task: any; action: string; timestamp: number }) => void]) => () => void>().mockReturnValue(vi.fn()),
    getProjectRoots: vi.fn<(...args: []) => Promise<{ roots: string[]; active: string }>>().mockResolvedValue({ roots: [], active: '' }),
    addProjectRoot: vi.fn<(...args: [string]) => Promise<{ success: boolean; error?: string }>>().mockResolvedValue({ success: true }),
    removeProjectRoot: vi.fn<(...args: [string]) => Promise<{ success: boolean; error?: string }>>().mockResolvedValue({ success: true }),
    setActiveProjectRoot: vi.fn<(...args: [string]) => Promise<{ success: boolean; error?: string }>>().mockResolvedValue({ success: true }),
    selectProjectRootDialog: vi.fn<(...args: []) => Promise<string | null>>().mockResolvedValue(null),
  }

  return { ...mock, ...overrides } as MockedElectronAPI
}
