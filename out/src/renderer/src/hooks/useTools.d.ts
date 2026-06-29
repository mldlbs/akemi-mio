import type { ToolEvent } from '../slots/types';
export declare function useTools(): {
    readonly toolRunning: ToolEvent[];
    readonly toolCompleted: ToolEvent[];
};
