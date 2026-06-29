import { Worker } from 'worker_threads';
import { join } from 'path';
import { log } from '../logger/Logger';
import { eventBus } from './EventBus';
/**
 * Worker 线程池 — 管理后台服务的 Worker 生命周期。
 *
 * 实现 ISubsystem 接口，支持：
 * - 健康探针（ping/pong，15s 间隔）
 * - 自动重启（指数退避 1s→2s→4s→8s→30s）
 * - 优雅关闭（5s 超时后 terminate）
 * - 重启风暴检测（5分钟 >5 次 → 发出事件）
 */
export class WorkerPool {
    constructor(options = {}) {
        this.name = 'WorkerPool';
        this.state = 'created';
        this.workers = new Map();
        this.healthTimer = null;
        this.responseHandlers = new Map();
        this.maxWorkers = options.maxWorkers || 4;
        this.workerDir = options.workerDir || join(__dirname, 'workers');
    }
    register(name, workerFile) {
        if (this.workers.has(name)) {
            log('WARN', 'workerpool.already_registered', { name });
            return;
        }
        this.spawnWorker(name, workerFile);
    }
    sendTask(name, taskId, method, data) {
        const reg = this.workers.get(name);
        if (!reg)
            throw new Error(`Worker "${name}" not registered`);
        const msg = { type: 'task', taskId, name, method, data };
        reg.busy = true;
        reg.pendingTasks.add(taskId);
        reg.worker.postMessage(msg);
    }
    sendTaskAndWait(name, method, data, timeoutMs = 30000) {
        return new Promise((resolve, reject) => {
            const taskId = `tw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const reg = this.workers.get(name);
            if (!reg)
                return reject(new Error(`Worker "${name}" not registered`));
            const timer = setTimeout(() => {
                this.responseHandlers.delete(taskId);
                reg.pendingTasks.delete(taskId);
                reject(new Error(`Worker task ${method} timeout after ${timeoutMs}ms`));
            }, timeoutMs);
            this.responseHandlers.set(taskId, {
                resolve: (data) => {
                    clearTimeout(timer);
                    resolve(data);
                },
                reject: (err) => {
                    clearTimeout(timer);
                    reject(err);
                },
            });
            reg.busy = true;
            reg.pendingTasks.add(taskId);
            reg.worker.postMessage({ type: 'task', taskId, name, method, data });
        });
    }
    isActive(name) {
        const reg = this.workers.get(name);
        if (!reg)
            return false;
        try {
            reg.worker.threadId;
            return true;
        }
        catch {
            return false;
        }
    }
    isBusy(name) {
        return this.workers.get(name)?.busy ?? false;
    }
    // ==================== ISubsystem ====================
    async init() {
        if (this.state !== 'created')
            return;
        this.state = 'initializing';
        log('INFO', 'workerpool.init');
        this.state = 'ready';
    }
    async start() {
        if (this.state !== 'ready')
            return;
        this.state = 'running';
        this.healthTimer = setInterval(() => this.checkAllWorkers(), 15000);
        this.healthTimer.unref();
        log('INFO', 'workerpool.started', { maxWorkers: this.maxWorkers });
    }
    async stop() {
        if (this.state !== 'running')
            return;
        this.state = 'stopping';
        if (this.healthTimer) {
            clearInterval(this.healthTimer);
            this.healthTimer = null;
        }
        const promises = [];
        for (const [name, reg] of this.workers) {
            promises.push(this.gracefulShutdown(name, reg));
        }
        await Promise.all(promises);
        this.responseHandlers.clear();
        this.state = 'stopped';
        log('INFO', 'workerpool.stopped');
    }
    async destroy() {
        await this.stop();
        this.workers.clear();
        log('INFO', 'workerpool.destroyed');
    }
    async healthCheck() {
        const alive = this.workers.size;
        const dead = Array.from(this.workers.values()).filter((r) => {
            try {
                r.worker.threadId;
                return false;
            }
            catch {
                return true;
            }
        }).length;
        return {
            healthy: dead === 0,
            detail: dead > 0 ? `${dead} worker(s) dead of ${alive}` : `${alive} worker(s) running`,
            metrics: { alive, dead },
        };
    }
    // ==================== 内部方法 ====================
    spawnWorker(name, workerFile) {
        const workerPath = join(this.workerDir, workerFile);
        log('INFO', 'workerpool.spawning', { name, path: workerPath });
        let worker;
        try {
            worker = new Worker(workerPath, {
                workerData: { workerName: name },
            });
        }
        catch (err) {
            log('ERROR', 'workerpool.spawn_failed', { name, error: err.message });
            return;
        }
        const registration = {
            name,
            worker,
            busy: false,
            startTime: Date.now(),
            failedPings: 0,
            restartCount: 0,
            lastRestartTime: 0,
            workerFile,
            pendingTasks: new Set(),
        };
        worker.on('message', (msg) => {
            if (msg.type === 'result') {
                registration.busy = false;
                registration.pendingTasks.delete(msg.taskId);
                const handler = this.responseHandlers.get(msg.taskId);
                if (handler) {
                    this.responseHandlers.delete(msg.taskId);
                    if (msg.success)
                        handler.resolve(msg.data);
                    else
                        handler.reject(new Error(msg.error || 'Worker task failed'));
                }
            }
            else if (msg.type === 'lifecycle' && msg.event === 'started') {
                log('INFO', 'workerpool.worker_started', { name });
            }
            else if (msg.type === 'lifecycle' && msg.event === 'error') {
                log('ERROR', 'workerpool.worker_error', { name, error: msg.error });
            }
            else if (msg.type === 'pong') {
                registration.failedPings = 0;
            }
        });
        worker.on('error', (err) => {
            log('ERROR', 'workerpool.worker_error_event', { name, error: err.message });
            registration.busy = false;
        });
        worker.on('exit', (code) => {
            // Clear busy flag and pending task handlers on exit
            registration.busy = false;
            for (const taskId of registration.pendingTasks) {
                const handler = this.responseHandlers.get(taskId);
                if (handler) {
                    this.responseHandlers.delete(taskId);
                    handler.reject(new Error(`Worker ${name} exited (code ${code})`));
                }
            }
            registration.pendingTasks.clear();
            if (code !== 0) {
                log('WARN', 'workerpool.worker_exited', { name, code });
                if (this.state === 'running') {
                    this.attemptRestart(name);
                }
            }
            this.workers.delete(name);
        });
        this.workers.set(name, registration);
    }
    async gracefulShutdown(name, reg) {
        const TIMEOUT_MS = 5000;
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                log('WARN', 'workerpool.shutdown_timeout', { name });
                try {
                    reg.worker.terminate();
                }
                catch { }
                resolve();
            }, TIMEOUT_MS);
            reg.worker.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
            try {
                reg.worker.postMessage({ type: 'shutdown' });
            }
            catch {
                clearTimeout(timer);
                resolve();
            }
        });
    }
    checkAllWorkers() {
        for (const [name, reg] of this.workers) {
            try {
                reg.worker.postMessage({ type: 'ping', id: Date.now() });
            }
            catch {
                reg.failedPings++;
                if (reg.failedPings >= 2) {
                    log('WARN', 'workerpool.health_check_failed', { name, failedPings: reg.failedPings });
                    this.attemptRestart(name);
                }
            }
        }
    }
    attemptRestart(name) {
        const reg = this.workers.get(name);
        if (!reg || !reg.workerFile)
            return;
        const now = Date.now();
        if (now - reg.lastRestartTime < 300000) {
            reg.restartCount++;
        }
        else {
            reg.restartCount = 1;
        }
        reg.lastRestartTime = now;
        if (reg.restartCount > 5) {
            log('ERROR', 'workerpool.restart_storm', { name, count: reg.restartCount });
            eventBus.emit('worker.cycle_failed', { name, restarts: reg.restartCount, periodMs: 300000 });
            return;
        }
        const delay = Math.min(1000 * Math.pow(2, reg.restartCount - 1), 30000);
        log('INFO', 'workerpool.scheduling_restart', { name, delayMs: delay, attempt: reg.restartCount });
        setTimeout(() => {
            try {
                reg.worker.terminate();
            }
            catch { }
            this.workers.delete(name);
            this.spawnWorker(name, reg.workerFile);
        }, delay);
    }
}
