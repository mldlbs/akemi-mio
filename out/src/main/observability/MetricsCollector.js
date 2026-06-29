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
import { eventBus as defaultEventBus } from '../core/EventBus';
import { log } from '../logger/Logger';
// =============================================================================
// MetricsCollector
// =============================================================================
export class MetricsCollector {
    constructor(eventBus) {
        // Evolution
        this.evolutionData = {
            totalCycles: 0,
            successCount: 0,
            failureCount: 0,
            timeoutCount: 0,
            cycleDurations: [],
            lastCycleTimestamp: null,
        };
        // Guardrail
        this.guardrailData = {
            totalRejections: 0,
            hardBlocks: 0,
            goalDrifts: 0,
            trippedCount: 0,
        };
        // Plans
        this.planData = {
            totalCreated: 0,
            totalCompleted: 0,
            totalAbandoned: 0,
            activeCount: 0,
        };
        // Tools
        this.toolData = {};
        this.toolTotalCalls = 0;
        this.toolSuccessCount = 0;
        this.toolFailureCount = 0;
        // API calls (from tool execution timing)
        this.apiCallTotal = 0;
        this.apiCallSuccess = 0;
        this.apiCallFailure = 0;
        // Task tracking
        this.taskCompletedCount = 0;
        this.taskFailedCount = 0;
        this.taskScoreSum = 0;
        this.taskScoreCount = 0;
        this.unsubscribers = [];
        this.eventBus = eventBus || defaultEventBus;
        this.subscribe();
    }
    // ===== 订阅事件 =====
    subscribe() {
        // 进化循环完成
        const unsubCycle = this.eventBus.on('evolution.cycle.completed', (data) => {
            this.evolutionData.totalCycles++;
            this.evolutionData.lastCycleTimestamp = data.timestamp;
            if (data.success) {
                this.evolutionData.successCount++;
            }
            else {
                this.evolutionData.failureCount++;
                // 检测超时
                if (data.summary?.includes('timeout') || data.summary?.includes('超时')) {
                    this.evolutionData.timeoutCount++;
                }
            }
            // 仅保留最近 20 条
            if (this.evolutionData.cycleDurations.length > 20) {
                this.evolutionData.cycleDurations = this.evolutionData.cycleDurations.slice(-20);
            }
            log('PERF', 'metrics_evolution_cycle', {
                total: this.evolutionData.totalCycles,
                success_rate: this.getSuccessRate().toFixed(2),
            });
        });
        this.unsubscribers.push(unsubCycle);
        // 计划创建
        const unsubPlanCreate = this.eventBus.on('agent.plan.created', (_data) => {
            this.planData.totalCreated++;
            this.planData.activeCount++;
        });
        this.unsubscribers.push(unsubPlanCreate);
        // 计划完成
        const unsubPlanComplete = this.eventBus.on('agent.plan.completed', (_data) => {
            this.planData.totalCompleted++;
            this.planData.activeCount = Math.max(0, this.planData.activeCount - 1);
        });
        this.unsubscribers.push(unsubPlanComplete);
        // 工具调用
        const unsubToolInvoke = this.eventBus.on('agent.tool.invoked', (data) => {
            this.toolTotalCalls++;
            this.apiCallTotal++;
            if (!this.toolData[data.tool]) {
                this.toolData[data.tool] = { calls: 0, errors: 0 };
            }
            this.toolData[data.tool].calls++;
        });
        this.unsubscribers.push(unsubToolInvoke);
        // 工具完成
        const unsubToolComplete = this.eventBus.on('agent.tool.completed', (_data) => {
            this.toolSuccessCount++;
            this.apiCallSuccess++;
        });
        this.unsubscribers.push(unsubToolComplete);
        // 工具失败
        const unsubToolFailed = this.eventBus.on('agent.tool.failed', (data) => {
            this.toolFailureCount++;
            this.apiCallFailure++;
            if (this.toolData[data.tool]) {
                this.toolData[data.tool].errors++;
            }
        });
        this.unsubscribers.push(unsubToolFailed);
        // 任务生命周期
        const unsubTaskLifecycle = this.eventBus.on('task.lifecycle', (data) => {
            if (data.status === 'completed')
                this.taskCompletedCount++;
            else if (data.status === 'failed')
                this.taskFailedCount++;
            if (data.durationMs) {
                this.taskScoreSum += Math.max(0, 1000 - data.durationMs) / 1000;
                this.taskScoreCount++;
            }
        });
        this.unsubscribers.push(unsubTaskLifecycle);
        // Guardrail 拒绝
        const unsubRejection = this.eventBus.on('goal.guardrail.rejection', (data) => {
            this.guardrailData.totalRejections++;
            if (data.reason === 'HARD_BLOCK')
                this.guardrailData.hardBlocks++;
            else if (data.reason === 'GOAL_DRIFT')
                this.guardrailData.goalDrifts++;
        });
        this.unsubscribers.push(unsubRejection);
        // Guardrail 熔断
        const unsubTripped = this.eventBus.on('goal.guardrail.tripped', () => {
            this.guardrailData.trippedCount++;
        });
        this.unsubscribers.push(unsubTripped);
    }
    // ===== 查询 =====
    /** 获取当前所有指标的快照 */
    getSnapshot() {
        const mem = process.memoryUsage();
        return {
            evolution: {
                totalCycles: this.evolutionData.totalCycles,
                successCount: this.evolutionData.successCount,
                failureCount: this.evolutionData.failureCount,
                timeoutCount: this.evolutionData.timeoutCount,
                avgDurationMs: this.getAvgCycleDuration(),
                lastCycleTimestamp: this.evolutionData.lastCycleTimestamp,
                cycleDurations: [...this.evolutionData.cycleDurations],
            },
            plans: {
                totalCreated: this.planData.totalCreated,
                totalCompleted: this.planData.totalCompleted,
                totalAbandoned: Math.max(0, this.planData.totalCreated - this.planData.totalCompleted - this.planData.activeCount),
                completionRate: this.planData.totalCreated > 0 ? this.planData.totalCompleted / this.planData.totalCreated : 0,
                activeCount: this.planData.activeCount,
            },
            tasks: {
                totalRegistered: 0,
                activeInstances: 0,
                completedCount: this.taskCompletedCount,
                failedCount: this.taskFailedCount,
                avgScore: this.taskScoreCount > 0 ? this.taskScoreSum / this.taskScoreCount : 0,
                graphSize: 0,
                cyclesDetected: 0,
            },
            resources: {
                computeUtilization: 0,
                memoryUtilization: 0,
                llmUtilization: 0,
                taskSlotUtilization: 0,
                evolutionRiskLevel: 0,
            },
            stability: {
                healthScore: 100,
                taskFlowEfficiency: 1,
                schedulerBalance: 1,
                evolutionRiskControl: 1,
                errorRateInverse: this.apiCallTotal > 0 ? 1 - this.apiCallFailure / this.apiCallTotal : 1,
            },
            tools: {
                totalCalls: this.toolTotalCalls,
                successCount: this.toolSuccessCount,
                failureCount: this.toolFailureCount,
                byTool: { ...this.toolData },
            },
            guardrail: { ...this.guardrailData },
            apiCalls: {
                total: this.apiCallTotal,
                successCount: this.apiCallSuccess,
                failureCount: this.apiCallFailure,
            },
            memory: {
                heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
                heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
                rssMB: Math.round(mem.rss / 1024 / 1024),
            },
            uptime: process.uptime(),
            eventLoopLagMs: -1,
            timestamp: Date.now(),
        };
    }
    getSuccessRate() {
        const total = this.evolutionData.totalCycles;
        return total > 0 ? this.evolutionData.successCount / total : 1;
    }
    getAvgCycleDuration() {
        const durations = this.evolutionData.cycleDurations;
        return durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
    }
    /** 返回稳定性评分所需的因子 */
    getStabilityInputs() {
        const totalToolCalls = this.toolTotalCalls || 1;
        return {
            taskFlowEfficiency: this.taskCompletedCount + this.taskFailedCount > 0 ? this.taskCompletedCount / (this.taskCompletedCount + this.taskFailedCount) : 1,
            schedulerBalance: this.planData.totalCreated > 0 ? this.planData.totalCompleted / this.planData.totalCreated : 1,
            evolutionRiskControl: this.evolutionData.totalCycles > 0 ? this.evolutionData.successCount / this.evolutionData.totalCycles : 1,
        };
    }
    /** 返回守卫指标 */
    getGuardrailData() {
        return { ...this.guardrailData };
    }
    /** 重置所有指标 */
    reset() {
        this.evolutionData = {
            totalCycles: 0,
            successCount: 0,
            failureCount: 0,
            timeoutCount: 0,
            cycleDurations: [],
            lastCycleTimestamp: null,
        };
        this.planData = {
            totalCreated: 0,
            totalCompleted: 0,
            totalAbandoned: 0,
            activeCount: 0,
        };
        this.toolData = {};
        this.toolTotalCalls = 0;
        this.toolSuccessCount = 0;
        this.toolFailureCount = 0;
        this.apiCallTotal = 0;
        this.apiCallSuccess = 0;
        this.apiCallFailure = 0;
        this.taskCompletedCount = 0;
        this.taskFailedCount = 0;
        this.taskScoreSum = 0;
        this.taskScoreCount = 0;
        this.guardrailData = {
            totalRejections: 0,
            hardBlocks: 0,
            goalDrifts: 0,
            trippedCount: 0,
        };
    }
    /** 清理事件订阅 */
    destroy() {
        for (const unsub of this.unsubscribers) {
            unsub();
        }
        this.unsubscribers = [];
    }
}
