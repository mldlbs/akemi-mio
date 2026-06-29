import type { StateManager } from '../core/StateManager';
import type { ISubsystem, HealthCheckResult, SubsystemState } from '../core/lifecycle/types';
import { SessionHealthScorer } from './SessionHealthScorer';
import { SessionStateMachine } from './SessionStateMachine';
/**
 * SessionGovernor — 会话级健康治理控制器。
 *
 * 职责：
 * 1. 监听 EventBus 事件，维持健康评分
 * 2. 驱动状态机（RUNNING→DEGRADED→RECOVERING→SAFE_MODE→REBUILDING）
 * 3. 协调恢复动作
 * 4. 推送观测状态到 UI
 *
 * 注册为 Kernel IModule（通过 AppRuntime）。
 */
export interface RecoveryCallbacks {
    /** Level 1: 压缩上下文，清理 orphan tool_call */
    onContextCompress?: () => void;
    /** Level 2: 注入纠偏消息到会话上下文 */
    onInjectCorrection?: (message: string) => void;
    /** Level 3: 切换模型 */
    onModelSwitch?: (model: string) => void;
    /** Level 4: 限制工具为只读 */
    onToolDowngrade?: (restricted: boolean) => void;
    /** Level 5: 清空上下文窗口 */
    onClearContext?: () => void;
}
export declare class SessionGovernor implements ISubsystem {
    readonly name = "SessionGovernor";
    state: SubsystemState;
    readonly scorer: SessionHealthScorer;
    readonly stateMachine: SessionStateMachine;
    private subs;
    private stateManager;
    private tickTimer;
    private recoveryInProgress;
    private readonly tickIntervalMs;
    private callbacks;
    constructor();
    setStateManager(sm: StateManager): void;
    setRecoveryCallbacks(cbs: RecoveryCallbacks): void;
    init(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    destroy(): Promise<void>;
    healthCheck(): Promise<HealthCheckResult>;
    private subscribeEvents;
    private evaluateAndAct;
    private triggerRecoveryIfNeeded;
    private executeActionsSequentially;
    private executeAction;
    private startTickTimer;
    private pushUIState;
    private emitStateChange;
    getDiagnostics(): Record<string, unknown>;
}
