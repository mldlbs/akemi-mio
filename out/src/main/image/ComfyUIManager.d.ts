/**
 * ComfyUIManager — ComfyUI 子进程 / HTTP API 管理器
 *
 * 职责：
 * - 管理 ComfyUI 进程生命周期（启动/停止/健康检查）
 * - 提供 generate() API 供 ImageGenerationTool 调用
 * - 管理 FLUX.1-schnell workflow 加载
 * - GPU 资源协调（检测 ASR 是否正在使用 GPU）
 */
export interface ComfyUIGenerateOptions {
    prompt: string;
    negativePrompt?: string;
    width?: number;
    height?: number;
    seed?: number;
    /** LoadImage 节点的图片文件名（放于 ComfyUI input/ 目录） */
    refImage?: string;
}
export interface ComfyUIGenerateResult {
    success: true;
    imagePath: string;
    seed: number;
    elapsedMs: number;
}
export interface ComfyUIConfig {
    /** ComfyUI 根目录，默认读取环境变量 COMFYUI_ROOT 或 %APPDATA%/akemi-mio/comfyui */
    root: string;
    /** ComfyUI HTTP API 端口 */
    port: number;
    /** 进程启动超时（ms） */
    startupTimeoutMs: number;
    /** 生成超时（ms） */
    generateTimeoutMs: number;
    /** 自动重启：进程崩溃后是否自动重启 */
    autoRestart: boolean;
}
export declare class ComfyUIManager {
    private config;
    private process;
    private ready;
    private starting;
    private healthy;
    private healthCheckTimer;
    private restartAttempts;
    private readonly MAX_RESTART_ATTEMPTS;
    private outputsDir;
    constructor(config?: Partial<ComfyUIConfig>);
    get isReady(): boolean;
    get isHealthy(): boolean;
    start(): Promise<void>;
    stop(): Promise<void>;
    generate(opts: ComfyUIGenerateOptions): Promise<ComfyUIGenerateResult>;
    private onReady;
    private startHealthCheck;
    private stopHealthCheck;
    private pollResult;
    private loadWorkflow;
    private overrideWorkflowPrompt;
    private buildDefaultWorkflow;
}
