/**
 * SystemBus 单元测试
 *
 * 覆盖：
 * - query 聚合、超时降级、深度保护
 * - DAG 环检测
 * - 冻结保护
 * - GoalGuardrail 多因子评分集成
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SystemBus } from '../SystemBus';
import { GoalGuardrail } from '../../governance/GoalGuardrail';
// ───── SystemBus ─────
describe('SystemBus', () => {
    let bus;
    beforeEach(() => {
        bus = new SystemBus();
    });
    it('should return empty result when no handlers registered', async () => {
        const result = await bus.query('utility-score');
        expect(result.results).toHaveLength(0);
        expect(result.composite).toBeNull();
    });
    it('should aggregate results from multiple handlers', async () => {
        bus.registerQuery('utility-score', 'handler-a', () => 0.8, { fallback: 0.5 });
        bus.registerQuery('utility-score', 'handler-b', () => 0.6, { fallback: 0.5 });
        bus.freeze();
        const result = await bus.query('utility-score');
        expect(result.results).toHaveLength(2);
        expect(result.composite).toBeCloseTo(0.7, 2);
        expect(result.results.every((r) => r.success)).toBe(true);
    });
    it('should use fallback value on handler timeout', async () => {
        vi.useFakeTimers();
        bus.registerQuery('utility-score', 'slow-handler', async () => {
            await new Promise((r) => setTimeout(r, 500));
            return 0.9;
        }, { timeoutMs: 50, fallback: 0.3 });
        bus.freeze();
        const queryPromise = bus.query('utility-score');
        vi.advanceTimersByTime(100);
        const result = await queryPromise;
        expect(result.results[0].success).toBe(false);
        expect(result.results[0].error).toBe('TIMEOUT');
        expect(result.results[0].value).toBe(0.3);
        // Composite defaults to neutral (0.5) when all handlers fail
        expect(result.composite).toBe(0.5);
        vi.useRealTimers();
    });
    it('should guard against recursive depth exceeding MAX_DEPTH', async () => {
        bus.registerQuery('utility-score', 'infinite', async (ctx) => {
            await bus.query('utility-score', ctx);
            return 0.8;
        }, { fallback: 0.5 });
        bus.freeze();
        const result = await bus.query('utility-score');
        // Should not hang; inner query immediately returns fallback
        expect(result.totalLatencyMs).toBeLessThan(100);
    });
    it('should not allow registration after freeze', () => {
        bus.freeze();
        expect(() => bus.registerQuery('utility-score', 'late', () => 0.5)).toThrow('SystemBus frozen');
    });
    it('should report stats correctly', () => {
        expect(bus.getStats().queries).toBe(0);
        bus.registerQuery('utility-score', 'h1', () => 0.5);
        bus.registerQuery('utility-score', 'h2', () => 0.5);
        expect(bus.getStats().queries).toBe(2);
    });
    // ─── DAG ───
    it('should validate acyclic dependency graph', () => {
        bus.registerQuery('utility-score', 'a', () => 0.5, { dependencies: [] });
        bus.registerQuery('utility-score', 'b', () => 0.5, { dependencies: ['a'] });
        bus.registerQuery('utility-score', 'c', () => 0.5, { dependencies: ['b'] });
        expect(bus.validateDAG().valid).toBe(true);
    });
    it('should detect circular dependency', () => {
        bus.registerQuery('utility-score', 'a', () => 0.5, { dependencies: ['b'] });
        bus.registerQuery('utility-score', 'b', () => 0.5, { dependencies: ['c'] });
        bus.registerQuery('utility-score', 'c', () => 0.5, { dependencies: ['a'] });
        const result = bus.validateDAG();
        expect(result.valid).toBe(false);
        expect(result.cycles.length).toBeGreaterThan(0);
    });
    // ─── execute ───
    it('should execute command with registered handler', async () => {
        bus.registerCommand('guardrail.inject-feedback', 'injector', async (p) => ({
            success: true,
            value: `injected: ${p.msg}`,
        }));
        bus.freeze();
        const result = await bus.execute('guardrail.inject-feedback', { msg: 'test' });
        expect(result.success).toBe(true);
        expect(result.value).toBe('injected: test');
    });
    it('should return error for unknown command channel', async () => {
        bus.freeze();
        const result = await bus.execute('memory.consolidate-now', {});
        expect(result.success).toBe(false);
        expect(result.error).toContain('No handler');
    });
});
// ───── GoalGuardrail + SystemBus 集成 ─────
describe('GoalGuardrail + SystemBus integration', () => {
    let guardrail;
    let bus;
    let mockMessages;
    let mockCtx;
    beforeEach(() => {
        bus = new SystemBus();
        const mockGoalEngine = { getActiveGoals: vi.fn().mockReturnValue([]) };
        guardrail = new GoalGuardrail(mockGoalEngine, null, { softCheckInterval: 1 });
        mockMessages = [];
        mockCtx = { interrupt: vi.fn() };
    });
    it('should fall back to heuristic when SystemBus is not set', async () => {
        const calls = [{ id: 'tc-1', name: 'read_file', arguments: {} }];
        expect((await guardrail.checkBatch(calls, mockMessages, mockCtx)).status).toBe('approved');
    });
    it('should use SystemBus utility-score when available', async () => {
        bus.registerQuery('utility-score', 'scorer', () => 0.3, { fallback: 0.5 });
        bus.freeze();
        guardrail.setSystemBus(bus);
        const calls = [{ id: 'tc-2', name: 'read_file', arguments: {} }];
        const result = await guardrail.checkBatch(calls, mockMessages, mockCtx);
        expect(result.status).toBe('denied');
        expect(result.reason).toBe('GOAL_DRIFT');
    });
    it('should pass through on high score', async () => {
        bus.registerQuery('utility-score', 'scorer', () => 0.9, { fallback: 0.5 });
        bus.freeze();
        guardrail.setSystemBus(bus);
        const calls = [{ id: 'tc-3', name: 'read_file', arguments: {} }];
        expect((await guardrail.checkBatch(calls, mockMessages, mockCtx)).status).toBe('approved');
    });
    it('should inject message on SystemBus soft rejection', async () => {
        bus.registerQuery('utility-score', 'scorer', () => 0.3, { fallback: 0.5 });
        bus.freeze();
        guardrail.setSystemBus(bus);
        const calls = [{ id: 'tc-4', name: 'read_file', arguments: {} }];
        const result = await guardrail.checkBatch(calls, mockMessages, mockCtx);
        expect(result.injected).toBe(true);
        expect(mockMessages.length).toBe(1);
    });
    it('should handle handler failure gracefully', async () => {
        bus.registerQuery('utility-score', 'broken', () => {
            throw new Error('x');
        }, { timeoutMs: 50, fallback: 0.5 });
        bus.freeze();
        guardrail.setSystemBus(bus);
        const calls = [{ id: 'tc-5', name: 'read_file', arguments: {} }];
        expect((await guardrail.checkBatch(calls, mockMessages, mockCtx)).status).toBe('approved');
    });
    it('should apply consecutive drift penalty with SystemBus', async () => {
        // Use an edge scorer: 0.55 is just barely above threshold
        bus.registerQuery('utility-score', 'edge', () => 0.45, { fallback: 0.5 });
        bus.freeze();
        guardrail.setSystemBus(bus);
        const calls = [{ id: 'tc-6', name: 'read_file', arguments: {} }];
        // Round 1: 0.45 < 0.5 → denied, previousTurnDenied = true
        const r1 = await guardrail.checkBatch(calls, mockMessages, mockCtx);
        expect(r1.status).toBe('denied');
        // Round 2: 0.45 - 0.2 = 0.25 → severely denied
        const r2 = await guardrail.checkBatch(calls, mockMessages, mockCtx);
        expect(r2.status).toBe('denied');
        expect(r2.message).toContain('连续偏离');
    });
});
