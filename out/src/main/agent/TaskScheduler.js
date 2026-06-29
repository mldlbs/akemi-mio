import { log } from '../logger/Logger';
export var TaskPriority;
(function (TaskPriority) {
    TaskPriority[TaskPriority["CHAT"] = 0] = "CHAT";
    TaskPriority[TaskPriority["EVOLUTION"] = 1] = "EVOLUTION";
    TaskPriority[TaskPriority["BACKGROUND"] = 2] = "BACKGROUND";
})(TaskPriority || (TaskPriority = {}));
/**
 * TaskScheduler — 后台任务调度器
 *
 * 支持优先级和打断机制。Evolution 等后台任务通过此调度器注册。
 * Chat 直接走 AgentService.processTextInput，不走此调度器。
 */
export class TaskScheduler {
    constructor() {
        this.tasks = new Map();
        this.preemptHandler = null;
        this.running = false;
        this.currentTask = null;
    }
    setPreemptHandler(handler) {
        this.preemptHandler = handler;
    }
    /** v2: register Evolution 任务（SelfEvolutionService.setTaskScheduler 调用） */
    register(type, label, priority, intervalMs, handler) {
        const id = `task_${type}_${Date.now().toString(36)}`;
        const task = { id, label, priority, intervalMs, handler, lastRun: 0, running: false };
        this.tasks.set(id, task);
        log('INFO', 'task_scheduler_registered', { id, type, label, priority, intervalMs });
        return id;
    }
    start() {
        if (this.running)
            return;
        this.running = true;
        for (const [, task] of this.tasks) {
            this.scheduleTask(task);
        }
        log('INFO', 'task_scheduler_started', { taskCount: this.tasks.size });
    }
    stop() {
        for (const [, task] of this.tasks) {
            if (task.timerId)
                clearInterval(task.timerId);
        }
        this.running = false;
        this.currentTask = null;
        log('INFO', 'task_scheduler_stopped');
    }
    /** 是否有高优任务正在执行 */
    isBusy() {
        return this.currentTask !== null && this.currentTask.priority <= TaskPriority.EVOLUTION;
    }
    /** 抢占当前后台任务（新用户输入时调用） */
    async preemptCurrent(reason) {
        if (this.currentTask) {
            log('INFO', 'task_scheduler_preempt', { task: this.currentTask.id, reason });
            this.preemptHandler?.();
            this.currentTask = null;
        }
    }
    scheduleTask(task) {
        task.timerId = setInterval(async () => {
            if (task.running || !this.running)
                return;
            const gap = Date.now() - task.lastRun;
            if (gap < task.intervalMs - 1000)
                return;
            task.running = true;
            this.currentTask = task;
            try {
                task.lastRun = Date.now();
                await task.handler();
            }
            catch (err) {
                log('WARN', 'task_scheduler_handler_error', { id: task.id, error: err.message });
            }
            finally {
                task.running = false;
                if (this.currentTask === task)
                    this.currentTask = null;
            }
        }, Math.min(task.intervalMs, 10000));
        task.timerId.unref();
    }
}
