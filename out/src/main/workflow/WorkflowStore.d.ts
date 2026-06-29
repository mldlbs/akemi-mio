import type { WorkflowDef, WorkflowRun } from './types';
export declare class WorkflowStore {
    listDefinitions(): WorkflowDef[];
    getDefinition(id: string): WorkflowDef | null;
    saveDefinition(def: WorkflowDef): void;
    deleteDefinition(id: string): boolean;
    listRuns(limit?: number): WorkflowRun[];
    getRun(runId: string): WorkflowRun | null;
    createRun(def: WorkflowDef): WorkflowRun;
    updateRun(run: WorkflowRun): void;
    updateStep(run: WorkflowRun, stepId: string, status: string, result?: string, error?: string): void;
    private seeded;
    private seedPresets;
}
export declare const workflowStore: WorkflowStore;
