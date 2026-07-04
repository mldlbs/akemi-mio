import { describe, it, expect } from 'vitest';
import { buildCreativityPrompt } from '../CreativityPrompt';
describe('buildCreativityPrompt', () => {
    const sources = [{ name: 'Memory', content: '对话记忆系统', type: 'knowledge', weight: 0.9 }];
    const combos = [{ sources: ['Memory', 'Agent'], description: 'Memory × Agent' }];
    it('无 externalSignals 时输出不包含外部信号段', () => {
        const prompt = buildCreativityPrompt(sources, combos);
        expect(prompt).toContain('可用概念来源');
        expect(prompt).toContain('推荐配对组合');
        expect(prompt).not.toContain('外部信号');
    });
    it('有 externalSignals 时包含审视视角段', () => {
        const signals = [{ source: 'Observer', raw: '[↑] AI 趋势 (强度:85)', type: 'trend' }];
        const prompt = buildCreativityPrompt(sources, combos, signals);
        expect(prompt).toContain('外部信号');
        expect(prompt).toContain('[trend@Observer]');
        expect(prompt).toContain('审视视角');
        expect(prompt).toContain('不可配对');
    });
    it('多个外部信号逐条列出', () => {
        const signals = [
            { source: 'Observer', raw: 'trend 1', type: 'trend' },
            { source: 'Observer', raw: 'insight 2', type: 'insight' },
        ];
        const prompt = buildCreativityPrompt(sources, combos, signals);
        expect(prompt).toContain('trend 1');
        expect(prompt).toContain('insight 2');
    });
    it('外部信号与来源和配对被正确分段', () => {
        const signals = [{ source: 'Observer', raw: 'event data', type: 'anomaly' }];
        const prompt = buildCreativityPrompt(sources, combos, signals);
        // 三个段应依次出现
        const sourceIdx = prompt.indexOf('可用概念来源');
        const comboIdx = prompt.indexOf('推荐配对组合');
        const signalIdx = prompt.indexOf('外部信号');
        expect(sourceIdx).toBeLessThan(comboIdx);
        expect(comboIdx).toBeLessThan(signalIdx);
    });
    it('空 externalSignals 数组不产生外部信号段', () => {
        const prompt = buildCreativityPrompt(sources, combos, []);
        expect(prompt).not.toContain('外部信号');
    });
});
