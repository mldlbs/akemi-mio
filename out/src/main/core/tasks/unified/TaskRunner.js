import { TaskTier } from './TaskTypes';
import { TaskStore } from './TaskStore';
import { log } from '../../../logger/Logger';
import { eventBus } from '../../../core/EventBus';
/** 根据 Tier 确定默认 maxFailures */
function defaultMaxFailuresByTier(tier) {
    switch (tier) {
        case TaskTier.CRITICAL:
            return 10;
        case TaskTier.IMPORTANT:
            return 5;
        case TaskTier.BEST_EFFORT:
            return 3;
        default:
            return 3;
    }
}
/**
 * 统一后台任务执行编排器。
 * 内置：冷却管理、指数退避、最小间隔、事件发射。
 */
export class TaskRunner {
    constructor(taskStore) {
        this.tasks = new Map();
        this.timers = new Map();
        this.abortControllers = new Map();
        this.started = false;
        this.store = taskStore ?? new TaskStore();
    }
    register(type, executor, intervalMs, options) {
        const tier = options?.tier ?? TaskTier.BEST_EFFORT;
        this.tasks.set(type, {
            type,
            executor,
            intervalMs,
            cooldownMs: options?.cooldownMs ?? intervalMs,
            maxFailures: options?.maxFailures ?? defaultMaxFailuresByTier(tier),
            retryBaseMs: options?.retryBaseMs ?? 1000,
            tier,
        });
        // 如果 runner 已启动，注册后立即启动定时器
        if (this.started) {
            this.startTimer(type);
        }
    }
    startTimer(type) {
        if (this.timers.has(type))
            return;
        const task = this.tasks.get(type);
        if (!task)
            return;
        const timer = setInterval(() => this.tick(type), task.intervalMs);
        this.timers.set(type, timer);
        log('INFO', 'task_runner_started', { type, interval_ms: task.intervalMs });
    }
    start() {
        if (this.started)
            return;
        this.started = true;
        for (const [type] of this.tasks) {
            this.startTimer(type);
        }
    }
    stop() {
        for (const [type, timer] of this.timers) {
            clearInterval(timer);
            this.abortControllers.get(type)?.abort();
            log('INFO', 'task_runner_stopped', { type });
        }
        this.timers.clear();
        this.abortControllers.clear();
    }
    stopType(type) {
        const timer = this.timers.get(type);
        if (timer) {
            clearInterval(timer);
            this.timers.delete(type);
        }
        this.abortControllers.get(type)?.abort();
        this.abortControllers.delete(type);
    }
    async triggerNow(type) {
        return this.tick(type);
    }
    getState(type) {
        return this.store.get(type);
    }
    has(type) {
        return this.tasks.has(type);
    }
    /** 获取所有任务的健康摘要 */
    getTaskHealthSummary() {
        const summary = [];
        for (const [type] of this.tasks) {
            const state = this.store.get(type);
            const task = this.tasks.get(type);
            const disabled = task?.tier === TaskTier.BEST_EFFORT && state.consecutiveFailures >= task.maxFailures;
            summary.push({
                type,
                status: state.status,
                consecutiveFailures: state.consecutiveFailures,
                tier: task?.tier ?? TaskTier.BEST_EFFORT,
                disabled,
            });
        }
        return summary;
    }
    async tick(type) {
        const task = this.tasks.get(type);
        if (!task)
            return;
        const state = this.store.get(type);
        if (state.status === 'cooldown') {
            if (Date.now() < state.cooldownUntil)
                return;
            this.store.update(type, { status: 'idle', consecutiveFailures: 0, cooldownUntil: 0 });
        }
        if (state.status === 'running')
            return;
        if (state.lastRunAt > 0 && Date.now() - state.lastRunAt < task.intervalMs * 0.5)
            return;
        const ac = new AbortController();
        this.abortControllers.set(type, ac);
        this.store.update(type, { status: 'running', lastRunAt: Date.now() });
        eventBus.emit(`${type}.started`, { timestamp: Date.now() });
        let result;
        try {
            result = await task.executor({ state, signal: ac.signal });
        }
        catch (err) {
            result = { success: false, summary: err.message };
        }
        if (result.success) {
            this.store.update(type, { status: 'idle', consecutiveFailures: 0 });
            if (type !== 'telegram.outbox') {
                log('INFO', 'task_runner_completed', { type, summary: result.summary?.slice(0, 100) });
            }
        }
        else {
            const failures = state.consecutiveFailures + 1;
            if (failures >= task.maxFailures) {
                // BEST_EFFORT 任务达到上限后停止定时器（不再重试），其余进入 cooldown
                if (task.tier === TaskTier.BEST_EFFORT) {
                    this.stopType(type);
                    log('WARN', 'task_runner_disabled', { type, failures, tier: task.tier });
                    eventBus.emit(`${type}.completed`, {
                        success: false,
                        summary: `disabled after ${failures} consecutive failures`,
                        timestamp: Date.now(),
                    });
                    this.abortControllers.delete(type);
                    return;
                }
                this.store.update(type, {
                    status: 'cooldown',
                    consecutiveFailures: failures,
                    cooldownUntil: Date.now() + task.cooldownMs,
                });
                log('WARN', 'task_runner_cooldown', { type, failures, cooldownMs: task.cooldownMs });
            }
            else {
                this.store.update(type, { status: 'idle', consecutiveFailures: failures });
            }
            log('WARN', 'task_runner_failed', { type, summary: result.summary?.slice(0, 100) });
        }
        eventBus.emit(`${type}.completed`, {
            success: result.success,
            summary: result.summary,
            timestamp: Date.now(),
        });
        this.abortControllers.delete(type);
    }
}
