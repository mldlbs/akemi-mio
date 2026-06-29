import { DevPlan, PlanStep } from './types';
import { AsyncLock } from '../utils/AsyncLock';
export declare class PlanManager {
    private filePath;
    private data;
    readonly lock: AsyncLock;
    constructor();
    private load;
    private save;
    /** 当前活跃计划上限 */
    static readonly MAX_ACTIVE_PLANS = 3;
    createPlan(title: string, description: string, stepDescriptions: string[], priority?: number): DevPlan;
    getPlan(id: string): DevPlan | undefined;
    getActivePlan(): DevPlan | undefined;
    listPlans(): DevPlan[];
    updateStep(planId: string, stepIndex: number, status: PlanStep['status'], result?: string): boolean;
    completePlan(planId: string, reflection?: string): boolean;
    abandonPlan(planId: string, reason?: string): boolean;
    freezePlan(planId: string, reason?: string): boolean;
    getFormattedContext(): string;
    /**
     * 清理旧计划：删除 completed（超过 completedCutoff）和 abandoned（超过 abandonedCutoff）的计划。
     * 返回删除的计划数量。
     */
    cleanupOldPlans(completedCutoff: number, abandonedCutoff: number): number;
}
