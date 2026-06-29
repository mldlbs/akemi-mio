/**
 * @deprecated TaskScheduler 已被 TaskRunner 取代。
 * stability.tick 已迁移到 TaskRunner，保留此类仅作参考。
 * 新代码请使用 src/main/core/tasks/unified/TaskRunner.ts
 */
import { scheduler as defaultScheduler } from '../Scheduler';
/** @deprecated 使用 TaskRunner 代替 */
export class TaskScheduler {
    constructor(registry, options) {
        this.instances = new Map();
        this.services = {};
        this.running = false;
        this.taskIdSeq = 0;
        this.stabilityScore = null;
        this.resourceBudget = null;
        this.graph = null;
        this.registry = registry;
        this.scheduler = options?.scheduler ?? defaultScheduler;
        this.emitFn = options?.emit ?? (() => { });
        this.logFn = options?.log ?? (() => { });
        this.resourceBudget = options?.resourceBudget ?? null;
        this.graph = options?.taskGraph ?? null;
    }
    setServices(svcs) {
        this.services = svcs;
    }
    setStabilityScore(ss) {
        this.stabilityScore = ss;
    }
    setBudget(budget) {
        this.resourceBudget = budget;
    }
    register(type, schedule, input, priority = 'normal', tags) {
        const id = `task_${type}_${++this.taskIdSeq}_${Date.now().toString(36)}`;
        const task = {
            id,
            type,
            input: input ?? {},
            status: 'pending',
            schedule,
            priority,
            createdAt: Date.now(),
            tags,
        };
        this.instances.set(id, {
            task: task,
            schedule,
            schedId: null,
            abortController: null,
            lastRunAt: 0,
            lastCompletedAt: 0,
            consecutiveFailures: 0,
        });
        return id;
    }
    start() {
        if (this.running)
            return;
        this.running = true;
        for (const [, instance] of this.instances) {
            this.scheduleInstance(instance);
        }
        this.logFn('INFO', 'task_scheduler_started', { taskCount: this.instances.size });
    }
    stop() {
        for (const [, instance] of this.instances) {
            this.stopInstance(instance);
        }
        this.running = false;
        this.logFn('INFO', 'task_scheduler_stopped');
    }
    startTask(id) {
        const instance = this.instances.get(id);
        if (!instance || instance.schedId)
            return false;
        this.scheduleInstance(instance);
        return true;
    }
    stopTask(id) {
        const instance = this.instances.get(id);
        if (!instance)
            return false;
        this.stopInstance(instance);
        return true;
    }
    async trigger(id) {
        const instance = this.instances.get(id);
        if (!instance)
            throw new Error(`Task "${id}" not registered`);
        await this.executeTask(instance);
    }
    async triggerByType(type) {
        for (const [, instance] of this.instances) {
            if (instance.task.type === type) {
                await this.executeTask(instance);
                return;
            }
        }
        throw new Error(`No task found with type "${type}"`);
    }
    pauseTask(id) {
        const instance = this.instances.get(id);
        if (!instance)
            return false;
        if (instance.schedId) {
            this.scheduler.cancel(instance.schedId);
            instance.schedId = null;
        }
        instance.task.status = 'cancelled';
        return true;
    }
    resumeTask(id) {
        const instance = this.instances.get(id);
        if (!instance)
            return false;
        if (!instance.schedId && this.running) {
            this.scheduleInstance(instance);
            instance.task.status = 'pending';
            return true;
        }
        return false;
    }
    listTasks() {
        return Array.from(this.instances.entries()).map(([id, inst]) => ({
            id,
            type: inst.task.type,
            status: inst.task.status,
            lastRun: inst.lastRunAt,
            failures: inst.consecutiveFailures,
        }));
    }
    getTask(id) {
        return this.instances.get(id)?.task;
    }
    isRunning() {
        return this.running;
    }
    get size() {
        return this.instances.size;
    }
    scheduleInstance(instance) {
        if (instance.schedId)
            return;
        const tier = instance.task.tier ?? instance.schedule.tier ?? 'standard';
        // 非 background 层级的任务注册到 TaskGraph（用于依赖感知调度）
        if (this.graph && tier !== 'background') {
            const deps = instance.task.input?.dependsOn ?? [];
            this.graph.addNode(instance.task.id, {
                dependsOn: deps,
                blocks: [],
                produces: [],
            });
        }
        const handler = () => this.executeTask(instance);
        switch (instance.schedule.type) {
            case 'interval': {
                const ms = instance.schedule.intervalMs;
                const jitter = instance.schedule.jitterMs ?? 0;
                const totalMs = ms + (jitter > 0 ? Math.floor(Math.random() * jitter) - Math.floor(jitter / 2) : 0);
                const interval = Math.max(totalMs, 1000);
                instance.schedId = this.scheduler.interval(interval, handler, `@task-${instance.task.type}`);
                break;
            }
            case 'cron': {
                const cron = instance.schedule.cron;
                instance.schedId = this.scheduler.cron(cron.minute ?? '*', cron.hour ?? '*', handler, `@task-${instance.task.type}`);
                break;
            }
            case 'conditional': {
                const checkMs = Math.min(instance.schedule.intervalMs ?? 60000, 60000);
                instance.schedId = this.scheduler.interval(checkMs, async () => {
                    const shouldRun = instance.schedule.shouldRun ? await Promise.resolve(instance.schedule.shouldRun()) : true;
                    if (!shouldRun)
                        return 'skipped';
                    return handler();
                }, `@task-${instance.task.type}`);
                break;
            }
            case 'manual':
                instance.schedId = `manual_${instance.task.id}`;
                break;
        }
    }
    stopInstance(instance) {
        if (instance.schedId && !instance.schedId.startsWith('manual_')) {
            this.scheduler.cancel(instance.schedId);
        }
        instance.schedId = null;
        if (instance.abortController) {
            instance.abortController.abort('shutdown');
            instance.abortController = null;
        }
        instance.task.status = 'cancelled';
    }
    async executeTask(instance) {
        const now = Date.now();
        const minGap = instance.schedule.minGapMs ?? 0;
        if (instance.lastRunAt > 0 && now - instance.lastRunAt < minGap) {
            return 'skipped (min_gap)';
        }
        if (instance.abortController) {
            return 'skipped (already_running)';
        }
        const handler = this.registry.getHandler(instance.task.type);
        if (!handler) {
            const err = `No handler registered for task type "${instance.task.type}"`;
            this.logFn('ERROR', 'task_no_handler', { type: instance.task.type });
            this.emitLifecycle(instance.task, 'failed', err);
            return err;
        }
        const abortController = new AbortController();
        instance.abortController = abortController;
        instance.task.status = 'running';
        instance.lastRunAt = now;
        instance.task.startedAt = now;
        this.emitLifecycle(instance.task, 'running');
        try {
            const context = {
                signal: abortController.signal,
                services: this.services,
                emit: (event, payload) => this.emitFn(event, payload),
                log: (level, msg, meta) => this.logFn(level, msg, meta),
            };
            const output = await handler(instance.task, context);
            instance.task.output = output;
            instance.task.status = 'completed';
            instance.task.completedAt = Date.now();
            instance.lastCompletedAt = Date.now();
            instance.consecutiveFailures = 0;
            this.emitLifecycle(instance.task, 'completed');
            return 'completed';
        }
        catch (err) {
            instance.task.status = 'failed';
            instance.task.error = err.message;
            instance.task.completedAt = Date.now();
            instance.consecutiveFailures++;
            this.emitLifecycle(instance.task, 'failed', err.message);
            this.logFn('WARN', 'task_execution_failed', { type: instance.task.type, error: err.message });
            return `failed: ${err.message}`;
        }
        finally {
            instance.abortController = null;
        }
    }
    emitLifecycle(task, status, error) {
        this.emitFn('task.lifecycle', {
            taskId: task.id,
            type: task.type,
            status,
            durationMs: task.startedAt ? Date.now() - task.startedAt : undefined,
            error,
        });
    }
}
