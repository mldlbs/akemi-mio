/**
 * AppRuntime — 应用启动生命周期编排器。
 * 封装 index.ts 中原本的模块级初始化逻辑，提供清晰的启动阶段。
 */
export declare class AppRuntime {
    private subs;
    private taskRunner?;
    private lazyInit?;
    private gpuInitTimeout?;
    private memoryService?;
    private memoryIndexer?;
    private workerPool?;
    private processManager?;
    private pluginLoader?;
    private agentServiceRef?;
    private crashGuard;
    private resourceBudget?;
    private metricsCollector?;
    private stabilityScore?;
    private proposalValidator?;
    private gitOps?;
    private syscallBus?;
    private healthChecker?;
    private capabilityEngine?;
    private sessionGovernor?;
    private checkpointV2?;
    private runtimeHealthManager?;
    private comfyUI?;
    constructor(crashGuard?: {
        flushMemory: (() => void) | null;
    });
    start(): Promise<void>;
    private shutdown;
    private registerCoreEventBus;
    private registerLazyServices;
    private logModelConfig;
    private buildCreativitySources;
    private initGpuAsync;
}
