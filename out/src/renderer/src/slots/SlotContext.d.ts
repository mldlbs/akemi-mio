import { type ReactNode } from 'react';
import type { UiState, ActiveSlot } from './types';
interface SlotContextValue {
    uiState: UiState;
    setActiveSlot: (slot: ActiveSlot) => void;
    toggleSidebar: () => void;
}
export declare function SlotProvider({ children }: {
    children: ReactNode;
}): import("react/jsx-runtime").JSX.Element;
export declare function useSlots(): SlotContextValue;
export {};
