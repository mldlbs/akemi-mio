export type AgentState = 'idle' | 'thinking' | 'tool_executing' | 'replying';
export declare function useAIOutput(activeSessionId: string, voiceActive: boolean, onError?: (err: string | undefined) => void): {
    readonly pendingText: string;
    readonly displayText: string;
    readonly transcribed: string;
    readonly toolStatus: {
        type: string;
        tool: string;
        message: string;
    } | null;
    readonly agentState: AgentState;
    readonly handleResult: (t: string) => Promise<void>;
};
