import { type ReactNode } from 'react';
import type { AgentState } from '../hooks/useAIOutput';
interface InputBarProps {
    onSend: (text: string) => void;
    /** Renders before the textarea */
    voiceSlot?: ReactNode;
    agentState?: AgentState;
}
export declare function InputBar({ onSend, voiceSlot, agentState }: InputBarProps): import("react/jsx-runtime").JSX.Element;
export {};
