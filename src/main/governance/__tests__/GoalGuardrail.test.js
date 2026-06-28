/**
 * RejectionTracker + GoalGuardrail 单元测试
 *
 * 覆盖策略：
 * - RejectionTracker: 滑动窗口、信用恢复、熔断、边界条件
 * - GoalGuardrail: 硬守卫、软守卫、熔断三个路径
 * - 盲点验证：迭代逃逸（每轮必检+连续偏离压分）、消息栈污染（硬拒绝不注入）
 * - ConstitutionEngine 桥接验证
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RejectionTracker } from '../RejectionTracker';
import { GoalGuardrail } from '../GoalGuardrail';
// ───── RejectionTracker ─────
describe('RejectionTracker', () => {
    let tracker;
    beforeEach(() => {
        vi.useFakeTimers();
        tracker = new RejectionTracker({ threshold: 3, windowMs: 60_000 });
    });
    afterEach(() => {
        vi.useRealTimers();
    });
    it('should not trip on empty record', () => {
        expect(tracker.shouldTrip()).toBe(false);
    });
    it('should not trip below threshold', () => {
        tracker.record('HARD_BLOCK', 'write_file');
        tracker.record('GOAL_DRIFT', 'list_files');
        expect(tracker.shouldTrip()).toBe(false);
    });
    it('should trip when threshold is reached', () => {
        tracker.record('HARD_BLOCK', 'write_file');
        tracker.record('GOAL_DRIFT', 'list_files');
        tracker.record('RESOURCE_EXHAUSTED', 'run_command');
        expect(tracker.shouldTrip()).toBe(true);
    });
    it('should prune records outside the sliding window', () => {
        tracker.record('HARD_BLOCK', 'write_file');
        tracker.record('GOAL_DRIFT', 'list_files');
        tracker.record('RESOURCE_EXHAUSTED', 'run_command');
        expect(tracker.shouldTrip()).toBe(true);
        vi.advanceTimersByTime(61_000);
        expect(tracker.shouldTrip()).toBe(false);
    });
    it('should restore credit on tool success (FIFO)', () => {
        tracker.record('HARD_BLOCK', 'write_file');
        tracker.record('GOAL_DRIFT', 'list_files');
        tracker.record('RESOURCE_EXHAUSTED', 'run_command');
        expect(tracker.shouldTrip()).toBe(true);
        tracker.onToolSuccess();
        expect(tracker.shouldTrip()).toBe(false);
        tracker.onToolSuccess();
        expect(tracker.shouldTrip()).toBe(false);
        tracker.onToolSuccess();
        expect(tracker.shouldTrip()).toBe(false);
    });
    it('should restore oldest record first (FIFO)', () => {
        tracker.record('HARD_BLOCK', 'write_file');
        tracker.record('GOAL_DRIFT', 'list_files');
        tracker.onToolSuccess();
        const stats = tracker.getStats();
        expect(stats.count).toBe(1);
        expect(stats.reasons[0]).toBe('GOAL_DRIFT');
    });
    it('should reset all records', () => {
        tracker.record('HARD_BLOCK', 'write_file');
        tracker.record('HARD_BLOCK', 'edit_file');
        tracker.record('HARD_BLOCK', 'run_command');
        expect(tracker.shouldTrip()).toBe(true);
        tracker.reset();
        expect(tracker.shouldTrip()).toBe(false);
        expect(tracker.getStats().count).toBe(0);
    });
    it('should return active reasons deduplicated', () => {
        tracker.record('HARD_BLOCK', 'write_file');
        tracker.record('HARD_BLOCK', 'edit_file');
        tracker.record('GOAL_DRIFT', 'list_files');
        const reasons = tracker.getActiveReasons();
        expect(reasons).toContain('HARD_BLOCK');
        expect(reasons).toContain('GOAL_DRIFT');
        expect(reasons.length).toBe(2);
    });
    it('should report stats correctly', () => {
        const stats = tracker.getStats();
        expect(stats.count).toBe(0);
        expect(stats.isTripped).toBe(false);
        tracker.record('HARD_BLOCK', 'write_file');
        const stats2 = tracker.getStats();
        expect(stats2.count).toBe(1);
        expect(stats2.isTripped).toBe(false);
    });
    it('should handle credit restore when no records exist (noop)', () => {
        tracker.onToolSuccess();
        expect(tracker.getStats().count).toBe(0);
    });
    it('should respect custom threshold and window', () => {
        const custom = new RejectionTracker({ threshold: 5, windowMs: 10_000 });
        for (let i = 0; i < 4; i++)
            custom.record('GOAL_DRIFT', 'list_files');
        expect(custom.shouldTrip()).toBe(false);
        custom.record('GOAL_DRIFT', 'list_files');
        expect(custom.shouldTrip()).toBe(true);
        vi.advanceTimersByTime(11_000);
        expect(custom.shouldTrip()).toBe(false);
    });
    it('should prune only expired records, not all', () => {
        tracker.record('HARD_BLOCK', 'write_file');
        tracker.record('HARD_BLOCK', 'edit_file');
        tracker.record('HARD_BLOCK', 'run_command');
        vi.advanceTimersByTime(30_000);
        tracker.record('GOAL_DRIFT', 'list_files');
        vi.advanceTimersByTime(35_000);
        expect(tracker.getStats().count).toBe(1);
        expect(tracker.getStats().reasons).toEqual(['GOAL_DRIFT']);
    });
});
// ───── GoalGuardrail ─────
describe('GoalGuardrail', () => {
    let guardrail;
    let mockGoalEngine;
    let mockConstitutionEngine;
    let mockMessages;
    let mockCtx;
    const createGoal = (overrides = {}) => ({
        id: 'goal-1',
        title: 'long term goal',
        description: 'improve task completion',
        priority: 10,
        status: 'active',
        category: 'long_term',
        parentGoalId: null,
        progress: 50,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...overrides,
    });
    beforeEach(() => {
        mockGoalEngine = {
            getActiveGoals: vi.fn().mockReturnValue([]),
        };
        mockConstitutionEngine = {
            checkWrite: vi.fn().mockReturnValue({ allowed: true }),
        };
        guardrail = new GoalGuardrail(mockGoalEngine, mockConstitutionEngine, {
            softCheckInterval: 1,
        });
        mockMessages = [];
        mockCtx = { interrupt: vi.fn() };
    });
    afterEach(() => {
        vi.useRealTimers();
    });
    it('should approve empty tool calls', async () => {
        const result = await guardrail.checkBatch([], mockMessages, mockCtx);
        expect(result.status).toBe('approved');
    });
    it('should approve when no goals exist', async () => {
        const calls = [{ id: 'tc-1', name: 'read_file', arguments: { path: '/f.ts' } }];
        const result = await guardrail.checkBatch(calls, mockMessages, mockCtx);
        expect(result.status).toBe('approved');
    });
    // ─── 硬守卫 ───
    it('should block write tools when ConstitutionEngine rejects', async () => {
        vi.mocked(mockConstitutionEngine.checkWrite).mockReturnValue({
            allowed: false,
            violation: { path: '/core/K.ts', pattern: 'core/**', reason: 'immutable', severity: 'error', layer: 'kernel' },
        });
        const call = { id: 'tc-2', name: 'write_file', arguments: { path: '/core/K.ts' } };
        const result = await guardrail.checkBatch([call], mockMessages, mockCtx);
        expect(result.status).toBe('denied');
        expect(result.reason).toBe('CONSTITUTION_VIOLATION');
        expect(result.canRetry).toBe(false);
    });
    it('should allow read tools regardless of ConstitutionEngine', async () => {
        vi.mocked(mockConstitutionEngine.checkWrite).mockReturnValue({
            allowed: false,
            violation: {},
        });
        const call = { id: 'tc-3', name: 'read_file', arguments: { path: '/core/K.ts' } };
        const result = await guardrail.checkBatch([call], mockMessages, mockCtx);
        expect(result.status).toBe('approved');
    });
    // ─── 盲点 1：消息栈污染 ───
    it('should NOT inject messages on hard rejection', async () => {
        vi.mocked(mockConstitutionEngine.checkWrite).mockReturnValue({
            allowed: false,
            violation: {},
        });
        const call = { id: 'tc-4', name: 'write_file', arguments: { path: '/core/K.ts' } };
        const result = await guardrail.checkBatch([call], mockMessages, mockCtx);
        expect(result.status).toBe('denied');
        expect(result.injected).toBe(false);
        expect(mockMessages.length).toBe(0);
    });
    // ─── 软守卫 ───
    it('should detect goal drift with long_term goal + quick tools', async () => {
        vi.mocked(mockGoalEngine.getActiveGoals).mockReturnValue([createGoal({ category: 'long_term' })]);
        const calls = [
            { id: 'tc-5', name: 'list_files', arguments: {} },
            { id: 'tc-6', name: 'list_plans', arguments: {} },
        ];
        const result = await guardrail.checkBatch(calls, mockMessages, mockCtx);
        expect(result.status).toBe('denied');
        expect(result.reason).toBe('GOAL_DRIFT');
        expect(result.canRetry).toBe(true);
    });
    it('should allow mixed tools with long_term goal', async () => {
        vi.mocked(mockGoalEngine.getActiveGoals).mockReturnValue([createGoal({ category: 'long_term' })]);
        const calls = [
            { id: 'tc-7', name: 'read_file', arguments: {} },
            { id: 'tc-8', name: 'write_file', arguments: {} },
        ];
        const result = await guardrail.checkBatch(calls, mockMessages, mockCtx);
        expect(result.status).toBe('approved');
    });
    it('should inject alignment message on soft rejection', async () => {
        vi.mocked(mockGoalEngine.getActiveGoals).mockReturnValue([createGoal({ category: 'mission' })]);
        const calls = [{ id: 'tc-9', name: 'list_files', arguments: {} }];
        const result = await guardrail.checkBatch(calls, mockMessages, mockCtx);
        expect(result.status).toBe('denied');
        expect(result.injected).toBe(true);
        expect(mockMessages.length).toBe(1);
        expect(mockMessages[0].content).toContain('【目标对齐】');
    });
    // ─── 盲点 2：迭代逃逸 ───
    it('should apply tighter scoring on consecutive drift', async () => {
        vi.mocked(mockGoalEngine.getActiveGoals).mockReturnValue([createGoal({ category: 'long_term' })]);
        const calls = [{ id: 'tc-11', name: 'list_files', arguments: {} }];
        const r1 = await guardrail.checkBatch(calls, mockMessages, mockCtx);
        expect(r1.status).toBe('denied');
        const r2 = await guardrail.checkBatch(calls, mockMessages, mockCtx);
        expect(r2.status).toBe('denied');
        expect(r2.message).toContain('连续偏离');
    });
    it('should restore normal scoring after tool success', async () => {
        vi.mocked(mockGoalEngine.getActiveGoals).mockReturnValue([createGoal({ category: 'long_term' })]);
        const calls = [{ id: 'tc-13', name: 'list_files', arguments: {} }];
        // Round 1: denied (goal drift detected, previousTurnDenied = true)
        await guardrail.checkBatch(calls, mockMessages, mockCtx);
        // onToolSuccess resets previousTurnDenied AND decrements rejection counter
        guardrail.onToolSuccess();
        expect(guardrail.getRejectionStats().count).toBe(0);
        // Round 2: still drift but without escalated scoring (was 0.3 with escalation, now 0.4)
        // The message should NOT contain '连续偏离' since escalation was reset
        const r2 = await guardrail.checkBatch(calls, mockMessages, mockCtx);
        expect(r2.status).toBe('denied');
        expect(r2.reason).toBe('GOAL_DRIFT');
        expect(r2.message).toContain('操作方向偏离');
    });
    // ─── 熔断 ───
    it('should trip when rejection threshold exceeded', async () => {
        const g = new GoalGuardrail(mockGoalEngine, mockConstitutionEngine, {
            rejection: { threshold: 2, windowMs: 60_000 },
        });
        vi.mocked(mockConstitutionEngine.checkWrite).mockReturnValue({
            allowed: false,
            violation: {},
        });
        const wc = { id: 'tc-14', name: 'write_file', arguments: { path: '/core/K.ts' } };
        await g.checkBatch([wc], [], mockCtx);
        await g.checkBatch([wc], [], mockCtx);
        const rc = { id: 'tc-15', name: 'read_file', arguments: {} };
        const result = await g.checkBatch([rc], [], mockCtx);
        expect(result.status).toBe('denied');
        expect(result.reason).toBe('MAX_REJECTION_EXCEEDED');
        expect(result.canRetry).toBe(false);
    });
    it('should reset rejection tracking', async () => {
        const g = new GoalGuardrail(mockGoalEngine, mockConstitutionEngine, {
            rejection: { threshold: 2, windowMs: 60_000 },
        });
        vi.mocked(mockConstitutionEngine.checkWrite).mockReturnValue({
            allowed: false,
            violation: {},
        });
        const wc = { id: 'tc-16', name: 'write_file', arguments: { path: '/core/K.ts' } };
        await g.checkBatch([wc], [], mockCtx);
        g.resetRejectionTracking();
        const rc = { id: 'tc-17', name: 'read_file', arguments: {} };
        const result = await g.checkBatch([rc], [], mockCtx);
        expect(result.status).toBe('approved');
    });
    // ─── 延迟绑定 ───
    it('should accept late-bound engines', () => {
        const g = new GoalGuardrail(null, null);
        expect(g.getConstitutionEngine()).toBeNull();
        g.setGoalEngine(mockGoalEngine);
        g.setConstitutionEngine(mockConstitutionEngine);
        expect(g.getConstitutionEngine()).toBe(mockConstitutionEngine);
    });
    // ─── path 参数提取 ───
    it('should extract path from arguments', async () => {
        vi.mocked(mockConstitutionEngine.checkWrite).mockReturnValue({
            allowed: false,
            violation: {},
        });
        const call = { id: 'tc-18', name: 'write_file', arguments: { path: '/core/K.ts' } };
        const result = await guardrail.checkBatch([call], mockMessages, mockCtx);
        expect(result.status).toBe('denied');
    });
    it('should extract file_path as fallback', async () => {
        vi.mocked(mockConstitutionEngine.checkWrite).mockReturnValue({
            allowed: false,
            violation: {},
        });
        const call = { id: 'tc-19', name: 'edit_file', arguments: { file_path: '/core/E.ts' } };
        const result = await guardrail.checkBatch([call], mockMessages, mockCtx);
        expect(result.status).toBe('denied');
    });
    it('should not crash on null arguments', async () => {
        const calls = [{ id: 'tc-20', name: 'write_file', arguments: null }];
        const result = await guardrail.checkBatch(calls, mockMessages, mockCtx);
        expect(result.status).toBe('approved');
    });
    // ─── 信用恢复集成 ───
    it('should integrate credit recovery with rejection count', async () => {
        const g = new GoalGuardrail(mockGoalEngine, mockConstitutionEngine, {
            rejection: { threshold: 3, windowMs: 60_000 },
        });
        vi.mocked(mockConstitutionEngine.checkWrite).mockReturnValue({
            allowed: false,
            violation: {},
        });
        const wc = { id: 'tc-21', name: 'write_file', arguments: { path: '/core/K.ts' } };
        await g.checkBatch([wc], [], mockCtx);
        await g.checkBatch([wc], [], mockCtx);
        g.onToolSuccess();
        expect(g.getRejectionStats().count).toBe(1);
        await g.checkBatch([wc], [], mockCtx);
        expect(g.getRejectionStats().count).toBe(2);
        expect(g.getRejectionStats().isTripped).toBe(false);
    });
});
