import type { WorkflowDef, WorkflowRun } from './types';
export interface WorkflowDispatch {
    runSubAgent: (goal: string, parentGoal?: string) => string;
    runTool: (name: string, args: Record<string, any>) => Promise<string>;
    runApi: (url: string, method: string, body?: any) => Promise<string>;
    injectPrompt: (prompt: string) => void;
    getCompletedAgentResults: () => {
        id: string;
        summary: string;
        error?: string;
    }[];
    runPlan: (prompt: string) => string;
    getPlanStatus: () => {
        id: string;
        title: string;
        total: number;
        done: number;
        pending: string[];
        status: string;
    } | null;
}
export declare class WorkflowScheduler {
    private dispatch;
    private pendingAgents;
    private active;
    constructor(dispatch: WorkflowDispatch);
    startRun(def: WorkflowDef): WorkflowRun;
    private executeLoop;
    private waitForAgents;
    stopRun(runId: string): boolean;
    isActive(): boolean;
}
export declare function setWorkflowScheduler(s: WorkflowScheduler): void;
export declare function getWorkflowScheduler(): WorkflowScheduler;
