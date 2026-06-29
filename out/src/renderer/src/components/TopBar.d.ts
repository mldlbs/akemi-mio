import type { ReactNode } from 'react';
import type { AgentState } from '../hooks/useAIOutput';
interface TopBarProps {
    conversationActive: boolean;
    ttsPlaying?: boolean;
    error?: string;
    sessionHealth?: string;
    personaLevel?: string;
    /** Agent window toggle button — renders into actions area if provided */
    agentSlot?: ReactNode;
    onOpenSettings?: () => void;
    agentState?: AgentState;
}
export declare function TopBar({ conversationActive, ttsPlaying, error, sessionHealth, personaLevel, agentSlot, onOpenSettings, agentState, }: TopBarProps): import("react/jsx-runtime").JSX.Element;
export {};
