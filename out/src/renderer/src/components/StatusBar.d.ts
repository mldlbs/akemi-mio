import type { AgentState } from '../hooks/useAIOutput';
interface StatusBarProps {
    conversationActive: boolean;
    ttsPlaying?: boolean;
    error?: string;
    sessionHealth?: string;
    personaLevel?: string;
    agentState?: AgentState;
}
export declare function StatusBar({ conversationActive, ttsPlaying, error, sessionHealth, personaLevel, agentState }: StatusBarProps): import("react/jsx-runtime").JSX.Element;
export {};
