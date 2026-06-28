import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IdeaGenerator } from '../IdeaGenerator';
function makeSource(name, type = 'knowledge', weight = 0.8) {
    return { name, content: 'test content', type, weight };
}
describe('IdeaGenerator', () => {
    let chatJson;
    beforeEach(() => {
        chatJson = vi.fn();
    });
    describe('generateIdeas — strategy-aware novelty gate', () => {
        it('stable mode 使用 novelty >= 40 阈值', async () => {
            const gen = new IdeaGenerator(chatJson, 0, 42);
            gen.setTemperature(0); // 禁用随机过滤
            chatJson.mockResolvedValue({
                data: [
                    {
                        title: '稳定改进',
                        idea: '这是一个足够描述的改进方案不少于二十个字的内容描述',
                        expectedBenefit: '提升稳定性',
                        risk: '可能增加复杂度',
                        sourceLabels: ['ASR', 'MCP'],
                        novelty: 45,
                        feasibility: 60,
                        impact: 50,
                    },
                ],
            });
            const sources = [makeSource('ASR', 'knowledge'), makeSource('MCP', 'knowledge')];
            const ideas = await gen.generateIdeas(sources, 5, 'stable');
            expect(ideas).toHaveLength(1);
        });
        it('signal mode 使用 novelty >= 60 阈值', async () => {
            const gen = new IdeaGenerator(chatJson, 0, 42);
            gen.setTemperature(0);
            chatJson.mockResolvedValue({
                data: [
                    {
                        title: '高新颖度方案',
                        idea: '这是一个足够描述的创新方案不少于二十个字的内容填充',
                        expectedBenefit: '突破性提升',
                        risk: '不确定性高',
                        sourceLabels: ['Insight', 'Agent'],
                        novelty: 58,
                        feasibility: 40,
                        impact: 70,
                    },
                ],
            });
            // 包含 signal 来源（insight），确保 signal mode 有配对
            const sources = [makeSource('Insight', 'insight'), makeSource('Agent', 'behavior')];
            const ideas = await gen.generateIdeas(sources, 5, 'signal');
            expect(ideas).toHaveLength(0);
        });
        it('explore mode 使用 novelty >= 55 阈值', async () => {
            const gen = new IdeaGenerator(chatJson, 0, 42);
            gen.setTemperature(0);
            chatJson.mockResolvedValue({
                data: [
                    {
                        title: '探索方案',
                        idea: '这是一个足够描述的探索方案不少于二十个字的内容延展',
                        expectedBenefit: '探索新方向',
                        risk: '方向不确定',
                        sourceLabels: ['ASR', 'Behavior'],
                        novelty: 55,
                        feasibility: 50,
                        impact: 60,
                    },
                ],
            });
            const sources = [makeSource('ASR', 'knowledge'), makeSource('Behavior', 'behavior')];
            const ideas = await gen.generateIdeas(sources, 5, 'explore');
            expect(ideas).toHaveLength(1);
        });
    });
    describe('generateIdeas — externalSignals passthrough', () => {
        it('externalSignals 参数被透传到 HypothesisGenerator', async () => {
            const gen = new IdeaGenerator(chatJson, 0, 42);
            gen.setTemperature(0);
            chatJson.mockResolvedValue({
                data: [
                    {
                        title: '信号感知方案',
                        idea: '基于外部趋势的改进方案这是一个足够长的描述文本内容',
                        expectedBenefit: '趋势驱动',
                        risk: '趋势变化快',
                        sourceLabels: ['Memory', 'Agent'],
                        novelty: 55,
                        feasibility: 50,
                        impact: 60,
                    },
                ],
            });
            const sources = [makeSource('Memory', 'knowledge'), makeSource('Agent', 'behavior')];
            const signals = [{ source: 'Observer', raw: 'test trend', type: 'trend' }];
            await gen.generateIdeas(sources, 5, 'explore', signals);
            expect(chatJson).toHaveBeenCalledTimes(1);
            const promptArg = chatJson.mock.calls[0][0];
            expect(promptArg).toContain('test trend');
            expect(promptArg).toContain('外部信号');
        });
        it('无 externalSignals 时 prompt 不含外部信号段', async () => {
            const gen = new IdeaGenerator(chatJson, 0, 42);
            gen.setTemperature(0);
            chatJson.mockResolvedValue({
                data: [
                    {
                        title: '普通方案',
                        idea: '这是一个普通方案描述不少于二十个字的内容以确保通过检查',
                        expectedBenefit: '稳定收益',
                        risk: '无显著风险',
                        sourceLabels: ['Memory', 'Agent'],
                        novelty: 55,
                        feasibility: 60,
                        impact: 50,
                    },
                ],
            });
            const sources = [makeSource('Memory', 'knowledge'), makeSource('Agent', 'behavior')];
            await gen.generateIdeas(sources, 5, 'explore');
            expect(chatJson).toHaveBeenCalledTimes(1);
            const promptArg = chatJson.mock.calls[0][0];
            expect(promptArg).not.toContain('外部信号');
        });
    });
});
