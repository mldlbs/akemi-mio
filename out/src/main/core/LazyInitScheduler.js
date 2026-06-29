import { log } from '../logger/Logger';
/**
 * 延迟初始化调度器 — 按优先级分阶段启动非关键服务
 *
 * 关键(critical) → 立即（微任务）
 * 普通(normal) → 下一帧（setImmediate/setTimeout 0）
 * 背景(background) → 延迟 3s 后启动
 *
 * 调度器本身极轻量，不产生额外依赖
 */
export class LazyInitScheduler {
    constructor() {
        this.tasks = [];
        this._started = false;
        this._completed = false;
        this.timers = new Set();
        this.completedCount = 0;
        this.failedCount = 0;
    }
    add(task) {
        this.tasks.push({ task, status: 'pending' });
        return this;
    }
    /** 批量添加任务 */
    addMany(tasks) {
        for (const t of tasks)
            this.add(t);
        return this;
    }
    /** 启动调度 */
    start() {
        if (this._started)
            return;
        this._started = true;
        log('INFO', 'lazy_init_start', { total: this.tasks.length });
        for (const record of this.tasks) {
            this.scheduleTask(record);
        }
    }
    scheduleTask(record) {
        const { task } = record;
        let delay = task.delayMs ?? 0;
        // 背景任务默认延迟 3 秒
        if (task.priority === 'background' && task.delayMs === undefined) {
            delay = 3000;
        }
        const timer = setTimeout(async () => {
            this.timers.delete(timer);
            if (record.status !== 'pending')
                return;
            record.status = 'running';
            record.startedAt = Date.now();
            log('INFO', 'lazy_init_starting', { name: task.name, priority: task.priority, delay });
            try {
                const timeoutMs = task.timeoutMs ?? (task.priority === 'background' ? 30000 : 10000);
                const result = await this.withTimeout(task.fn(), timeoutMs, task.name);
                record.status = 'completed';
                record.completedAt = Date.now();
                this.completedCount++;
                log('INFO', 'lazy_init_completed', {
                    name: task.name,
                    took_ms: record.completedAt - record.startedAt,
                });
            }
            catch (err) {
                record.status = 'failed';
                record.error = String(err);
                this.failedCount++;
                log('WARN', 'lazy_init_failed', { name: task.name, error: String(err) });
            }
            this.checkAllDone();
        }, delay);
        this.timers.add(timer);
    }
    async withTimeout(promise, timeoutMs, name) {
        if (promise instanceof Promise) {
            return Promise.race([
                promise,
                new Promise((_, reject) => setTimeout(() => reject(new Error(`lazy init timeout "${name}" after ${timeoutMs}ms`)), timeoutMs)),
            ]);
        }
        return promise;
    }
    checkAllDone() {
        const allDone = this.tasks.every((t) => t.status === 'completed' || t.status === 'failed');
        if (allDone) {
            this._completed = true;
            log('INFO', 'lazy_init_all_done', {
                total: this.tasks.length,
                completed: this.completedCount,
                failed: this.failedCount,
            });
        }
    }
    /** 获取任务状态报告 */
    getStatus() {
        return {
            started: this._started,
            completed: this._completed,
            total: this.tasks.length,
            done: this.completedCount,
            failed: this.failedCount,
            tasks: this.tasks.map((r) => ({ name: r.task.name, status: r.status, error: r.error })),
        };
    }
    /** 停止所有待执行的任务 */
    cancel() {
        for (const timer of this.timers) {
            clearTimeout(timer);
        }
        this.timers.clear();
        for (const record of this.tasks) {
            if (record.status === 'pending') {
                record.status = 'failed';
                record.error = 'cancelled';
            }
        }
        this._completed = true;
        log('INFO', 'lazy_init_cancelled', { remaining: this.timers.size });
    }
    /** 是否所有任务已完成（含失败） */
    get isCompleted() {
        return this._completed;
    }
}
