import { AsrResult } from './types';
export declare class WhisperGpuEngine {
    private modelPath;
    private loaded;
    initialize(model?: string): Promise<void>;
    transcribe(pcmf32: Float32Array, timeoutMs?: number): Promise<AsrResult>;
    getStatus(): {
        loaded: boolean;
        loading: boolean;
        error: string | null;
    };
    getModelInfo(): string;
}
