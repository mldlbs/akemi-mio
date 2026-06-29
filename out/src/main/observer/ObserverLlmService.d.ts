export interface ObserverGenerateOptions {
    system?: string;
    temperature?: number;
    maxTokens?: number;
}
/**
 * ObserverLlmService — 通过 Ollama REST API 调 Qwen2.5-7B
 *
 * 假设本地已装 Ollama 且有 qwen2.5:7b 模型。
 * 不需要安装任何 npm 包。
 */
export declare class ObserverLlmService {
    private loaded;
    get isLoaded(): boolean;
    initialize(): Promise<void>;
    generate(prompt: string, options?: ObserverGenerateOptions): Promise<{
        data?: string;
        error?: string;
    }>;
    generateJson<T>(prompt: string, options?: ObserverGenerateOptions): Promise<{
        data?: T;
        error?: string;
    }>;
    dispose(): void;
}
