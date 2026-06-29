import { AsyncLock } from '../utils/AsyncLock';
import type { DevPlan, PlanStep } from './types';
export declare class DrizzlePlanManager {
    readonly lock: AsyncLock;
    /** 当前活跃计划上限 */
    static readonly MAX_ACTIVE_PLANS = 3;
    createPlan(title: string, description: string, stepDescriptions: string[], priority?: number): DevPlan;
    getPlan(id: string): DevPlan | undefined;
    getActivePlan(): DevPlan | undefined;
    /** 标题相似度阈值 (0-1)，低于此值视为重复计划 */
    private static readonly TITLE_SIMILARITY_THRESHOLD;
    /** 归一化标题：去空格、转小写、去标点 */
    private normalizeTitle;
    /** 计算两个规范化标题的 Dice 系数相似度 */
    private titleSimilarity;
    /** 精确匹配：数据库层查询活跃计划标题 */
    private findExactTitleMatch;
    /** 检查是否有标题相似度超过阈值的活跃计划 */
    private findSimilarActivePlan;
    private getActivePlanByTitle;
    listPlans(): DevPlan[];
    updateStep(planId: string, stepIndex: number, status: PlanStep['status'], result?: string): boolean;
    completePlan(planId: string, reflection?: string): boolean;
    abandonPlan(planId: string, reason?: string): boolean;
    freezePlan(planId: string, reason?: string): boolean;
    /** 返回所有活跃计划列表 */
    private listActivePlans;
    getFormattedContext(): string;
    /**
     * 清理旧计划：删除 completed（超过 completedCutoff）和 abandoned（超过 abandonedCutoff）的计划
     * 同时清理关联的 plan_steps。返回删除的计划数量。
     */
    cleanupOldPlans(completedCutoff: number, abandonedCutoff: number): number;
    private createInMemoryPlan;
    private hydratePlan;
}
