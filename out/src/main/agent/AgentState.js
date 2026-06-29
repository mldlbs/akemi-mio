/**
 * AgentState — 通用 Agent 三维状态向量
 *
 * mode × stage × lifecycle 互不冲突，覆盖 Chat/Task/Evolution/Background 四种运行模式。
 * ChatExecutor/TaskExecutor 各自持有独立实例。
 *
 * 向后兼容：RunContext（runstate.ts）依然可用，逐步迁移。新代码优先使用 AgentState。
 */
// ─── 模式 ───
export const AGENT_MODES = ['chat', 'task', 'evolution', 'background'];
// ─── 认知阶段（OTPAR 扩展） ───
export const COGNITIVE_STAGES = ['idle', 'observe', 'think', 'plan', 'act', 'reflect', 'sleep'];
// ─── 生命周期 ───
export const LIFECYCLE_STATES = ['ready', 'running', 'interrupted', 'completed', 'failed'];
// ─── 转化矩阵 ───
const STAGE_TRANSITIONS = {
    idle: ['observe', 'think', 'sleep'],
    observe: ['think', 'idle'],
    think: ['plan', 'act', 'idle', 'observe'],
    plan: ['act', 'idle', 'think'],
    act: ['reflect', 'observe', 'idle'],
    reflect: ['idle', 'sleep', 'observe'],
    sleep: ['idle'],
};
const LIFECYCLE_TRANSITIONS = {
    ready: ['running', 'completed', 'failed'],
    running: ['interrupted', 'completed', 'failed'],
    interrupted: ['running', 'completed', 'failed'],
    completed: ['ready'],
    failed: ['ready'],
};
// ─── AgentState ───
export class AgentState {
    constructor(mode, requestId) {
        this.stage = 'idle';
        this.lifecycle = 'ready';
        this.guard = { consecutiveErrors: 0, consecutiveTimeouts: 0, forcedContinueCount: 0 };
        this.previousStage = null;
        this.mode = mode;
        this.meta = {
            requestId,
            step: 0,
            startedAt: Date.now(),
            tokensUsed: 0,
            toolCount: 0,
        };
    }
    /** 转换认知阶段 */
    transitionStage(to) {
        const allowed = STAGE_TRANSITIONS[this.stage];
        if (!allowed?.includes(to)) {
            return false;
        }
        this.previousStage = this.stage;
        this.stage = to;
        return true;
    }
    /** 转换生命周期 */
    transitionLifecycle(to) {
        const allowed = LIFECYCLE_TRANSITIONS[this.lifecycle];
        if (!allowed?.includes(to)) {
            return false;
        }
        this.lifecycle = to;
        return true;
    }
    /** 重置为初始状态（复用实例） */
    reset(requestId) {
        this.stage = 'idle';
        this.lifecycle = 'ready';
        this.previousStage = null;
        this.meta.step = 0;
        this.meta.tokensUsed = 0;
        this.meta.toolCount = 0;
        this.guard.consecutiveErrors = 0;
        this.guard.consecutiveTimeouts = 0;
        this.guard.forcedContinueCount = 0;
        if (requestId) {
            this.meta.requestId = requestId;
            this.meta.startedAt = Date.now();
        }
    }
    /** 步骤递增 */
    incrementStep() {
        this.meta.step++;
    }
    /** 记录 token 使用 */
    recordTokens(count) {
        this.meta.tokensUsed += count;
    }
    /** 记录工具调用 */
    recordToolCall() {
        this.meta.toolCount++;
    }
    /** 是否正在运行 */
    get isRunning() {
        return this.lifecycle === 'running';
    }
    /** 是否可被中断恢复 */
    get isInterrupted() {
        return this.lifecycle === 'interrupted';
    }
    /** 快照 */
    snapshot() {
        return {
            mode: this.mode,
            stage: this.stage,
            lifecycle: this.lifecycle,
            meta: { ...this.meta },
            guard: { ...this.guard },
        };
    }
}
