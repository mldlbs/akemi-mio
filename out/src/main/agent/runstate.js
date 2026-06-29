import { log } from '../logger/Logger';
/**
 * Agent 运行状态枚举
 * 替代旧的二值 inToolLoop boolean，支持打断、审批、错误等完整生命周期
 */
export var RunState;
(function (RunState) {
    RunState["READY"] = "ready";
    RunState["RUNNING"] = "running";
    RunState["WAIT_TOOL"] = "wait_tool";
    RunState["INTERRUPTED"] = "interrupted";
    RunState["COMPLETED"] = "completed";
    RunState["FAILED"] = "failed";
    RunState["CANCELLED"] = "cancelled";
})(RunState || (RunState = {}));
/**
 * 状态可转换矩阵
 */
const TRANSITIONS = {
    [RunState.READY]: [RunState.RUNNING, RunState.CANCELLED],
    [RunState.RUNNING]: [RunState.WAIT_TOOL, RunState.INTERRUPTED, RunState.COMPLETED, RunState.FAILED, RunState.CANCELLED],
    [RunState.WAIT_TOOL]: [RunState.RUNNING, RunState.INTERRUPTED, RunState.CANCELLED, RunState.FAILED],
    [RunState.INTERRUPTED]: [RunState.RUNNING, RunState.CANCELLED],
    [RunState.COMPLETED]: [RunState.READY],
    [RunState.FAILED]: [RunState.READY],
    [RunState.CANCELLED]: [RunState.READY],
};
/**
 * Agent 运行上下文 — 保存整个工具循环的运行时状态
 */
export class RunContext {
    constructor(runId) {
        this.state = RunState.READY;
        /** toolLoop 当前轮次 */
        this.step = 0;
        /** 中断标志 — 新用户输入或用户取消时设置 */
        this.interruptFlag = false;
        /** 中断来源描述（如"用户新输入"） */
        this.interruptReason = '';
        /** 中止信号 — 用于取消正在进行的 LLM 调用或工具执行 */
        this.abortController = new AbortController();
        /** LLM 回复累积文本 */
        this.reply = '';
        /** 当前轮次的工具调用信息 */
        this.toolCalls = [];
        /** 起始时间戳 */
        this.startedAt = 0;
        // ── Guardrail 计数器（原 AgentService 散落字段） ──
        this.consecutiveToolErrors = 0;
        this.consecutiveTimeouts = 0;
        this.consecutiveReadOnlyRounds = 0;
        this.consecutiveReadOnlyErrors = 0;
        /** 连续只读卡死累计次数（跨 toolLoop 不重置） */
        this.readonlyStuckCount = 0;
        /** 当前 toolLoop 中强制续行 plan 的次数，超过上限则跳出避免死循环 */
        this.forceContinueCount = 0;
        /** 上一次 force_continue 时 pending steps 的描述，用于检测停滞 */
        this.lastForceContinuePendingDesc = '';
        /** 连续 N 次 force_continue 而未取得进展 */
        this.forceContinueStagnation = 0;
        /** 抑制强制续行（tryRun 分析模式用） */
        this.suppressForceContinue = false;
        /** Guardrail 请求终止：放行最后一轮 LLM 回复后退出 */
        this.guardrailStop = false;
        this.softReplyInjected = false;
        /** 前几轮已经口头汇报过的内容摘要 */
        this.spokenReplies = [];
        /** ExecutionGovernor 决策历史 */
        this.governorHistory = [];
        this.runId = runId;
    }
    /** 安全状态转移 */
    transition(to) {
        const allowed = TRANSITIONS[this.state];
        if (!allowed?.includes(to)) {
            log('WARN', 'run_state_invalid_transition', { from: this.state, to, runId: this.runId });
            return false;
        }
        this.state = to;
        return true;
    }
    /** 标记中断（用户打断/新输入） */
    interrupt(reason) {
        this.interruptFlag = true;
        this.interruptReason = reason;
        this.abortController.abort();
        this.transition(RunState.INTERRUPTED);
    }
    /** 重置为 READY，准备新一次运行 */
    reset() {
        this.state = RunState.READY;
        this.step = 0;
        this.interruptFlag = false;
        this.interruptReason = '';
        this.abortController = new AbortController();
        this.reply = '';
        this.toolCalls = [];
        this.consecutiveToolErrors = 0;
        this.consecutiveTimeouts = 0;
        this.consecutiveReadOnlyRounds = 0;
        this.consecutiveReadOnlyErrors = 0;
        this.readonlyStuckCount = 0;
        this.forceContinueCount = 0;
        this.lastForceContinuePendingDesc = '';
        this.forceContinueStagnation = 0;
        this.governorHistory = [];
    }
    /** 记录 ExecutionGovernor 决策 */
    recordGovernor(decision, failedTools, roundResult) {
        this.governorHistory.push({
            step: this.step,
            action: decision.action,
            reason: decision.reason,
            failedTools,
            roundResult,
        });
    }
    get running() {
        return this.state === RunState.RUNNING || this.state === RunState.WAIT_TOOL;
    }
}
