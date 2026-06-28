import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EvolutionAnalyzer } from '../pipeline/EvolutionAnalyzer';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
vi.mock('../../logger/Logger', () => ({ log: vi.fn() }));
function makeTestPaths() {
    const d = join(tmpdir(), `evolution-analyzer-test-${Date.now()}`);
    mkdirSync(d, { recursive: true });
    return { historyPath: join(d, 'history.json'), livingPlanDir: d };
}
describe('EvolutionAnalyzer', () => {
    let analyzer;
    let paths;
    let agentService;
    let planManager;
    beforeEach(() => {
        paths = makeTestPaths();
        planManager = { getActivePlan: vi.fn(() => null), listPlans: vi.fn(() => []), getFormattedContext: vi.fn(() => '') };
        agentService = {
            runSelfTask: vi.fn().mockResolvedValue({ success: true, summary: '分析完成' }),
            isBusy: vi.fn(() => false),
            abortSelfTask: vi.fn(),
        };
        analyzer = new EvolutionAnalyzer(agentService, planManager, {
            historyPath: paths.historyPath,
            analysisTimeoutMs: 60000,
            degenerationThreshold: 3,
        });
    });
    afterEach(() => {
        try {
            rmSync(paths.livingPlanDir, { recursive: true });
        }
        catch { }
    });
    it('init state 转换', async () => {
        expect(analyzer.state).toBe('created');
        await analyzer.init();
        expect(analyzer.state).toBe('ready');
    });
    it('detectPlanMode 无计划返回 first_run', () => {
        expect(analyzer.detectPlanMode().mode).toBe('first_run');
    });
    it('detectPlanMode 有活跃计划返回 continue_plan', () => {
        planManager.getActivePlan = vi.fn(() => ({
            id: 'p1',
            title: '测试',
            steps: [{ id: 's1', description: 's', status: 'pending' }],
            status: 'active',
        }));
        planManager.listPlans = vi.fn(() => [
            { id: 'p1', title: '测试', steps: [{ id: 's1', description: 's', status: 'pending' }], status: 'active' },
        ]);
        expect(analyzer.detectPlanMode().mode).toBe('continue_plan');
    });
    it('isDegenerate 指纹不足时不退化', () => {
        analyzer.recordFingerprint('A');
        analyzer.recordFingerprint('B');
        expect(analyzer.isDegenerate()).toBe(false);
    });
    it('isDegenerate 连续相同指纹触发退化', () => {
        for (let i = 0; i < 3; i++)
            analyzer.recordFingerprint('相同内容');
        expect(analyzer.isDegenerate()).toBe(true);
    });
    it('fingerprint > 10 截断', () => {
        for (let i = 0; i < 15; i++)
            analyzer.recordFingerprint(`fp${i}`);
        expect(analyzer.getFingerprints().length).toBeLessThanOrEqual(10);
    });
    it('shouldAnalyze 退化时返回 false', () => {
        for (let i = 0; i < 3; i++)
            analyzer.recordFingerprint('same');
        expect(analyzer.shouldAnalyze().shouldRun).toBe(false);
    });
    it('shouldAnalyze 有活跃计划时返回 false', () => {
        planManager.getActivePlan = vi.fn(() => ({
            id: 'p1',
            title: 't',
            steps: [{ id: 's', description: 's', status: 'pending' }],
            status: 'active',
        }));
        expect(analyzer.shouldAnalyze().shouldRun).toBe(false);
    });
    it('shouldAnalyze 正常时返回 true', () => {
        expect(analyzer.shouldAnalyze().shouldRun).toBe(true);
    });
    it('analyze 调用 agentService', async () => {
        const input = {
            mode: 'first_run',
            planContext: '',
            historySummary: '',
            safetyMode: 'auto',
            livingPlanCtx: '',
            cognitiveCtx: '',
            strategyCtx: '',
            promptMode: 'full',
        };
        const result = await analyzer.analyze(input);
        expect(agentService.runSelfTask).toHaveBeenCalled();
        expect(result.success).toBe(true);
    });
    it('analyze 异常时返回 hadTimeout', async () => {
        agentService.runSelfTask = vi.fn().mockRejectedValue(new Error('API error'));
        const input = {
            mode: 'first_run',
            planContext: '',
            historySummary: '',
            safetyMode: 'auto',
            livingPlanCtx: '',
            cognitiveCtx: '',
            strategyCtx: '',
            promptMode: 'full',
        };
        const result = await analyzer.analyze(input);
        expect(result.success).toBe(false);
        expect(result.hadTimeout).toBe(true);
    });
    it('getHistorySummary 空历史返回首次运行提示', () => {
        expect(analyzer.getHistorySummary()).toContain('首次运行');
    });
    it('setter/getter 参数自适应', () => {
        analyzer.setPromptTrimMode(true);
        expect(analyzer.getPromptTrimMode()).toBe(true);
        analyzer.setHistoryMaxEntries(10);
        expect(analyzer.getHistoryMaxEntries()).toBe(10);
        analyzer.setAnalysisTimeout(300000);
        expect(analyzer.getAnalysisTimeout()).toBe(300000);
    });
});
