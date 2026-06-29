/**
 * 统一任务状态持久化。
 * 替代 CreativityService/InsightService 各自的 setInterval 调度状态。
 */
export class TaskStore {
    constructor() {
        this.data = new Map();
    }
    get(type) {
        if (!this.data.has(type)) {
            this.data.set(type, {
                type,
                status: 'idle',
                lastRunAt: 0,
                consecutiveFailures: 0,
                cooldownUntil: 0,
                metadata: {},
            });
        }
        return this.data.get(type);
    }
    update(type, partial) {
        const current = this.get(type);
        this.data.set(type, { ...current, ...partial });
    }
    reset(type) {
        this.data.delete(type);
    }
}
