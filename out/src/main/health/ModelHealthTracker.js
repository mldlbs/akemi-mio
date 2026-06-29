import { log } from '../logger/Logger';
import { eventBus, SubscriptionTracker } from '../core/EventBus';
/**
 * ModelHealthTracker — 4-health-dimension: LLM/tool error rate tracking.
 *
 * Listens to EventBus for tool completion/failure and error classification
 * events, producing a health score (0-100) for the model dimension.
 */
export class ModelHealthTracker {
    constructor() {
        this.errorCounts = {};
        this.successCount = 0;
        this.failureCount = 0;
        this.subs = new SubscriptionTracker();
        this._started = false;
    }
    start() {
        if (this._started)
            return;
        this._started = true;
        eventBus.track('agent.tool.completed', () => {
            this.successCount++;
        }, this.subs, 'mht:completed');
        eventBus.track('agent.tool.failed', () => {
            this.failureCount++;
        }, this.subs, 'mht:failed');
        eventBus.track('recovery.error.classified', (p) => {
            const cat = p.category || 'UNKNOWN';
            this.errorCounts[cat] = (this.errorCounts[cat] || 0) + 1;
        }, this.subs, 'mht:classified');
        log('INFO', 'model_health_tracker.started');
    }
    stop() {
        this.subs.dispose();
        this._started = false;
    }
    getHealth() {
        const total = this.successCount + this.failureCount;
        let score = 100;
        if (total > 0) {
            const successRate = this.successCount / total;
            const diversityPenalty = Math.min(1, Object.keys(this.errorCounts).length * 0.15);
            score = Math.round(successRate * 100 * (1 - diversityPenalty));
        }
        return {
            score: Math.max(0, score),
            errorBreakdown: { ...this.errorCounts },
            totalToolCalls: total,
            successCount: this.successCount,
            failureCount: this.failureCount,
        };
    }
    getDiagnostics() {
        return {
            errorCounts: this.errorCounts,
            successCount: this.successCount,
            failureCount: this.failureCount,
        };
    }
}
