import type { DevPlan } from './types';
export type AnalysisMode = 'first_run' | 'continue_plan' | 'review_only';
/**
 * tryRun 专用 prompt — 只分析，不实现。
 * 从 SelfEvolutionService 提取。
 */
export declare const ANALYSIS_PROMPT: (mode: AnalysisMode, planContext: string, historySummary: string, safetyMode: string, validationSummary?: string, promptOverlay?: string) => string;
export declare const PLAN_EXECUTE_PROMPT: (planCtx: string, stepDesc: string) => string;
/** 构建计划上下文注入字符串 */
export declare function buildPlanInjection(plan: DevPlan, doneSteps: number, totalSteps: number, pendingSteps: DevPlan['steps']): string;
/** 从多个活跃计划中选择进度最高的一个继续 */
export declare function pickBestPlan(plans: DevPlan[]): DevPlan | null;
/** 检测计划模式 */
export declare function detectPlanMode(planManager: {
    listPlans: () => DevPlan[];
    getActivePlan: () => DevPlan | null;
    freezePlan: (id: string, reason: string) => void;
} | null): {
    mode: AnalysisMode;
    planContext: string;
    planSummary?: {
        id: string;
        title: string;
        stepsComplete: number;
        stepsTotal: number;
    };
};
