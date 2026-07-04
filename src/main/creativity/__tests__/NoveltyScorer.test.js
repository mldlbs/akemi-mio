import { describe, it, expect } from 'vitest';
import { jaccardSimilarity, evaluateNovelty } from '../NoveltyScorer';
describe('jaccardSimilarity', () => {
    it('完全相同文本返回 1', () => {
        expect(jaccardSimilarity('hello world', 'hello world')).toBe(1);
    });
    it('完全无关文本返回 0', () => {
        expect(jaccardSimilarity('', '')).toBe(0);
    });
    it('中文相同文本返回 1', () => {
        expect(jaccardSimilarity('神经网络优化算法', '神经网络优化算法')).toBe(1);
    });
    it('中文部分重叠返回中间值', () => {
        const sim = jaccardSimilarity('神经网络训练方法', '神经网络推理加速');
        expect(sim).toBeGreaterThan(0);
        expect(sim).toBeLessThan(1);
    });
    it('混合中英文正常计算', () => {
        const sim = jaccardSimilarity('使用 Transformer 改进语音合成质量', 'Transformer 在语音识别中的应用');
        expect(sim).toBeGreaterThan(0);
        expect(sim).toBeLessThan(1);
    });
    it('短文本不因长度差异导致异常', () => {
        const sim = jaccardSimilarity('a', 'long text with many words here');
        expect(sim).toBeGreaterThanOrEqual(0);
        expect(sim).toBeLessThanOrEqual(1);
    });
});
describe('evaluateNovelty', () => {
    it('不相似时原样保留 novelty', () => {
        const result = evaluateNovelty({ title: '全新方向', idea: '用图神经网络分析代码依赖', novelty: 85 }, [{ title: '语音增强', idea: '用卷积网络处理音频信号', novelty: 70 }], []);
        expect(result.shouldReject).toBe(false);
        expect(result.adjustedNovelty).toBe(85);
    });
    it('与近期假设高度相似时扣 15 分', () => {
        const result = evaluateNovelty({ title: '新方案', idea: '用强化学习优化对话策略', novelty: 80 }, [{ title: '旧方案', idea: '用强化学习优化对话管理策略', novelty: 75 }], []);
        expect(result.shouldReject).toBe(false);
        expect(result.adjustedNovelty).toBe(65);
    });
    it('扣分不低于 0', () => {
        const result = evaluateNovelty({ title: '相同内容', idea: '重复的假设文本', novelty: 10 }, [{ title: '旧内容', idea: '重复的假设文本内容', novelty: 70 }], []);
        expect(result.adjustedNovelty).toBe(0);
    });
    it('与已拒绝假设高度相似时自动拒绝', () => {
        const ideaBase = '用区块链技术存储所有用户对话历史记录确保数据不可篡改';
        const result = evaluateNovelty({ title: '新假设', idea: ideaBase, novelty: 90 }, [], [{ title: '已拒假设', idea: ideaBase }]);
        expect(result.shouldReject).toBe(true);
        expect(result.rejectReason).toContain('已拒绝');
    });
    it('已拒绝优先于降分', () => {
        const similarIdea = '文件系统缓存优化设计';
        const result = evaluateNovelty({ title: '雷同方案', idea: similarIdea, novelty: 75 }, [{ title: '近期方案', idea: '文件系统缓存策略分析', novelty: 70 }], [{ title: '已拒方案', idea: similarIdea }]);
        expect(result.shouldReject).toBe(true);
    });
    it('空列表时不做任何调整', () => {
        const result = evaluateNovelty({ title: '全新想法', idea: '一个完全原创的概念', novelty: 95 }, [], []);
        expect(result.shouldReject).toBe(false);
        expect(result.adjustedNovelty).toBe(95);
        expect(result.mostSimilarScore).toBe(0);
    });
});
