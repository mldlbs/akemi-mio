import { eventBus } from '../core/EventBus';
import { log } from '../logger/Logger';
export class PresenceService {
    constructor(idleTimeoutMinutes = 5, bus) {
        this.state = 'active';
        this.lastActivity = Date.now();
        this.listeners = [];
        this.idleTimeoutMs = idleTimeoutMinutes * 60 * 1000;
        this.eventBus = bus || eventBus;
        this.eventBus.on('agent.input.received', () => this.markActive());
    }
    markActive() {
        const prev = this.state;
        const awayMs = Date.now() - this.lastActivity;
        this.lastActivity = Date.now();
        if (prev === 'away') {
            this.state = 'active';
            this.notify(prev, 'active');
            log('INFO', 'presence_returned', { away_ms: awayMs });
        }
    }
    tick() {
        const prev = this.state;
        const awayMs = Date.now() - this.lastActivity;
        if (prev === 'active' && awayMs >= this.idleTimeoutMs) {
            this.state = 'away';
            this.notify(prev, 'away');
            log('INFO', 'presence_away', { idle_ms: awayMs });
        }
    }
    isAway() {
        return this.state === 'away';
    }
    isActive() {
        return this.state === 'active';
    }
    getState() {
        return this.state;
    }
    getAwayDurationMs() {
        if (this.state === 'away')
            return Date.now() - this.lastActivity;
        return 0;
    }
    onTransition(cb) {
        this.listeners.push(cb);
        return () => {
            this.listeners = this.listeners.filter(l => l !== cb);
        };
    }
    notify(from, to) {
        for (const cb of this.listeners) {
            try {
                cb(from, to);
            }
            catch { /* guard */ }
        }
    }
}
