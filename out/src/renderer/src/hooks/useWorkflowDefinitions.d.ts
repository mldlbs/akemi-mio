interface WorkflowDef {
    id: string;
    name: string;
    description: string;
    steps: any[];
    createdAt: number;
    updatedAt: number;
}
interface WorkflowStepRun {
    stepId: string;
    status: string;
    agentResult?: string;
    error?: string;
    startedAt?: number;
    completedAt?: number;
}
interface WorkflowRun {
    runId: string;
    workflowDefId: string;
    workflowName: string;
    status: string;
    steps: WorkflowStepRun[];
    startedAt: number;
    completedAt?: number;
}
export declare function useWorkflowDefinitions(): {
    definitions: WorkflowDef[];
    runs: WorkflowRun[];
    activeRuns: WorkflowRun[];
    loading: boolean;
    refresh: () => void;
};
export {};
