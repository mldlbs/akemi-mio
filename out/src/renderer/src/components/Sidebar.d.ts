import type { SessionItem } from '../slots/types';
interface SidebarProps {
    sessions: SessionItem[];
    activeSessionId: string;
    onSelectChat: (id: string) => void;
}
export declare function Sidebar({ sessions, activeSessionId, onSelectChat }: SidebarProps): import("react/jsx-runtime").JSX.Element;
export {};
