interface VoiceInputProps {
    onResult: (text: string, requestId?: string) => void;
    disabled?: boolean;
    onConversationChange?: (active: boolean) => void;
    ttsPlaying?: boolean;
    onWakeWord?: () => void;
}
export declare function VoiceInput({ onResult, disabled, onConversationChange, ttsPlaying, onWakeWord }: VoiceInputProps): import("react/jsx-runtime").JSX.Element;
export {};
