import type { ToolEvent } from '../slots/types';
interface ToolSlotProps {
    running?: ToolEvent[];
    completed?: ToolEvent[];
}
export declare function ToolSlot({ running, completed }: ToolSlotProps): import("react/jsx-runtime").JSX.Element;
export {};
