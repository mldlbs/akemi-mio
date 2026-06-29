/**
 * AgentState — 通用 Agent 三维状态向量
 *
 * mode × stage × lifecycle 互不冲突，覆盖 Chat/Task/Evolution/Background 四种运行模式。
 * ChatExecutor/TaskExecutor 各自持有独立实例。
 *
 * 向后兼容：RunContext（runstate.ts）依然可用，逐步迁移。新代码优先使用 AgentState。
 */
export declare const AGENT_MODES: readonly ["chat", "task", "evolution", "background"];
export type AgentMode = (typeof AGENT_MODES)[number];
export declare const COGNITIVE_STAGES: readonly ["idle", "observe", "think", "plan", "act", "reflect", "sleep"];
export type CognitiveStage = (typeof COGNITIVE_STAGES)[number];
export declare const LIFECYCLE_STATES: readonly ["ready", "running", "interrupted", "completed", "failed"];
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];
export interface AgentMeta {
    requestId: string;
    step: number;
    startedAt: number;
    tokensUsed: number;
    toolCount: number;
}
export interface GuardCounters {
    consecutiveErrors: number;
    consecutiveTimeouts: number;
    forcedContinueCount: number;
}
export interface AgentStateSnapshot {
    mode: AgentMode;
    stage: CognitiveStage;
    lifecycle: LifecycleState;
    meta: Readonly<AgentMeta>;
    guard: Readonly<GuardCounters>;
}
export declare class AgentState {
    mode: AgentMode;
    stage: CognitiveStage;
    lifecycle: LifecycleState;
    meta: AgentMeta;
    guard: GuardCounters;
    previousStage: CognitiveStage | null;
    constructor(mode: AgentMode, requestId: string);
    /** 转换认知阶段 */
    transitionStage(to: CognitiveStage): boolean;
    /** 转换生命周期 */
    transitionLifecycle(to: LifecycleState): boolean;
    /** 重置为初始状态（复用实例） */
    reset(requestId?: string): void;
    /** 步骤递增 */
    incrementStep(): void;
    /** 记录 token 使用 */
    recordTokens(count: number): void;
    /** 记录工具调用 */
    recordToolCall(): void;
    /** 是否正在运行 */
    get isRunning(): boolean;
    /** 是否可被中断恢复 */
    get isInterrupted(): boolean;
    /** 快照 */
    snapshot(): AgentStateSnapshot;
}
