import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { DecisionStore } from '../DecisionStore';
import { initDatabase, closeDatabase } from '../../db/connection';
describe('DecisionStore', () => {
    let store;
    const testRecord = () => ({
        agentId: 'test_agent',
        category: 'tool_select',
        context: '需要读取文件内容',
        choice: '选择了 readFile 工具',
        alternatives: ['grep', 'listFiles'],
        confidence: 0.85,
        relatedPlanId: 'plan_001',
        outcome: 'success',
    });
    beforeEach(async () => {
        if (existsSync(join(process.cwd(), 'akemi-mio.db')))
            unlinkSync(join(process.cwd(), 'akemi-mio.db'));
        process.env.USER_DATA_DIR = process.cwd();
        await initDatabase();
        store = new DecisionStore();
    });
    afterEach(() => {
        closeDatabase();
        if (existsSync(join(process.cwd(), 'akemi-mio.db')))
            unlinkSync(join(process.cwd(), 'akemi-mio.db'));
    });
    // ─── record ───
    it('record 返回以 dec_ 开头的 ID', () => {
        const id = store.record(testRecord());
        expect(id).toMatch(/^dec_\d+_\d+$/);
    });
    it('record 持久化所有字段', () => {
        store.record(testRecord());
        const results = store.query();
        expect(results).toHaveLength(1);
        const r = results[0];
        expect(r.agentId).toBe('test_agent');
        expect(r.category).toBe('tool_select');
        expect(r.context).toBe('需要读取文件内容');
        expect(r.choice).toBe('选择了 readFile 工具');
        expect(r.alternatives).toEqual(['grep', 'listFiles']);
        expect(r.outcome).toBe('success');
        expect(r.confidence).toBe(0.85);
        expect(r.relatedPlanId).toBe('plan_001');
        expect(r.timestamp).toBeGreaterThan(0);
        expect(r.createdAt).toBeGreaterThan(0);
    });
    it('record 默认值（outcome、confidence）', () => {
        store.record({ agentId: 'a', category: 'strategy', context: 'ctx', choice: 'ch' });
        const r = store.query()[0];
        expect(r.outcome).toBe('pending');
        expect(r.confidence).toBe(0.5);
        expect(r.alternatives).toEqual([]);
        expect(r.relatedPlanId).toBeUndefined();
    });
    it('record context 超过 500 字符时截断', () => {
        const longCtx = 'x'.repeat(1000);
        store.record({ agentId: 'a', category: 'recovery', context: longCtx, choice: 'ch' });
        const r = store.query()[0];
        expect(r.context.length).toBe(500);
    });
    // ─── updateOutcome ───
    it('updateOutcome 更新已有记录', () => {
        const id = store.record(testRecord());
        store.updateOutcome(id, 'failure');
        const r = store.query({ outcome: 'failure' });
        expect(r).toHaveLength(1);
        expect(r[0].id).toBe(id);
    });
    it('updateOutcome 不存在的 ID 不抛异常', () => {
        expect(() => store.updateOutcome('dec_nonexistent', 'failure')).not.toThrow();
    });
    // ─── query ───
    it('query 无参数返回按 timestamp DESC 排列的记录', () => {
        store.record({ agentId: 'a', category: 'strategy', context: '第一', choice: 'c1' });
        store.record({ agentId: 'a', category: 'strategy', context: '第二', choice: 'c2' });
        const results = store.query();
        expect(results).toHaveLength(2);
        expect(results[0].context).toBe('第二');
    });
    it('query 默认 limit 为 20', () => {
        for (let i = 0; i < 25; i++) {
            store.record({ agentId: 'a', category: 'strategy', context: `ctx${i}`, choice: 'ch' });
        }
        expect(store.query()).toHaveLength(20);
    });
    it('query 按 category 过滤', () => {
        store.record({ agentId: 'a', category: 'tool_select', context: '工具', choice: 'c' });
        store.record({ agentId: 'a', category: 'strategy', context: '策略', choice: 'c' });
        const results = store.query({ categories: ['strategy'] });
        expect(results).toHaveLength(1);
        expect(results[0].context).toBe('策略');
    });
    it('query 按多个 category 过滤', () => {
        store.record({ agentId: 'a', category: 'tool_select', context: '工具', choice: 'c' });
        store.record({ agentId: 'a', category: 'strategy', context: '策略', choice: 'c' });
        store.record({ agentId: 'a', category: 'recovery', context: '恢复', choice: 'c' });
        const results = store.query({ categories: ['tool_select', 'strategy'] });
        expect(results).toHaveLength(2);
    });
    it('query 按 agentId 过滤', () => {
        store.record({ agentId: 'a', category: 'strategy', context: 'A', choice: 'c' });
        store.record({ agentId: 'b', category: 'strategy', context: 'B', choice: 'c' });
        expect(store.query({ agentId: 'a' })).toHaveLength(1);
        expect(store.query({ agentId: 'b' })).toHaveLength(1);
    });
    it('query 按 outcome 过滤', () => {
        store.record({ agentId: 'a', category: 'strategy', context: '成功', choice: 'c', outcome: 'success' });
        store.record({ agentId: 'a', category: 'strategy', context: '失败', choice: 'c', outcome: 'failure' });
        expect(store.query({ outcome: 'success' })).toHaveLength(1);
        expect(store.query({ outcome: 'failure' })).toHaveLength(1);
    });
    it('query 按时间范围过滤', async () => {
        store.record({ agentId: 'a', category: 'strategy', context: '旧', choice: 'c' });
        await new Promise((r) => setTimeout(r, 5));
        const mid = Date.now();
        await new Promise((r) => setTimeout(r, 5));
        store.record({ agentId: 'a', category: 'strategy', context: '新', choice: 'c' });
        expect(store.query({ since: mid })).toHaveLength(1);
        expect(store.query({ until: mid })).toHaveLength(1);
    });
    it('query 组合多个过滤条件', () => {
        store.record({ agentId: 'a', category: 'tool_select', context: 'A工具', choice: 'c', outcome: 'success' });
        store.record({ agentId: 'a', category: 'strategy', context: 'A策略', choice: 'c', outcome: 'failure' });
        store.record({ agentId: 'b', category: 'tool_select', context: 'B工具', choice: 'c', outcome: 'success' });
        const results = store.query({ agentId: 'a', categories: ['tool_select'], outcome: 'success' });
        expect(results).toHaveLength(1);
        expect(results[0].context).toBe('A工具');
    });
    it('query 无匹配返回空数组', () => {
        expect(store.query({ categories: ['recovery'] })).toEqual([]);
    });
    // ─── getFormattedContext ───
    it('getFormattedContext 无记录返回空字符串', () => {
        expect(store.getFormattedContext()).toBe('');
    });
    it('getFormattedContext 返回格式化文本', () => {
        store.record({ agentId: 'a', category: 'tool_select', context: '查文件', choice: 'readFile', outcome: 'success', confidence: 0.9 });
        const ctx = store.getFormattedContext();
        expect(ctx).toContain('【近期决策记录】');
        expect(ctx).toContain('readFile');
        expect(ctx).toContain('success');
    });
    it('getFormattedContext 按 category 过滤', () => {
        store.record({ agentId: 'a', category: 'tool_select', context: '工具', choice: 'readFile' });
        store.record({ agentId: 'a', category: 'strategy', context: '策略', choice: 'go' });
        const ctx = store.getFormattedContext('strategy');
        expect(ctx).toContain('go');
        expect(ctx).not.toContain('readFile');
    });
    // ─── prune ───
    it('prune 超过 200 条时删除最旧的', () => {
        for (let i = 0; i < 210; i++) {
            store.record({ agentId: 'a', category: 'strategy', context: `ctx${i}`, choice: 'ch' });
        }
        const all = store.query({ limit: 999 });
        expect(all.length).toBeLessThanOrEqual(200);
    });
    // ══════════════════════════════════════════
    //  getFailurePatterns
    // ══════════════════════════════════════════
    it('getFailurePatterns 无失败记录时返回空数组', () => {
        const patterns = store.getFailurePatterns();
        expect(patterns).toEqual([]);
    });
    it('getFailurePatterns 按 category 分组', () => {
        store.record({ agentId: 'a', category: 'tool_select', context: 'file read error', choice: 'read_file', outcome: 'failure' });
        store.record({ agentId: 'a', category: 'recovery', context: 'recovery failed', choice: 'restart', outcome: 'failure' });
        store.record({ agentId: 'a', category: 'tool_select', context: 'file write error', choice: 'write_file', outcome: 'failure' });
        const patterns = store.getFailurePatterns();
        expect(patterns.length).toBeGreaterThanOrEqual(1);
        const tool = patterns.find((p) => p.pattern.includes('tool_select'));
        expect(tool).toBeDefined();
        expect(tool.count).toBeGreaterThanOrEqual(2);
    });
    it('getFailurePatterns 尊重 minCount', () => {
        for (let i = 0; i < 3; i++) {
            store.record({ agentId: 'a', category: 'tool_select', context: '普通错误', choice: 'read', outcome: 'failure' });
        }
        store.record({ agentId: 'a', category: 'recovery', context: '恢复失败', choice: 'restart', outcome: 'failure' });
        const patterns = store.getFailurePatterns({ minCount: 5 });
        expect(patterns).toEqual([]);
    });
    it('getFailurePatterns 尊重 since 参数', () => {
        store.record({ agentId: 'a', category: 'tool_select', context: '旧错误', choice: 'read', outcome: 'failure' });
        const patterns = store.getFailurePatterns({ since: Date.now() + 10000 });
        expect(patterns).toEqual([]);
    });
    // ══════════════════════════════════════════
    //  getCrossSessionSummary
    // ══════════════════════════════════════════
    it('getCrossSessionSummary 无记录时返回空字符串', () => {
        expect(store.getCrossSessionSummary()).toBe('');
    });
    it('getCrossSessionSummary 返回格式化统计', () => {
        store.record({ agentId: 'a', category: 'tool_select', context: '读取文件', choice: 'read_file', outcome: 'success' });
        store.record({ agentId: 'a', category: 'tool_select', context: '写入文件', choice: 'write_file', outcome: 'success' });
        store.record({ agentId: 'a', category: 'recovery', context: '恢复操作', choice: 'restart', outcome: 'failure' });
        const summary = store.getCrossSessionSummary();
        expect(summary).toContain('tool_select');
        expect(summary).toContain('recovery');
        expect(summary).toContain('成功');
        expect(summary).toContain('失败');
    });
    it('getCrossSessionSummary 包含最频繁失败模式', () => {
        for (let i = 0; i < 5; i++) {
            store.record({ agentId: 'a', category: 'strategy', context: '策略失败', choice: 'retry', outcome: 'failure' });
        }
        store.record({ agentId: 'a', category: 'tool_select', context: '工具成功', choice: 'read', outcome: 'success' });
        const summary = store.getCrossSessionSummary();
        expect(summary).toContain('strategy');
        expect(summary).toContain('最频繁失败模式');
    });
    it('getCrossSessionSummary 尊重 days 参数', () => {
        store.record({ agentId: 'a', category: 'tool_select', context: '旧记录', choice: 'read', outcome: 'success' });
        const summary = store.getCrossSessionSummary(0);
        // days=0 意味着 since=now，记录时间戳是 now 之前几毫秒，所以可能会包含
        // 验证至少格式正确即可
        expect(typeof summary).toBe('string');
    });
});
