/**
 * MetricsCollector — 运行时指标收集器
 *
 * 监听 EventBus 事件，自动记录关键运行时指标。
 * 集成到 health:check 端点暴露。
 *
 * 收集的指标：
 * - 进化循环：总执行次数、成功/失败、平均耗时
 * - 计划管理：创建数、完成数、放弃数、完成率
 * - API 调用：总次数、成功/失败、平均耗时
 * - 工具调用：按工具名统计
 */
import { EventBus } from '../core/EventBus';
export interface EvolutionMetrics {
    totalCycles: number;
    successCount: number;
    failureCount: number;
    timeoutCount: number;
    avgDurationMs: number;
    lastCycleTimestamp: number | null;
    cycleDurations: number[];
}
export interface PlanMetrics {
    totalCreated: number;
    totalCompleted: number;
    totalAbandoned: number;
    completionRate: number;
    activeCount: number;
}
export interface ToolMetrics {
    totalCalls: number;
    successCount: number;
    failureCount: number;
    byTool: Record<string, {
        calls: number;
        errors: number;
    }>;
}
export interface TaskMetrics {
    totalRegistered: number;
    activeInstances: number;
    completedCount: number;
    failedCount: number;
    avgScore: number;
    graphSize: number;
    cyclesDetected: number;
}
export interface ResourceMetrics {
    computeUtilization: number;
    memoryUtilization: number;
    llmUtilization: number;
    taskSlotUtilization: number;
    evolutionRiskLevel: number;
}
export interface StabilityMetrics {
    healthScore: number;
    taskFlowEfficiency: number;
    schedulerBalance: number;
    evolutionRiskControl: number;
    errorRateInverse: number;
}
export interface RuntimeMetrics {
    evolution: EvolutionMetrics;
    plans: PlanMetrics;
    tools: ToolMetrics;
    tasks: TaskMetrics;
    resources: ResourceMetrics;
    stability: StabilityMetrics;
    guardrail: {
        totalRejections: number;
        hardBlocks: number;
        goalDrifts: number;
        trippedCount: number;
    };
    apiCalls: {
        total: number;
        successCount: number;
        failureCount: number;
    };
    memory: {
        heapUsedMB: number;
        heapTotalMB: number;
        rssMB: number;
    };
    uptime: number;
    eventLoopLagMs: number;
    timestamp: number;
}
export declare class MetricsCollector {
    private evolutionData;
    private guardrailData;
    private planData;
    private toolData;
    private toolTotalCalls;
    private toolSuccessCount;
    private toolFailureCount;
    private apiCallTotal;
    private apiCallSuccess;
    private apiCallFailure;
    private taskCompletedCount;
    private taskFailedCount;
    private taskScoreSum;
    private taskScoreCount;
    private eventBus;
    private unsubscribers;
    constructor(eventBus?: EventBus);
    private subscribe;
    /** 获取当前所有指标的快照 */
    getSnapshot(): RuntimeMetrics;
    private getSuccessRate;
    private getAvgCycleDuration;
    /** 返回稳定性评分所需的因子 */
    getStabilityInputs(): {
        taskFlowEfficiency: number;
        schedulerBalance: number;
        evolutionRiskControl: number;
    };
    /** 返回守卫指标 */
    getGuardrailData(): {
        totalRejections: number;
        hardBlocks: number;
        goalDrifts: number;
        trippedCount: number;
    };
    /** 重置所有指标 */
    reset(): void;
    /** 清理事件订阅 */
    destroy(): void;
}
