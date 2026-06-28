import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskRunner } from '../TaskRunner';
vi.mock('../../../logger/Logger', () => ({ log: vi.fn() }));
describe('TaskRunner — getTaskHealthSummary', () => {
    let runner;
    beforeEach(() => {
        runner = new TaskRunner();
    });
    afterEach(() => {
        runner.stop();
    });
    it('空 runner 返回空数组', () => {
        expect(runner.getTaskHealthSummary()).toEqual([]);
    });
    it('单个已注册任务 idle', () => {
        runner.register('creativity.cycle', async () => ({ success: true }), 60000);
        const summary = runner.getTaskHealthSummary();
        expect(summary).toHaveLength(1);
        expect(summary[0].type).toBe('creativity.cycle');
        expect(summary[0].status).toBe('idle');
        expect(summary[0].consecutiveFailures).toBe(0);
        expect(summary[0].tier).toBe('best_effort');
        expect(summary[0].disabled).toBe(false);
    });
    it('critical 任务 tier 反映正确', () => {
        runner.register('stability.tick', async () => ({ success: true }), 60000, { tier: 'critical' });
        expect(runner.getTaskHealthSummary()[0].tier).toBe('critical');
    });
    it('important 任务 tier 反映正确', () => {
        runner.register('memory.index', async () => ({ success: true }), 60000, { tier: 'important' });
        expect(runner.getTaskHealthSummary()[0].tier).toBe('important');
    });
    it('best_effort 多次失败 → stopType 移除定时器', async () => {
        runner.register('creativity.cycle', async () => ({ success: false, summary: 'fail' }), 0, {
            tier: 'best_effort',
            maxFailures: 2,
        });
        await runner.triggerNow('creativity.cycle');
        await runner.triggerNow('creativity.cycle');
        const summary = runner.getTaskHealthSummary();
        expect(summary[0].consecutiveFailures).toBeGreaterThanOrEqual(1);
        expect(runner.timers.has('creativity.cycle')).toBe(false);
    });
    it('critical 多次失败 进 cooldown', async () => {
        runner.register('stability.tick', async () => ({ success: false, summary: 'fail' }), 0, { tier: 'critical', maxFailures: 3 });
        await runner.triggerNow('stability.tick');
        await runner.triggerNow('stability.tick');
        await runner.triggerNow('stability.tick');
        const summary = runner.getTaskHealthSummary();
        expect(summary[0].disabled).toBe(false);
        expect(summary[0].consecutiveFailures).toBeGreaterThanOrEqual(3);
    });
    it('多个任务混合', async () => {
        runner.register('evolution.analysis', async () => ({ success: true }), 0, { tier: 'important' });
        runner.register('creativity.dream', async () => ({ success: false, summary: 'fail' }), 0, {
            tier: 'best_effort',
            maxFailures: 2,
        });
        await runner.triggerNow('creativity.dream');
        await runner.triggerNow('creativity.dream');
        const summary = runner.getTaskHealthSummary();
        expect(summary).toHaveLength(2);
        // best_effort task: after maxFailures, stopType removes its timer
        // important task: still running
        const dream = summary.find((s) => s.type === 'creativity.dream');
        expect(dream.consecutiveFailures).toBeGreaterThanOrEqual(1);
        expect(dream.tier).toBe('best_effort');
        expect(dream.status).toBe('running'); // last tick status
        const analysis = summary.find((s) => s.type === 'evolution.analysis');
        expect(analysis.disabled).toBe(false);
        expect(analysis.tier).toBe('important');
    });
});
