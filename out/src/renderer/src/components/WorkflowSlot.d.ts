import type { OtparEntry } from '../hooks/usePlans';
export interface WorkflowSlotProps {
    activePlan: any;
    otparStages: OtparEntry[];
    workflowDefs: any[];
    workflowRuns: any[];
    workflowActiveRuns: any[];
    wfLoading: boolean;
    onRefreshDefs?: () => void;
}
export declare function WorkflowSlot({ activePlan, otparStages, workflowDefs, workflowRuns, workflowActiveRuns, wfLoading, onRefreshDefs, }: WorkflowSlotProps): import("react/jsx-runtime").JSX.Element;
