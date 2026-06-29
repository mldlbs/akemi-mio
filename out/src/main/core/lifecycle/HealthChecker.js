import { log } from '../../logger/Logger';
import { eventBus } from '../EventBus';
/**
 * HealthChecker — 周期性健康检查调度器
 *
 * 对所有注册的子系统定期执行健康检查。
 * 维护滚动健康历史，状态变更时发射事件。
 */
export class HealthChecker {
    constructor(intervalMs = 30000) {
        this.name = 'HealthChecker';
        this.state = 'created';
        this.subsystems = new Map();
        this.healthHistory = new Map();
        this.timer = null;
        this.maxHistory = 10;
        this.checkInProgress = false;
        this.intervalMs = intervalMs;
    }
    /** 设置检查间隔（运行时调整） */
    setInterval(ms) {
        this.intervalMs = ms;
        if (this.timer) {
            this.restartTimer();
        }
    }
    /** 注册子系统 */
    register(subsystem) {
        this.subsystems.set(subsystem.name, subsystem);
        if (!this.healthHistory.has(subsystem.name)) {
            this.healthHistory.set(subsystem.name, []);
        }
        log('INFO', 'healthcheck.subsystem_registered', { name: subsystem.name });
    }
    /** 注销子系统 */
    unregister(name) {
        this.subsystems.delete(name);
        this.healthHistory.delete(name);
    }
    /** 获取子系统最近的健康状态摘要 */
    getHealthSummary() {
        const summary = [];
        for (const [name, history] of this.healthHistory) {
            const last = history[history.length - 1];
            if (!last)
                continue;
            const trend = this.computeTrend(history);
            summary.push({ name, healthy: last.healthy, detail: last.detail, trend });
        }
        return summary;
    }
    // ==================== ISubsystem ====================
    async init() {
        if (this.state !== 'created')
            return;
        this.state = 'initializing';
        log('INFO', 'healthcheck.init');
        this.state = 'ready';
    }
    async start() {
        if (this.state !== 'ready')
            return;
        this.state = 'running';
        await this.runAllChecks();
        this.timer = setInterval(() => {
            this.runAllChecks();
        }, this.intervalMs);
        this.timer.unref();
        log('INFO', 'healthcheck.started', { intervalMs: this.intervalMs });
    }
    async stop() {
        const prev = this.state;
        this.state = 'stopping';
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.state = 'stopped';
        log('INFO', 'healthcheck.stopped');
    }
    async destroy() {
        await this.stop();
        this.subsystems.clear();
        this.healthHistory.clear();
        log('INFO', 'healthcheck.destroyed');
    }
    async healthCheck() {
        const unhealthy = this.getHealthSummary().filter((s) => !s.healthy);
        return {
            healthy: unhealthy.length === 0,
            detail: unhealthy.length > 0
                ? `${unhealthy.length} subsystem(s) unhealthy: ${unhealthy.map((s) => s.name).join(', ')}`
                : 'all subsystems healthy',
            metrics: { registered: this.subsystems.size, unhealthy: unhealthy.length },
        };
    }
    // ==================== 内部方法 ====================
    async runAllChecks() {
        if (this.checkInProgress)
            return;
        this.checkInProgress = true;
        try {
            for (const [name, subsystem] of this.subsystems) {
                try {
                    const result = await subsystem.healthCheck();
                    this.recordHealth(name, result);
                }
                catch (err) {
                    const result = {
                        healthy: false,
                        detail: err instanceof Error ? err.message : String(err),
                    };
                    this.recordHealth(name, result);
                }
            }
        }
        finally {
            this.checkInProgress = false;
        }
    }
    recordHealth(name, result) {
        const history = this.healthHistory.get(name);
        if (!history)
            return;
        const last = history[history.length - 1];
        history.push(result);
        if (history.length > this.maxHistory) {
            history.shift();
        }
        if (last && last.healthy !== result.healthy) {
            eventBus.emit('subsystem.health_changed', {
                name,
                healthy: result.healthy,
                detail: result.detail,
            });
            log(result.healthy ? 'INFO' : 'WARN', 'healthcheck.status_changed', {
                name,
                healthy: result.healthy,
                detail: result.detail,
            });
        }
    }
    computeTrend(history) {
        if (history.length < 2)
            return 'stable';
        const recent = history.slice(-3).filter((h) => !h.healthy).length;
        if (recent === 0)
            return 'stable';
        if (recent <= 1)
            return 'degraded';
        return 'critical';
    }
    restartTimer() {
        if (this.timer) {
            clearInterval(this.timer);
        }
        this.timer = setInterval(() => {
            this.runAllChecks();
        }, this.intervalMs);
        this.timer.unref();
    }
}
