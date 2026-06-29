import { EventBus } from '../core/EventBus';
import type { PresenceState } from './types';
export declare class PresenceService {
    private state;
    private lastActivity;
    private idleTimeoutMs;
    private eventBus;
    private listeners;
    constructor(idleTimeoutMinutes?: number, bus?: EventBus);
    private markActive;
    tick(): void;
    isAway(): boolean;
    isActive(): boolean;
    getState(): PresenceState;
    getAwayDurationMs(): number;
    onTransition(cb: (from: PresenceState, to: PresenceState) => void): () => void;
    private notify;
}
