/**
 * LocalModelService — 用 transformers.js 在进程内跑小模型
 *
 * 零外部依赖，进程内运行，不需要 Ollama/Python/独立服务。
 * 懒加载，优先加载项目目录下的模型文件（models/Xenova/...），
 * 不存在则从 HuggingFace 下载。
 *
 * 已下载模型位置：
 *   models/Xenova/Qwen2.5-0.5B-Instruct/
 *
 * 环境变量：
 *   LOCAL_HYPOTHESIS_MODEL   — 模型 ID (默认 Xenova/Qwen2.5-0.5B-Instruct)
 *   LOCAL_HYPOTHESIS_DISABLED — 设为 'true' 禁用本地模型
 *   MODEL_CACHE_DIR           — 缓存目录，缺省自动探测
 */
export declare class LocalModelService {
    private generator;
    private loadAttempted;
    private modelId;
    constructor(modelId?: string);
    get isEnabled(): boolean;
    get isLoaded(): boolean;
    /**
     * 生成文本 — 兼容 chatJson 接口格式
     */
    generate(userText: string, options?: {
        system?: string;
        temperature?: number;
        maxTokens?: number;
    }): Promise<{
        data?: any;
        error?: string;
    }>;
    /**
     * 尝试从生成文本中提取 JSON
     */
    private tryParse;
}
