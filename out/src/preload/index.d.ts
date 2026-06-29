declare const electronAPI: {
    closeWindow: () => Promise<{
        success: boolean;
    }>;
    transcribe: (audio: ArrayBuffer) => Promise<{
        text: string;
        request_id?: string;
        error?: string;
    }>;
    chat: (text: string, requestId?: string, sessionId?: string, noTts?: boolean) => Promise<{
        reply?: string;
        error?: string;
    }>;
    speak: (text: string) => Promise<void>;
    stopSpeaking: () => Promise<void>;
    stopConversation: () => Promise<{
        success: boolean;
    }>;
    getState: () => Promise<{
        asr: string;
        error?: string;
    }>;
    getWakeWords: () => Promise<string[]>;
    onStateUpdate: (callback: (state: Record<string, unknown>) => void) => () => void;
    onAIChunk: (callback: (text: string) => void) => () => void;
    onTTSAudio: (callback: (filePath: string) => void) => () => void;
    onTTSBuffer: (callback: (buffer: ArrayBuffer) => void) => () => void;
    onToolStatus: (callback: (status: {
        type: string;
        tool: string;
        message: string;
    }) => void) => () => void;
    getCredential: (key: string) => Promise<string | null>;
    setCredential: (key: string, value: string) => Promise<true>;
    deleteCredential: (key: string) => Promise<true>;
    getMessageHistory: (limit?: number) => Promise<{
        id: string;
        source: string;
        role: string;
        content: string;
        category: string;
        sessionId?: string;
        createdAt: number;
    }[]>;
    getSessions: () => Promise<{
        id: string;
        source: string;
        category: string;
        label: string;
        messageCount: number;
        lastActivityAt: number;
        createdAt: number;
    }[]>;
    getMessagesBySession: (sessionId: string) => Promise<{
        id: string;
        source: string;
        role: string;
        content: string;
        category: string;
        sessionId?: string;
        createdAt: number;
    }[]>;
    onMessageNew: (callback: (msg: {
        id: string;
        source: string;
        role: string;
        content: string;
        category: string;
        sessionId?: string;
        createdAt: number;
    }) => void) => () => void;
    checkUpdate: () => Promise<{
        available: boolean;
        version?: string;
        error?: string;
    }>;
    downloadUpdate: () => Promise<{
        success: boolean;
        error?: string;
    }>;
    installUpdate: () => Promise<{
        success: boolean;
    }>;
    onUpdateStatus: (callback: (status: Record<string, unknown>) => void) => () => void;
    onToolInvoked: (callback: (data: {
        tool: string;
        args: Record<string, any>;
        id: string;
    }) => void) => () => Electron.IpcRenderer;
    onToolCompleted: (callback: (data: {
        tool: string;
        result: string;
        id: string;
        latencyMs: number;
    }) => void) => () => Electron.IpcRenderer;
    onToolFailed: (callback: (data: {
        tool: string;
        error: string;
        id: string;
        latencyMs: number;
    }) => void) => () => Electron.IpcRenderer;
    onPlanCreated: (callback: (data: {
        planId: string;
        title: string;
    }) => void) => () => Electron.IpcRenderer;
    onPlanStep: (callback: (data: {
        planId: string;
        stepIndex: number;
        status: string;
    }) => void) => () => Electron.IpcRenderer;
    onPlanCompleted: (callback: (data: {
        planId: string;
    }) => void) => () => Electron.IpcRenderer;
    onAgentObserve: (callback: (data: {
        requestId: string;
        step: number;
        proceduresFound: number;
        patternsFound: number;
        durationMs: number;
    }) => void) => () => Electron.IpcRenderer;
    onAgentThink: (callback: (data: {
        requestId: string;
        step: number;
        toolCallCount: number;
        strategyPrompted: boolean;
    }) => void) => () => Electron.IpcRenderer;
    onAgentReflect: (callback: (data: {
        requestId: string;
        step: number;
        toolResults: number;
        successCount: number;
        summary: string;
        durationMs: number;
    }) => void) => () => Electron.IpcRenderer;
    onInputReceived: (callback: (data: {
        text: string;
        requestId: string;
        source: string;
    }) => void) => () => Electron.IpcRenderer;
    onResponseGenerated: (callback: (data: {
        text: string;
        requestId: string;
        source: string;
    }) => void) => () => Electron.IpcRenderer;
    onGuardrail: (callback: (data: {
        type: string;
    } & Record<string, any>) => void) => () => Electron.IpcRenderer;
    onBudgetExhausted: (callback: (data: {
        resource: string;
        utilization: number;
    }) => void) => () => Electron.IpcRenderer;
    onBudgetRestored: (callback: (data: {
        resource: string;
        utilization: number;
    }) => void) => () => Electron.IpcRenderer;
    onAgentError: (callback: (data: {
        error: string;
        requestId: string;
    }) => void) => () => Electron.IpcRenderer;
    onWorkflowRunCreated: (callback: (data: {
        runId: string;
        workflowDefId: string;
    }) => void) => () => Electron.IpcRenderer;
    onWorkflowRunUpdated: (callback: (data: {
        runId: string;
        status: string;
    }) => void) => () => Electron.IpcRenderer;
    onWorkflowRunStep: (callback: (data: {
        runId: string;
        stepId: string;
        status: string;
    }) => void) => () => Electron.IpcRenderer;
    getActivePlan: () => Promise<{
        id: string;
        title: string;
        description: string;
        steps: {
            id: string;
            description: string;
            status: string;
            result?: string;
        }[];
        status: string;
        createdAt: number;
        updatedAt: number;
    } | null>;
    listPlans: () => Promise<{
        id: string;
        title: string;
        description: string;
        steps: {
            id: string;
            description: string;
            status: string;
            result?: string;
        }[];
        status: string;
        createdAt: number;
        updatedAt: number;
    }[]>;
    openAgentWindow: () => Promise<{
        success: boolean;
        error?: string;
    }>;
    closeAgentWindow: () => Promise<{
        success: boolean;
    }>;
    onPersonaUpdated: (callback: (data: {
        level: string;
    }) => void) => () => Electron.IpcRenderer;
    listWorkflowDefinitions: () => Promise<any[]>;
    getWorkflowDefinition: (id: string) => Promise<any>;
    listWorkflowRuns: (limit?: number) => Promise<any[]>;
    getWorkflowRun: (runId: string) => Promise<any>;
    deleteWorkflowDefinition: (id: string) => Promise<{
        success: boolean;
    }>;
    saveWorkflowDefinition: (def: any) => Promise<{
        success: boolean;
    }>;
    startWorkflow: (id: string) => Promise<{
        success: boolean;
        runId?: string;
        error?: string;
    }>;
    getWritingStatus: () => Promise<{
        stories: any[];
        totalStories: number;
        totalScenes: number;
    }>;
};
export type ElectronAPI = typeof electronAPI;
export {};
