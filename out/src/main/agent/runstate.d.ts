export interface GovernorRecord {
    step: number;
    action: 'continue' | 'stop' | 'shift';
    reason: string;
    failedTools: string[];
    roundResult: 'all_ok' | 'partial' | 'all_failed';
}
/**
 * Agent 运行状态枚举
 * 替代旧的二值 inToolLoop boolean，支持打断、审批、错误等完整生命周期
 */
export declare enum RunState {
    READY = "ready",
    RUNNING = "running",
    WAIT_TOOL = "wait_tool",
    INTERRUPTED = "interrupted",
    COMPLETED = "completed",
    FAILED = "failed",
    CANCELLED = "cancelled"
}
/**
 * Agent 运行上下文 — 保存整个工具循环的运行时状态
 */
export declare class RunContext {
    readonly runId: string;
    state: RunState;
    /** toolLoop 当前轮次 */
    step: number;
    /** 中断标志 — 新用户输入或用户取消时设置 */
    interruptFlag: boolean;
    /** 中断来源描述（如"用户新输入"） */
    interruptReason: string;
    /** 中止信号 — 用于取消正在进行的 LLM 调用或工具执行 */
    abortController: AbortController;
    /** LLM 回复累积文本 */
    reply: string;
    /** 当前轮次的工具调用信息 */
    toolCalls: Array<{
        name: string;
        args: Record<string, unknown>;
    }>;
    /** 起始时间戳 */
    startedAt: number;
    consecutiveToolErrors: number;
    consecutiveTimeouts: number;
    consecutiveReadOnlyRounds: number;
    consecutiveReadOnlyErrors: number;
    /** 连续只读卡死累计次数（跨 toolLoop 不重置） */
    readonlyStuckCount: number;
    /** 当前 toolLoop 中强制续行 plan 的次数，超过上限则跳出避免死循环 */
    forceContinueCount: number;
    /** 上一次 force_continue 时 pending steps 的描述，用于检测停滞 */
    lastForceContinuePendingDesc: string;
    /** 连续 N 次 force_continue 而未取得进展 */
    forceContinueStagnation: number;
    /** 抑制强制续行（tryRun 分析模式用） */
    suppressForceContinue: boolean;
    /** Guardrail 请求终止：放行最后一轮 LLM 回复后退出 */
    guardrailStop: boolean;
    softReplyInjected: boolean;
    /** 前几轮已经口头汇报过的内容摘要 */
    spokenReplies: string[];
    /** ExecutionGovernor 决策历史 */
    governorHistory: GovernorRecord[];
    constructor(runId: string);
    /** 安全状态转移 */
    transition(to: RunState): boolean;
    /** 标记中断（用户打断/新输入） */
    interrupt(reason: string): void;
    /** 重置为 READY，准备新一次运行 */
    reset(): void;
    /** 记录 ExecutionGovernor 决策 */
    recordGovernor(decision: {
        action: GovernorRecord['action'];
        reason: string;
    }, failedTools: string[], roundResult: GovernorRecord['roundResult']): void;
    get running(): boolean;
}
