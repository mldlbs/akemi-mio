import { log } from '../logger/Logger';
import { eventBus as defaultEventBus } from '../core/EventBus';
/**
 * FailureAnalyzer — 监听 EventBus 失败事件，聚合失败模式。
 *
 * 与 ReflectLoop 的区别：
 * - ReflectLoop: 每次交互后即时反思（per-interaction）
 * - FailureAnalyzer: 跨交互聚合失败模式（cross-interaction）
 *
 * 两类输出：
 * 1. EngineeringMemory 条目（供 LLM 自我修正）
 * 2. 格式化上下文（注入 system prompt 让 Agent 知道自己容易在哪出问题）
 */
export class FailureAnalyzer {
    constructor(engineering, bus) {
        this.failures = [];
        this.patterns = new Map();
        this.engineering = null;
        this.maxRecords = 200;
        this.unsubscribers = [];
        this.engineering = engineering || null;
        this.eventBus = bus || defaultEventBus;
    }
    setEngineering(eng) {
        this.engineering = eng;
    }
    /** 开始监听 EventBus 失败事件 */
    start() {
        this.unsubscribers.push(this.eventBus.on('agent.tool.failed', (p) => {
            this.record({
                type: 'tool',
                name: p.tool,
                error: p.error,
                context: 'tool_execution',
                timestamp: Date.now(),
            });
        }));
        this.unsubscribers.push(this.eventBus.on('agent.error', (p) => {
            this.record({
                type: 'crash',
                name: 'agent_error',
                error: p.error,
                context: `request:${p.requestId}`,
                timestamp: Date.now(),
            });
        }));
        log('INFO', 'failure_analyzer_started');
    }
    /** 停止监听 */
    stop() {
        for (const unsub of this.unsubscribers) {
            try {
                unsub();
            }
            catch { }
        }
        this.unsubscribers = [];
    }
    /** 手动记录一条失败 */
    record(failure) {
        this.failures.push(failure);
        if (this.failures.length > this.maxRecords) {
            this.failures = this.failures.slice(-this.maxRecords);
        }
        this.updatePattern(failure);
    }
    updatePattern(failure) {
        const errorSig = failure.error.slice(0, 60).replace(/\d+/g, 'N');
        const fp = `${failure.type}:${errorSig}`;
        let p = this.patterns.get(fp);
        if (!p) {
            p = {
                fingerprint: fp,
                count: 0,
                firstSeen: failure.timestamp,
                lastSeen: failure.timestamp,
                types: new Set(),
                names: new Set(),
                errors: [],
            };
            this.patterns.set(fp, p);
        }
        p.count++;
        p.lastSeen = failure.timestamp;
        p.types.add(failure.type);
        p.names.add(failure.name);
        if (!p.errors.includes(failure.error)) {
            p.errors.push(failure.error);
            if (p.errors.length > 5)
                p.errors = p.errors.slice(-5);
        }
    }
    /** Apply time-decay to pattern weight: weight = count * 0.5^(age / halfLife) */
    applyDecayWeight(p) {
        const ageMs = Date.now() - p.lastSeen;
        if (ageMs <= 0)
            return p.count;
        const halfLives = ageMs / FailureAnalyzer.DECAY_HALF_LIFE_MS;
        return p.count * Math.pow(0.5, halfLives);
    }
    /** 获取热点失败模式（按时间衰减加权频次排序） */
    getHotPatterns(topK = 5) {
        return Array.from(this.patterns.values())
            .filter((p) => p.count >= 2)
            .map((p) => ({ pattern: p, weight: this.applyDecayWeight(p) }))
            .sort((a, b) => b.weight - a.weight)
            .slice(0, topK)
            .map((entry) => entry.pattern);
    }
    /** 将热点模式写入 EngineeringMemory */
    persistHotPatterns() {
        if (!this.engineering)
            return 0;
        const hot = this.getHotPatterns(5);
        let saved = 0;
        for (const p of hot) {
            const content = [
                `【失败模式】类型: ${Array.from(p.types).join(',')}`,
                `出现 ${p.count} 次 (${new Date(p.firstSeen).toLocaleString()} ~ ${new Date(p.lastSeen).toLocaleString()})`,
                `涉及工具: ${Array.from(p.names).join(', ')}`,
                `典型错误: ${p.errors[0]?.slice(0, 120)}`,
            ].join('\n');
            this.engineering.store({
                type: 'failure_pattern',
                content,
                source: 'failure_analyzer',
                confidence: Math.min(0.9, 0.3 + p.count * 0.1),
                relatedFiles: [],
                tags: ['failure_pattern', ...Array.from(p.types)],
            });
            saved++;
        }
        return saved;
    }
    /** 格式化上下文，注入 system prompt */
    getFormattedContext() {
        const hot = this.getHotPatterns(3);
        if (hot.length === 0)
            return '';
        const parts = ['---', '【系统失败模式】'];
        for (const p of hot) {
            parts.push(`- [${p.count}次] ${Array.from(p.names).join(', ')}: ${p.errors[0]?.slice(0, 80)}`);
        }
        parts.push('（关注高频率失败原因，避免重复踩坑）');
        parts.push('---');
        return parts.join('\n');
    }
    getStats() {
        return {
            total: this.failures.length,
            patterns: this.patterns.size,
            topFailures: this.getHotPatterns(5).map((p) => `${p.count}x ${Array.from(p.names).join(',')}: ${p.errors[0]?.slice(0, 40)}`),
        };
    }
}
FailureAnalyzer.DECAY_HALF_LIFE_MS = 24 * 60 * 60 * 1000; // 24 hours
