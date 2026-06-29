/** 预算超限异常 — Hard Budget 模式下消耗方必须处理 */
export declare class BudgetExceededError extends Error {
    readonly resource: string;
    readonly used: number;
    readonly limit: number;
    constructor(resource: string, used: number, limit: number);
}
export interface BudgetConfig {
    /** 单次请求最大 LLM token 调用次数（含 introspection 和 retry） */
    maxLlmCallsPerRequest: number;
    /** 单次 toolLoop 最大轮次 */
    maxToolLoopTurns: number;
    /** 单次 LLM 调用超时（ms） */
    llmTimeoutMs: number;
    /** Chat 对话最大 LLM 调用次数 */
    maxChatLlmCalls: number;
    /** Evolution 循环最大 token 预算（近似，基于调用次数） */
    maxEvolutionLlmCalls: number;
    /** 后台服务（reflect/sleep）最大 LLM 调用次数 */
    maxBackgroundLlmCalls: number;
    /** 研究任务最大 LLM 调用次数 */
    maxResearchLlmCalls: number;
    /** 单次请求最大 CPU 耗时（ms） */
    maxCpuMs: number;
    /** 单次请求最大内存（MB） */
    maxMemoryMb: number;
    /** toolLoop 软 override 额外轮次（仅超限时可用） */
    softOverrideTurns: number;
    /** soft reply 阈值：超过此轮次后注入提示强制 LLM 生成回复（0 = 禁用） */
    softReplyThreshold: number;
    /** Evolution 自任务最大 toolLoop 轮次 */
    selfTaskMaxToolLoopTurns: number;
}
export interface ProcessBudgetConfig {
    maxMemoryMb: number;
    maxCpuMs: number;
    maxRestarts: number;
}
export interface ProcessUtilization {
    memoryMb: number;
    cpuMs: number;
    restarts: number;
}
/**
 * ResourceBudget — Agent OS 资源预算管理器。
 *
 * 防止单个请求或后台服务耗尽全系统的 LLM 配额。
 * 支持 CPU/内存预算、任务级预算、响应式强制执行和稳定性自适应调节。
 *
 * budget.exhausted 事件去重规则：
 * - 每种资源类型（llm.request / llm.evolution / toolLoop / cpu / memory）
 *   在同一个 request 生命周期内只 emit 一次
 * - 软 override 阶段不重复 emit，仅在硬停止时记录一次
 */
export declare class ResourceBudget {
    private config;
    private state;
    private taskBudgets;
    private processBudgets;
    private originalConfig;
    private readonly budgetFilePath;
    constructor(config?: Partial<BudgetConfig>, budgetFilePath?: string);
    private freshState;
    /** 检查是否有任何预算已耗尽 */
    isExhausted(): boolean;
    /** 开始新请求，重置所有计数器 */
    startRequest(): void;
    checkLlmCall(context: 'chat' | 'evolution' | 'background' | 'research'): string | null;
    /** 消耗一次 LLM 调用 — 超限时抛出 BudgetExceededError（Hard Budget） */
    consumeLlmCall(context: 'chat' | 'evolution' | 'background' | 'research'): void;
    checkToolLoopTurn(): string | null;
    /**
     * 消耗一次 ToolLoop 轮次 — 超限时抛出 BudgetExceededError
     *
     * 去重规则：toolLoop 资源只在首次超限时 emit 一次 budget.exhausted。
     * 后续的软 override 轮次不再重复 emit，避免日志/Telegram 风暴。
     */
    consumeToolLoopTurn(): void;
    /** 是否正在软 override 中 */
    isInSoftOverride(): boolean;
    /** 获取软 override 剩余轮次 */
    getSoftOverrideRemaining(): number;
    /** 消耗 CPU 时间 — 超限时抛出 BudgetExceededError */
    consumeCpuMs(durationMs: number): void;
    /** 检查内存消耗 — 超限时抛出 BudgetExceededError */
    consumeMemoryMb(currentHeapMb: number): void;
    allocateTask(taskId: string, llmBudget: number, cpuBudget: number): void;
    releaseTask(taskId: string): void;
    consumeTaskLlmCall(taskId: string): string | null;
    consumeTaskCpuMs(taskId: string, durationMs: number): string | null;
    /** 为子进程分配预算 */
    allocateProcessBudget(processName: string, config: ProcessBudgetConfig): void;
    /** 消耗子进程内存（返回是否超限） */
    consumeProcessMemory(processName: string, mb: number): boolean;
    /** 记录子进程重启 */
    recordProcessRestart(processName: string): boolean;
    /** 获取子进程利用率 */
    getProcessUtilization(processName: string): ProcessUtilization | null;
    /** 释放子进程预算 */
    releaseProcessBudget(processName: string): void;
    private emitProcessExhausted;
    /** 根据稳定性评分自动调节预算 */
    autoTune(stabilityScore: number): void;
    resetBackground(): void;
    resetEvolution(): void;
    /** 重置 toolLoop 轮次计数器（Evolution 自任务启动时调用） */
    resetToolLoopTurns(): void;
    getSnapshot(): Record<string, number>;
    getConfig(): BudgetConfig;
    updateConfig(patch: Partial<BudgetConfig>): void;
    /** 将跨请求计数器（evolution/background）写入磁盘 */
    saveState(): void;
    /** 从磁盘恢复跨请求计数器 */
    loadState(): void;
}
