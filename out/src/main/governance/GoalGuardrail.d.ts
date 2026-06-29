import type { ToolCallInfo } from '../llm/LlmService';
import type { Message } from '../agent/context';
import type { RunContext } from '../agent/runstate';
import type { ConstitutionEngine } from '../constitution/ConstitutionEngine';
import type { GoalEngine } from '../cognitive/GoalEngine';
import { RejectionTracker, type RejectionReason, type RejectionTrackerConfig } from './RejectionTracker';
import type { SystemBus } from '../core/SystemBus';
export interface GoalGuardrailConfig {
    /** 硬守卫规则（启动时从 ConstitutionEngine 加载） */
    hardGuardPaths: string[];
    /** 软守卫评估间隔（第 1 轮每轮必检，预留未来降频扩展） */
    softCheckInterval: number;
    /** 熔断阈值配置，透传 RejectionTracker */
    rejection: Partial<RejectionTrackerConfig>;
}
export type GuardDecision = {
    status: 'approved';
    toolCalls: ToolCallInfo[];
} | {
    status: 'denied';
    reason: RejectionReason;
    /** 是否允许 LLM 重试（硬拒绝=false，软拒绝=true） */
    canRetry: boolean;
    /** 注入给 LLM 的消息内容 */
    message: string;
    /** 此拒绝是否已注入到 messages（硬拒绝不注入，调用方需清理软注入） */
    injected: boolean;
};
export declare class GoalGuardrail {
    private goalEngine;
    private constitutionEngine;
    private rejectionTracker;
    private config;
    private systemBus;
    /** 上一轮是否拒绝了（用于状态驱动的高频检测窗口） */
    private previousTurnDenied;
    constructor(goalEngine: GoalEngine | null, constitutionEngine: ConstitutionEngine | null, config?: Partial<GoalGuardrailConfig>);
    /**
     * 对 LLM 返回的一批工具调用进行守卫检查。
     * 调用时机：toolLoop 中 LLM 返回 toolCalls 后、spend + executeAll 之前。
     *
     * 执行顺序：
     *   1. 熔断检查 → 硬拒绝（不可重试，不注入消息）
     *   2. 硬守卫 → 宪法路径拦截（不可重试，不注入消息）
     *   3. 软守卫 → 目标一致性评分（可重试，注入 【目标对齐】消息）
     */
    checkBatch(toolCalls: ToolCallInfo[], messages: Message[], ctx: RunContext): Promise<GuardDecision>;
    /** 在工具成功执行后调用（信用恢复 & 重置上一轮拒绝状态） */
    onToolSuccess(): void;
    /** 获取熔断统计 */
    getRejectionStats(): ReturnType<RejectionTracker['getStats']>;
    /** 重置拒绝记录（跨会话/跨 toolLoop 时调用） */
    resetRejectionTracking(): void;
    /** 获取上游组件引用（用于 ChatExecutor 构建 AuditTrail 消息） */
    getConstitutionEngine(): ConstitutionEngine | null;
    /**
     * 延迟绑定：在 AppRuntime 初始化 CognitiveService 后注入 GoalEngine。
     * 匹配 AgentService 的 9 阶段启动模式。
     */
    setGoalEngine(engine: GoalEngine | null): void;
    /**
     * 延迟绑定：在 AppRuntime 初始化 ConstitutionEngine 后注入。
     */
    setConstitutionEngine(engine: ConstitutionEngine | null): void;
    /**
     * 延迟绑定 SystemBus（由 AppRuntime Phase 6 注入）。
     * 注入后软守卫将从 SystemBus 查询多因子 utility-score。
     */
    setSystemBus(bus: SystemBus | null): void;
    /**
     * 硬守卫：确定性规则检查。
     * - 写操作 → 委托 ConstitutionEngine.checkWrite() 检查路径
     * - 不可变工具名 → 直接拦截
     */
    private checkHardBlock;
    /**
     * 从 ToolCallInfo.arguments 中提取路径参数。
     * 支持多种参数命名（path / file_path）。
     */
    private extractPathArg;
    /**
     * 软守卫：目标一致性评分。
     *
     * 第 2 轮实现：如果 SystemBus 在线，优先查询多因子 utility-score；
     * 否则回退到启发式规则匹配。
     *
     * 评分规则：
     * - SystemBus 在线：返回 aggregated UtilityScore（0-1）
     * - SystemBus 离线：同 Week 1——基于活跃目标类别与工具名的规则匹配
     * - 没有活跃目标 → 1.0（不拦截）
     *
     * 状态驱动高频检测：当 previousTurnDenied = true 时，评分额外 -0.2
     */
    private evaluateConsistency;
    /**
     * 检测目标漂移。
     *
     * 规则（第 1 轮启发式）：
     * - long_term / mission 目标活跃时，不应被短平快工具打断
     * - short_term / initiative 目标活跃时，许可范围较宽松
     */
    private detectGoalDrift;
    /**
     * 构建 GOAL_DRIFT 拒绝决策。
     * 根据偏离分数生成不同强度的对齐提示。
     */
    private buildGoalDriftDecision;
}
