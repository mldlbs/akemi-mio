export interface PlanStep {
    id: string;
    description: string;
    status: 'pending' | 'in_progress' | 'done' | 'failed';
    result?: string;
}
export interface DevPlan {
    id: string;
    title: string;
    description: string;
    steps: PlanStep[];
    status: 'active' | 'completed' | 'abandoned' | 'frozen';
    createdAt: number;
    updatedAt: number;
    reflection?: string;
    /** 优先级（0=普通，1=高，2=紧急），用于执行排序 */
    priority?: number;
}
export interface PlanManagerLike {
    getActivePlan: () => DevPlan | undefined;
    getPlan: (id: string) => DevPlan | undefined;
    listPlans: () => DevPlan[];
    createPlan: (title: string, description: string, stepDescriptions: string[], priority?: number) => DevPlan;
    updateStep: (planId: string, stepIndex: number, status: PlanStep['status'], result?: string) => boolean;
    completePlan: (planId: string, reflection?: string) => boolean;
    abandonPlan: (planId: string, reason?: string) => boolean;
    freezePlan: (planId: string, reason?: string) => boolean;
    getFormattedContext: () => string;
    cleanupOldPlans: (completedCutoff: number, abandonedCutoff: number) => number;
    lock: {
        run: <T>(fn: () => Promise<T>) => Promise<T>;
    };
}
export type EvolutionSafetyMode = 'review' | 'auto';
export interface PlanStoreData {
    version: number;
    plans: DevPlan[];
}
