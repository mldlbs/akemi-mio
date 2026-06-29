export interface OtparEntry {
    type: 'observe' | 'think' | 'reflect';
    requestId: string;
    step: number;
    durationMs?: number;
    timestamp: number;
    detail: string;
}
interface PlanStepData {
    id: string;
    description: string;
    status: string;
    result?: string;
}
interface PlanData {
    id: string;
    title: string;
    description: string;
    steps: PlanStepData[];
    status: string;
    createdAt: number;
    updatedAt: number;
}
export declare function usePlans(): {
    activePlan: PlanData | null;
    planHistory: PlanData[];
    otparStages: OtparEntry[];
};
export {};
