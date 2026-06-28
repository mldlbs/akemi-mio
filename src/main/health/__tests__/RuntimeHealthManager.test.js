import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RuntimeHealthManager } from '../RuntimeHealthManager';
import { eventBus } from '../../core/EventBus';
vi.mock('../../logger/Logger', () => ({ log: vi.fn() }));
function resetEvents() {
    eventBus.removeAll();
}
describe('RuntimeHealthManager', () => {
    let manager;
    beforeEach(() => {
        resetEvents();
        manager = new RuntimeHealthManager();
    });
    afterEach(async () => {
        await manager.stop().catch(() => { });
        await manager.destroy().catch(() => { });
    });
    it('init 状态转换', async () => {
        expect(manager.state).toBe('created');
        await manager.init();
        expect(manager.state).toBe('ready');
    });
    it('第二次 init 无操作', async () => {
        await manager.init();
        await manager.init();
        expect(manager.state).toBe('ready');
    });
    it('start 启动 modelHealth 和 tick', async () => {
        await manager.init();
        await manager.start();
        expect(manager.state).toBe('running');
    });
    it('stop 停止所有', async () => {
        await manager.init();
        await manager.start();
        await manager.stop();
        expect(manager.state).toBe('stopped');
    });
    it('无 provider 时 healthCheck 返回 healthy', async () => {
        await manager.init();
        await manager.start();
        const h = await manager.healthCheck();
        expect(h.healthy).toBe(true);
    });
    it('无 provider 时 snapshot 全 100', () => {
        const snap = manager.getSnapshot();
        expect(snap.composite.score).toBe(100);
        expect(snap.session.score).toBe(100);
        expect(snap.capability.score).toBe(100);
        expect(snap.task.score).toBe(100);
        expect(snap.model.score).toBe(100);
    });
    it('composite = weighted 4 dimensions', () => {
        const session = { getScore: () => 50, getLevel: () => 'RISKY', getConsecutiveFailures: () => 5 };
        const cap = { getCapabilitySummary: () => ({ totalCapabilityHealth: 100, servers: [] }) };
        const task = { getTaskHealthSummary: () => [] };
        manager.setSessionHealthProvider(session);
        manager.setCapabilityHealthProvider(cap);
        manager.setTaskHealthProvider(task);
        // 50*0.35 + 100*0.2 + 100*0.2 + 100*0.25 = 82.5 → 83
        const snap = manager.getSnapshot();
        expect(snap.composite.score).toBe(83);
    });
    it('composite 全低 → < 30', () => {
        const session = { getScore: () => 0, getLevel: () => 'CORRUPTED', getConsecutiveFailures: () => 100 };
        const cap = {
            getCapabilitySummary: () => ({ totalCapabilityHealth: 0, servers: [{ name: 'x', healthScore: 0, driftDetected: true }] }),
        };
        const task = {
            getTaskHealthSummary: () => [{ type: 't', status: 'cooldown', consecutiveFailures: 10, tier: 'best_effort', disabled: true }],
        };
        manager.setSessionHealthProvider(session);
        manager.setCapabilityHealthProvider(cap);
        manager.setTaskHealthProvider(task);
        // Also push modelHealth score down
        manager.modelHealth.start();
        for (let i = 0; i < 10; i++)
            eventBus.emit('agent.tool.failed', { tool: 't', error: 'err' });
        manager.modelHealth.stop();
        const snap = manager.getSnapshot();
        // model=0, session=0, capa=0, task~0 → composite ~0
        expect(snap.composite.score).toBeLessThan(30);
    });
    it('composite clamped [0,100]', () => {
        const session = { getScore: () => 200, getLevel: () => 'HEALTHY', getConsecutiveFailures: () => 0 };
        const cap = { getCapabilitySummary: () => ({ totalCapabilityHealth: 200, servers: [] }) };
        const task = { getTaskHealthSummary: () => [] };
        manager.setSessionHealthProvider(session);
        manager.setCapabilityHealthProvider(cap);
        manager.setTaskHealthProvider(task);
        const snap = manager.getSnapshot();
        expect(snap.composite.score).toBeLessThanOrEqual(100);
        expect(snap.composite.score).toBeGreaterThanOrEqual(0);
    });
    it('healthCheck composite < 50 → unhealthy', async () => {
        const session = { getScore: () => 10, getLevel: () => 'CRITICAL', getConsecutiveFailures: () => 50 };
        const cap = {
            getCapabilitySummary: () => ({ totalCapabilityHealth: 10, servers: [{ name: 'x', healthScore: 10, driftDetected: true }] }),
        };
        const task = {
            getTaskHealthSummary: () => [{ type: 't', status: 'cooldown', consecutiveFailures: 10, tier: 'best_effort', disabled: true }],
        };
        manager.setSessionHealthProvider(session);
        manager.setCapabilityHealthProvider(cap);
        manager.setTaskHealthProvider(task);
        // Push model down too
        manager.modelHealth.start();
        for (let i = 0; i < 10; i++)
            eventBus.emit('agent.tool.failed', { tool: 't', error: 'err' });
        manager.modelHealth.stop();
        await manager.init();
        await manager.start();
        const h = await manager.healthCheck();
        expect(h.healthy).toBe(false);
        expect(h.detail).toContain('degraded');
    });
    it('session low → 触发恢复流程', () => {
        const session = { getScore: () => 30, getLevel: () => 'CRITICAL', getConsecutiveFailures: () => 20 };
        manager.setSessionHealthProvider(session);
        const actions = manager.getRecommendedActions();
        expect(actions.some((a) => a.includes('触发恢复流程'))).toBe(true);
    });
    it('capability low → 检查服务器状态', () => {
        const cap = {
            getCapabilitySummary: () => ({ totalCapabilityHealth: 70, servers: [{ name: 'x', healthScore: 70, driftDetected: true }] }),
        };
        manager.setCapabilityHealthProvider(cap);
        const actions = manager.getRecommendedActions();
        expect(actions.some((a) => a.includes('检查服务器状态'))).toBe(true);
    });
    it('task low → 反复失败的任务', () => {
        const task = {
            getTaskHealthSummary: () => [{ type: 't', status: 'cooldown', consecutiveFailures: 10, tier: 'best_effort', disabled: true }],
        };
        manager.setTaskHealthProvider(task);
        const actions = manager.getRecommendedActions();
        expect(actions.some((a) => a.includes('反复失败'))).toBe(true);
    });
    it('model failureCount > 10 + successes → 累计失败', () => {
        manager.modelHealth.start();
        // Need score >= 60 plus failureCount > 10 for the else-if branch
        for (let i = 0; i < 60; i++) {
            eventBus.emit('agent.tool.completed', { tool: 't', result: 'ok' });
        }
        for (let i = 0; i < 11; i++) {
            eventBus.emit('agent.tool.failed', { tool: 't', error: 'err' });
        }
        // successRate = 60/71 ≈ 0.845, diversityPenalty = 0 (no error classified events)
        // score = 84.5 → >= 60, so else-if branch with failureCount > 10
        const actions = manager.getRecommendedActions();
        expect(actions.some((a) => a.includes('累计失败'))).toBe(true);
        manager.modelHealth.stop();
    });
    it('modelHealth integrated via getSnapshot', () => {
        manager.modelHealth.start();
        eventBus.emit('agent.tool.completed', { tool: 't', result: 'ok' });
        eventBus.emit('agent.tool.failed', { tool: 't', error: 'err' });
        const snap = manager.getSnapshot();
        expect(snap.model.totalToolCalls).toBe(2);
        expect(snap.model.successCount).toBe(1);
        expect(snap.model.failureCount).toBe(1);
        manager.modelHealth.stop();
    });
    it('evaluateAll fires runtime.health.updated event', async () => {
        await manager.init();
        await manager.start();
        const events = [];
        const unsub = eventBus.on('runtime.health.updated', (p) => events.push(p));
        manager.evaluateAll();
        expect(events.length).toBeGreaterThanOrEqual(1);
        expect(events[0].compositeScore).toBeGreaterThanOrEqual(0);
        expect(events[0].recommendedActions).toBeInstanceOf(Array);
        unsub();
    });
    it('trend stable with < 10 history', () => {
        expect(manager.computeTrend()).toBe('stable');
    });
    it('trend improving', () => {
        const h = manager.history;
        for (let i = 0; i < 20; i++)
            h.push({ composite: 40 + i, timestamp: i * 1000 });
        expect(manager.computeTrend()).toBe('improving');
    });
    it('trend declining', () => {
        const h = manager.history;
        for (let i = 0; i < 20; i++)
            h.push({ composite: 60 - i, timestamp: i * 1000 });
        expect(manager.computeTrend()).toBe('declining');
    });
    it('getDiagnostics returns all sections', () => {
        const d = manager.getDiagnostics();
        expect(d.composite).toBeDefined();
        expect(d.session).toBeDefined();
        expect(d.capability).toBeDefined();
        expect(d.task).toBeDefined();
        expect(d.model).toBeDefined();
        expect(d.historyPoints).toBeGreaterThanOrEqual(0);
        expect(d.recommendedActions).toBeInstanceOf(Array);
    });
});
