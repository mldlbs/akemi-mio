import type { DevPlan } from './types';
export interface IntegrityIssue {
    planId: string;
    planTitle: string;
    severity: 'error' | 'warn';
    category: 'empty_step_description' | 'step_index_gap' | 'invalid_step_status' | 'invalid_plan_status' | 'empty_title' | 'duplicate_step_index';
    description: string;
}
export interface RollbackReadiness {
    ready: boolean;
    hasGit: boolean;
    hasSnapshot: boolean;
    hasPendingChanges: boolean;
    reason?: string;
}
export interface IntegrityResult {
    passed: boolean;
    issues: IntegrityIssue[];
    checkedAt: number;
}
export declare class PlanIntegrityChecker {
    /**
     * 检查单个计划的完整性
     */
    checkPlan(plan: DevPlan): IntegrityIssue[];
    /**
     * 检查所有计划并返回结果
     */
    checkAllPlans(plans: DevPlan[]): IntegrityResult;
    /**
     * 自动修复可修复的完整性问题
     * 返回修复了的问题数量
     */
    autoFix(plan: DevPlan): {
        fixed: number;
        fixes: string[];
    };
    checkRollbackReadiness(plan: DevPlan): RollbackReadiness;
}
