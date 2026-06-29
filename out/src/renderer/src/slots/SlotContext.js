import { jsx as _jsx } from "react/jsx-runtime";
import { createContext, useContext, useState, useCallback } from 'react';
const SlotContext = createContext(null);
export function SlotProvider({ children }) {
    const [uiState, setUiState] = useState({
        sidebarOpen: true,
        activeSlot: 'chat',
    });
    const setActiveSlot = useCallback((slot) => {
        setUiState((s) => ({ ...s, activeSlot: slot }));
    }, []);
    const toggleSidebar = useCallback(() => {
        setUiState((s) => ({ ...s, sidebarOpen: !s.sidebarOpen }));
    }, []);
    return _jsx(SlotContext.Provider, { value: { uiState, setActiveSlot, toggleSidebar }, children: children });
}
export function useSlots() {
    const ctx = useContext(SlotContext);
    if (!ctx)
        throw new Error('useSlots must be used within SlotProvider');
    return ctx;
}
