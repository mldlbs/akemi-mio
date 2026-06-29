import type { MessageItem, ToolEvent } from '../slots/types';
import type { AgentState } from '../hooks/useAIOutput';
interface ChatSlotProps {
    messages: MessageItem[];
    pendingText?: string;
    displayText?: string;
    transcribed?: string;
    toolStatus: {
        type: string;
        tool: string;
        message: string;
    } | null;
    agentState: AgentState;
    toolRunning: ToolEvent[];
    toolCompleted: ToolEvent[];
    historyLoading?: boolean;
}
export declare function ChatSlot({ messages, pendingText, displayText, transcribed, toolStatus, agentState, toolRunning, toolCompleted, historyLoading, }: ChatSlotProps): import("react/jsx-runtime").JSX.Element;
export {};
