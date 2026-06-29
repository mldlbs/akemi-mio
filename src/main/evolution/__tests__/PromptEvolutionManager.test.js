import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PromptEvolutionManager } from '../PromptEvolutionManager';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
vi.mock('../../logger/Logger', () => ({ log: vi.fn() }));
function makeTempDir() {
    const d = join(tmpdir(), `prompt-evolution-test-${Date.now()}`);
    mkdirSync(d, { recursive: true });
    return d;
}
describe('PromptEvolutionManager', () => {
    let manager;
    let tmpDir;
    beforeEach(() => {
        tmpDir = makeTempDir();
        manager = new PromptEvolutionManager(tmpDir);
    });
    afterEach(() => {
        try {
            rmSync(tmpDir, { recursive: true });
        }
        catch {
            /* ignore */
        }
    });
    it('初始化后 base overlay 为空字符串', () => {
        expect(manager.getOverlay('analysis_prompt')).toBe('');
        expect(manager.getCurrentVersion('analysis_prompt')).toBe(1);
    });
    it('evolvePrompt 创建新版本并更新 overlay', () => {
        const pv = manager.evolvePrompt('analysis_prompt', '反模式检测', ['避免重复分析相同模块']);
        expect(pv).not.toBeNull();
        expect(pv.version).toBe(2);
        expect(manager.getCurrentVersion('analysis_prompt')).toBe(2);
        expect(manager.getOverlay('analysis_prompt')).toContain('避免重复分析相同模块');
    });
    it('多次 evolvePrompt 叠加版本', () => {
        manager.evolvePrompt('analysis_prompt', '问题A', ['指令A']);
        manager.evolvePrompt('analysis_prompt', '问题B', ['指令B']);
        expect(manager.getCurrentVersion('analysis_prompt')).toBe(3);
        expect(manager.getOverlay('analysis_prompt')).toContain('指令A');
        expect(manager.getOverlay('analysis_prompt')).toContain('指令B');
    });
    it('resetToBase 回到版本 1', () => {
        manager.evolvePrompt('analysis_prompt', '问题', ['指令']);
        manager.resetToBase('analysis_prompt');
        expect(manager.getCurrentVersion('analysis_prompt')).toBe(1);
        expect(manager.getOverlay('analysis_prompt')).toBe('');
    });
    it('resetToBase 在 base 时返回 null', () => {
        expect(manager.resetToBase('analysis_prompt')).toBeNull();
    });
    it('recordCycleResult 更新性能统计', () => {
        manager.recordCycleResult('analysis_prompt', 1, true, 85);
        manager.recordCycleResult('analysis_prompt', 1, false);
        expect(manager.getCurrentVersion('analysis_prompt')).toBe(1);
    });
    it('summarizeOverlays 合并多条规则', () => {
        manager.evolvePrompt('analysis_prompt', 'A', ['必须分析项目中未被检测的代码模块']);
        manager.evolvePrompt('analysis_prompt', 'B', ['避免在每次分析中重复检查 config 文件']);
        const pv = manager.summarizeOverlays('analysis_prompt');
        expect(pv).not.toBeNull();
        expect(pv.version).toBeGreaterThan(2);
        expect(manager.getOverlay('analysis_prompt')).toContain('未被检测的代码模块');
        expect(manager.getOverlay('analysis_prompt')).toContain('重复检查 config');
    });
    it('shouldCompact 在版本过多时触发', () => {
        for (let i = 0; i < 6; i++) {
            manager.evolvePrompt('analysis_prompt', `issue ${i}`, [`rule ${i}`]);
        }
        const result = manager.shouldCompact('analysis_prompt');
        expect(result.needSummarize).toBe(true);
    });
    it('pruneStaleRules 移除低分版本规则', () => {
        manager.evolvePrompt('analysis_prompt', '退化问题', ['第一条规则']);
        manager.recordCycleResult('analysis_prompt', 2, false);
        manager.recordCycleResult('analysis_prompt', 2, false);
        const count = manager.pruneStaleRules('analysis_prompt');
        expect(typeof count).toBe('number');
    });
    it('llmEvolvePrompt 失败时回退到硬编码模式', async () => {
        const failingAgent = {
            runAgentTask: async () => {
                throw new Error('timeout');
            },
        };
        const pv = await manager.llmEvolvePrompt('analysis_prompt', '退化', '连续相同结论', failingAgent);
        expect(pv).not.toBeNull();
        expect(pv.version).toBe(2);
    });
    it('llmEvolvePrompt 使用 LLM 输出时解析反模式指令', async () => {
        const mockAgent = {
            runAgentTask: async () => ({ success: true, summary: '- 第一条指令\n- 第二条指令\n' }),
        };
        const pv = await manager.llmEvolvePrompt('analysis_prompt', '退化', '失败摘要', mockAgent);
        expect(pv).not.toBeNull();
        expect(pv.version).toBe(2);
    });
    it('persistence 跨实例恢复状态', () => {
        manager.evolvePrompt('analysis_prompt', '测试', ['规则X']);
        const manager2 = new PromptEvolutionManager(tmpDir);
        expect(manager2.getCurrentVersion('analysis_prompt')).toBe(2);
        expect(manager2.getOverlay('analysis_prompt')).toContain('规则X');
    });
    it('getRegistrySummary 返回非空字符串', () => {
        manager.evolvePrompt('analysis_prompt', '问题', ['指令']);
        const summary = manager.getRegistrySummary();
        expect(summary).toContain('analysis_prompt');
        expect(summary).toContain('v2');
    });
    it('100 次 evolvePrompt 后 compaction 正确性', () => {
        for (let i = 0; i < 100; i++) {
            manager.evolvePrompt('analysis_prompt', `issue ${i}`, [`rule ${i}`]);
        }
        const overlay = manager.getOverlay('analysis_prompt');
        expect(overlay.length).toBeGreaterThan(0);
        const result = manager.shouldCompact('analysis_prompt');
        expect(result.needSummarize).toBe(true);
    }, 30000);
});
