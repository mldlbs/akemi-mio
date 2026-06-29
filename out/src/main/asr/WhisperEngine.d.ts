import { AsrResult, ProgressCallback, HotwordHit } from './types';
/**
 * 对中文热词使用拼音模糊匹配，对英文热词使用大小写不敏感精确匹配。
 * 返回所有命中的热词及出现次数，并用正确拼写替换原文。
 */
export declare function applyHotwords(text: string): {
    text: string;
    hits: HotwordHit[];
};
export declare class WhisperEngine {
    private transcribeFn;
    private loading;
    private loadError;
    private loadPromise;
    private currentModel;
    private firstInferenceDone;
    private initialPrompt;
    initialize(model?: string, onProgress?: ProgressCallback): Promise<void>;
    private _doInit;
    private _createPipeline;
    setInitialPrompt(prompt: string): void;
    private _createTranscriber;
    private _logInitComplete;
    transcribe(audioBuffer: Float32Array, timeoutMs?: number, requestId?: string): Promise<AsrResult & {
        request_id: string;
    }>;
    getStatus(): {
        loaded: boolean;
        loading: boolean;
        error: string | null;
    };
    getModelInfo(): string;
}
