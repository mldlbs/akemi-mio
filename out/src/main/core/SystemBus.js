/**
 * SystemBus — 协调总线：同步请求-响应层
 *
 * 与 EventBus（单向通知）互补。SystemBus 提供：
 * - query<T>(channel, context)：向所有注册的 handler 发起并行查询，聚合结果
 * - execute<T>(command, context)：向目标 handler 发起命令，等待确认
 *
 * 设计约束：
 * - 200ms 超时降级（不阻塞 toolLoop）
 * - DAG 循环依赖检测（启动时验证，有环则拒绝）
 * - Trace ID 传播（防无限递归 + 可观测性）
 */
import { log, createRequestId } from '../logger/Logger';
// ───── 常量 ─────
const DEFAULT_QUERY_TIMEOUT_MS = 200;
const MAX_BUS_DEPTH = 5;
// ───── SystemBus ─────
export class SystemBus {
    constructor() {
        this.queryHandlers = new Map();
        this.commandHandlers = new Map();
        this.frozen = false;
        this.bridgeDisposers = [];
    }
    // ───── 桥接 ─────
    /**
     * bridgeFrom — 当 EventBus 事件触发时，自动转发到 SystemBus command/query。
     * 实现"事件→命令"闭环。
     * 每个桥接规则返回一个 disposer，调用 stopBridge() 可统一解除。
     */
    bridgeFrom(eventBus, rules) {
        for (const rule of rules) {
            const disposer = eventBus.on(rule.event, (payload) => {
                const mapped = rule.mapPayload ? rule.mapPayload(payload) : payload;
                if (rule.command) {
                    this.execute(rule.command, mapped).catch((err) => log('WARN', 'bridge_command_failed', { event: rule.event, command: rule.command, error: String(err) }));
                }
                if (rule.query) {
                    this.query(rule.query, mapped).catch((err) => log('WARN', 'bridge_query_failed', { event: rule.event, query: rule.query, error: String(err) }));
                }
            });
            this.bridgeDisposers.push(disposer);
            log('DEBUG', 'systembus_bridge_registered', { event: rule.event, command: rule.command, query: rule.query });
        }
    }
    stopBridge() {
        for (const d of this.bridgeDisposers)
            d();
        this.bridgeDisposers = [];
    }
    // ───── 注册 ─────
    registerQuery(channel, name, handler, options) {
        if (this.frozen)
            throw new Error(`SystemBus frozen: cannot register "${name}" after boot`);
        if (!this.queryHandlers.has(channel))
            this.queryHandlers.set(channel, new Map());
        const reg = {
            name,
            channel,
            type: 'query',
            dependencies: options?.dependencies ?? [],
            timeoutMs: options?.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
            getFallback: () => options?.fallback ?? null,
        };
        this.queryHandlers.get(channel).set(name, { handler: handler, reg });
        log('DEBUG', 'systembus_query_registered', { channel, name, deps: reg.dependencies.length });
    }
    registerCommand(channel, name, handler, options) {
        if (this.frozen)
            throw new Error(`SystemBus frozen: cannot register "${name}" after boot`);
        if (!this.commandHandlers.has(channel))
            this.commandHandlers.set(channel, new Map());
        const reg = {
            name,
            channel,
            type: 'command',
            dependencies: options?.dependencies ?? [],
            timeoutMs: options?.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
            getFallback: () => null,
        };
        this.commandHandlers.get(channel).set(name, { handler: handler, reg });
        log('DEBUG', 'systembus_command_registered', { channel, name, deps: reg.dependencies.length });
    }
    freeze() {
        this.frozen = true;
    }
    // ───── 查询 ─────
    /**
     * 向 channel 所有 handler 发起并行查询。
     * 超时 handler 自动降级为 fallback。
     * depth > MAX_BUS_DEPTH → 循环保护，直接 fallback。
     */
    async query(channel, context = {}) {
        const handlers = this.queryHandlers.get(channel);
        if (!handlers || handlers.size === 0) {
            return { channel, results: [], composite: null, traceId: context.traceId ?? 'noop', totalLatencyMs: 0, timedOut: false };
        }
        const traceId = context.traceId ?? createRequestId();
        const depth = (context.depth ?? 0) + 1;
        const ctx = { ...context, traceId, depth };
        if (depth > MAX_BUS_DEPTH) {
            log('WARN', 'systembus_max_depth', { channel, traceId, depth });
            const fallbackResults = [...handlers.entries()].map(([name, h]) => ({
                channel,
                handlerName: name,
                success: false,
                value: h.reg.getFallback(),
                latencyMs: 0,
                error: 'MAX_DEPTH',
            }));
            return { channel, results: fallbackResults, composite: null, traceId, totalLatencyMs: 0, timedOut: false };
        }
        const t0 = Date.now();
        const results = await Promise.allSettled([...handlers.entries()].map(async ([name, h]) => {
            const t1 = Date.now();
            try {
                const value = await Promise.race([
                    h.handler(ctx),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), h.reg.timeoutMs)),
                ]);
                return { channel, handlerName: name, success: true, value: value, latencyMs: Date.now() - t1 };
            }
            catch (err) {
                const isTimeout = String(err).includes('TIMEOUT');
                if (isTimeout)
                    log('WARN', 'systembus_query_timeout', { channel, handler: name, timeoutMs: h.reg.timeoutMs, traceId });
                return {
                    channel,
                    handlerName: name,
                    success: false,
                    value: h.reg.getFallback(),
                    latencyMs: Date.now() - t1,
                    error: isTimeout ? 'TIMEOUT' : String(err),
                };
            }
        }));
        const finalResults = results.map((r, i) => {
            const name = [...handlers.keys()][i];
            if (r.status === 'fulfilled')
                return r.value;
            return {
                channel,
                handlerName: name,
                success: false,
                value: handlers.get(name)?.reg.getFallback() ?? null,
                latencyMs: Date.now() - t0,
                error: 'UNHANDLED_REJECTION',
            };
        });
        return {
            channel,
            results: finalResults,
            composite: this.aggregateChannel(channel, finalResults),
            traceId,
            totalLatencyMs: Date.now() - t0,
            timedOut: finalResults.some((r) => r.error === 'TIMEOUT'),
        };
    }
    async execute(channel, payload) {
        const handlers = this.commandHandlers.get(channel);
        if (!handlers || handlers.size === 0) {
            return { success: false, value: null, error: `No handler: ${channel}`, latencyMs: 0 };
        }
        const [name, h] = [...handlers.entries()][0];
        const t0 = Date.now();
        try {
            const result = (await Promise.race([
                h.handler(payload),
                new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), h.reg.timeoutMs)),
            ]));
            return { ...result, latencyMs: Date.now() - t0 };
        }
        catch (err) {
            const isTimeout = String(err).includes('TIMEOUT');
            log(isTimeout ? 'WARN' : 'ERROR', 'systembus_command_failed', { channel, handler: name, error: String(err) });
            return { success: false, value: null, error: isTimeout ? 'TIMEOUT' : String(err), latencyMs: Date.now() - t0 };
        }
    }
    // ───── DAG 检测 ─────
    validateDAG() {
        const graph = new Map();
        for (const handlers of this.queryHandlers.values()) {
            for (const [name, h] of handlers)
                graph.set(name, h.reg.dependencies);
        }
        for (const handlers of this.commandHandlers.values()) {
            for (const [name, h] of handlers)
                graph.set(name, h.reg.dependencies);
        }
        const cycles = findCycles(graph);
        if (cycles.length > 0) {
            log('ERROR', 'systembus_dag_cycle', { cycles: cycles.map((c) => c.join(' -> ')) });
        }
        else {
            log('INFO', 'systembus_dag_valid', { nodes: graph.size });
        }
        return { valid: cycles.length === 0, cycles };
    }
    getStats() {
        let q = 0, c = 0;
        for (const h of this.queryHandlers.values())
            q += h.size;
        for (const h of this.commandHandlers.values())
            c += h.size;
        return { queries: q, commands: c, frozen: this.frozen };
    }
    // ───── 聚合 ─────
    aggregateChannel(channel, results) {
        if (results.length === 0)
            return null;
        if (channel === 'utility-score') {
            const nums = results.filter((r) => r.success && typeof r.value === 'number');
            if (nums.length === 0)
                return 0.5;
            const avg = nums.reduce((s, r) => s + r.value, 0) / nums.length;
            return Math.max(0, Math.min(1, avg));
        }
        return results.find((r) => r.success)?.value ?? null;
    }
}
// ───── DAG 环检测（三色标记 DFS） ─────
function findCycles(graph) {
    const color = new Map();
    const parent = new Map();
    const cycles = [];
    for (const n of graph.keys())
        color.set(n, 0);
    function dfs(node) {
        color.set(node, 1);
        for (const dep of graph.get(node) ?? []) {
            if (!graph.has(dep))
                continue;
            if (color.get(dep) === 1) {
                const cycle = [dep, node];
                let cur = node;
                while (cur !== dep && parent.has(cur)) {
                    cur = parent.get(cur);
                    if (cur !== null && cur !== dep)
                        cycle.push(cur);
                }
                cycle.reverse();
                cycles.push(cycle);
            }
            else if (color.get(dep) === 0) {
                parent.set(dep, node);
                dfs(dep);
            }
        }
        color.set(node, 2);
    }
    for (const n of graph.keys())
        if (color.get(n) === 0)
            dfs(n);
    return cycles;
}
export const systemBus = new SystemBus();
