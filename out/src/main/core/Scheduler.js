import { eventBus } from './EventBus';
import { log } from '../logger/Logger';
let taskIdCounter = 0;
export class Scheduler {
    constructor() {
        this.tasks = new Map();
        this.timers = new Map();
    }
    nextId() {
        return `sched_${Date.now()}_${++taskIdCounter}`;
    }
    once(delayMs, handler, pluginName = '@system') {
        const id = this.nextId();
        const task = { id, pluginName, type: 'once', handler, cancelled: false };
        this.tasks.set(id, task);
        const timer = setTimeout(async () => {
            if (task.cancelled)
                return;
            await this.executeTask(task);
            this.tasks.delete(id);
        }, delayMs);
        this.timers.set(id, timer);
        return id;
    }
    interval(intervalMs, handler, pluginName = '@system') {
        const id = this.nextId();
        const task = { id, pluginName, type: 'interval', handler, cancelled: false };
        this.tasks.set(id, task);
        const timer = setInterval(async () => {
            if (task.cancelled)
                return;
            await this.executeTask(task);
        }, intervalMs);
        this.timers.set(id, timer);
        return id;
    }
    cron(minute, hour, handler, pluginName = '@system') {
        const id = this.nextId();
        const task = { id, pluginName, type: 'cron', handler, cancelled: false };
        this.tasks.set(id, task);
        const tick = () => {
            if (task.cancelled)
                return;
            const now = new Date();
            if (minute !== '*' && now.getMinutes() !== minute)
                return;
            if (hour !== '*' && now.getHours() !== hour)
                return;
            this.executeTask(task);
        };
        const timer = setInterval(tick, 30000);
        this.timers.set(id, timer);
        return id;
    }
    cancel(id) {
        const task = this.tasks.get(id);
        if (!task)
            return false;
        task.cancelled = true;
        const timer = this.timers.get(id);
        if (timer) {
            clearInterval(timer);
            this.timers.delete(id);
        }
        this.tasks.delete(id);
        return true;
    }
    cancelAll(pluginName) {
        let count = 0;
        for (const [id, task] of this.tasks) {
            if (task.pluginName === pluginName) {
                this.cancel(id);
                count++;
            }
        }
        return count;
    }
    list() {
        return Array.from(this.tasks.values());
    }
    count() {
        return this.tasks.size;
    }
    async executeTask(task) {
        eventBus.emit('scheduler.tick', { taskId: task.id, cron: task.type });
        try {
            const result = await task.handler();
            eventBus.emit('scheduler.task.completed', { taskId: task.id, result });
            log('INFO', 'scheduler_task_done', { task_id: task.id, plugin: task.pluginName });
        }
        catch (err) {
            eventBus.emit('scheduler.task.failed', { taskId: task.id, error: err.message });
            log('WARN', 'scheduler_task_error', { task_id: task.id, plugin: task.pluginName, error: err.message });
        }
    }
    shutdown() {
        for (const timer of this.timers.values()) {
            clearInterval(timer);
        }
        this.timers.clear();
        this.tasks.clear();
    }
}
export const scheduler = new Scheduler();
