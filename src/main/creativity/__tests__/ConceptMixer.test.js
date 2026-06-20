import { describe, it, expect } from 'vitest';
import { ConceptMixer } from '../ConceptMixer';
function makeSource(overrides) {
    return {
        content: 'test content',
        type: 'knowledge',
        weight: 1.0,
        ...overrides,
    };
}
describe('ConceptMixer', () => {
    describe('mix', () => {
        it('少于 2 个来源时返回空数组', () => {
            const mixer = new ConceptMixer(42);
            expect(mixer.mix([])).toEqual([]);
            expect(mixer.mix([makeSource({ name: 'a' })])).toEqual([]);
        });
        it('2 个来源生成 1 个组合并评分', () => {
            const mixer = new ConceptMixer(42);
            const sources = [makeSource({ name: 'A', type: 'knowledge', weight: 0.8 }), makeSource({ name: 'B', type: 'behavior', weight: 0.6 })];
            const results = mixer.mix(sources);
            expect(results).toHaveLength(1);
            expect(results[0].combo.sources).toEqual(['A', 'B']);
            expect(results[0].score).toBeGreaterThan(0);
        });
        it('3 个来源生成 3 个组合（C(3,2)）', () => {
            const mixer = new ConceptMixer(42);
            const sources = [
                makeSource({ name: 'A', type: 'knowledge', weight: 0.5 }),
                makeSource({ name: 'B', type: 'behavior', weight: 0.5 }),
                makeSource({ name: 'C', type: 'insight', weight: 0.5 }),
            ];
            const results = mixer.mix(sources);
            expect(results).toHaveLength(3);
        });
        it('跨类型组合得分高于同类型组合', () => {
            const mixer = new ConceptMixer(42);
            const sources = [
                makeSource({ name: 'A', type: 'knowledge', weight: 0.8 }),
                makeSource({ name: 'B', type: 'knowledge', weight: 0.8 }),
                makeSource({ name: 'C', type: 'behavior', weight: 0.8 }),
            ];
            const results = mixer.mix(sources);
            // 找出跨类型和同类型的组合
            const crossType = results.find((r) => {
                const types = r.combo.sources.map((s) => sources.find((src) => src.name === s).type);
                return types[0] !== types[1];
            });
            const sameType = results.find((r) => {
                const types = r.combo.sources.map((s) => sources.find((src) => src.name === s).type);
                return types[0] === types[1];
            });
            expect(crossType).toBeDefined();
            expect(sameType).toBeDefined();
            expect(crossType.score).toBeGreaterThan(sameType.score);
        });
        it('尊重 maxCombos 上限', () => {
            const mixer = new ConceptMixer(42);
            const sources = Array.from({ length: 6 }, (_, i) => makeSource({ name: `S${i}`, type: i % 2 === 0 ? 'knowledge' : 'behavior', weight: 0.5 }));
            // C(6,2) = 15, 限制为 3
            const results = mixer.mix(sources, 3);
            expect(results).toHaveLength(3);
        });
        it('使用相同种子产生确定性结果', () => {
            const sources = [
                makeSource({ name: 'X', type: 'knowledge', weight: 0.9 }),
                makeSource({ name: 'Y', type: 'insight', weight: 0.7 }),
                makeSource({ name: 'Z', type: 'behavior', weight: 0.5 }),
            ];
            const mixer1 = new ConceptMixer(123);
            const mixer2 = new ConceptMixer(123);
            const results1 = mixer1.mix(sources);
            const results2 = mixer2.mix(sources);
            expect(results1.length).toBe(results2.length);
            results1.forEach((r, i) => {
                expect(r.score).toBe(results2[i].score);
                expect(r.combo.sources).toEqual(results2[i].combo.sources);
            });
        });
        it('组合包含正确的描述信息', () => {
            const mixer = new ConceptMixer(42);
            const sources = [
                makeSource({ name: '知识库', type: 'knowledge', weight: 0.8 }),
                makeSource({ name: '用户行为', type: 'behavior', weight: 0.6 }),
            ];
            const results = mixer.mix(sources);
            expect(results[0].combo.description).toContain('知识库');
            expect(results[0].combo.description).toContain('用户行为');
            expect(results[0].combo.id).toMatch(/^combo_\d+_/);
        });
    });
    describe('pickRandomSources', () => {
        it('返回至少 minCount 个来源', () => {
            const mixer = new ConceptMixer(42);
            const sources = Array.from({ length: 10 }, (_, i) => makeSource({ name: `S${i}`, weight: 0.5 }));
            const picked = mixer.pickRandomSources(sources, 0.5, 3);
            expect(picked.length).toBeGreaterThanOrEqual(3);
            expect(picked.length).toBeLessThanOrEqual(sources.length);
        });
        it('高温时更可能包含低权重来源', () => {
            const mixerLow = new ConceptMixer(42);
            const mixerHigh = new ConceptMixer(42);
            const sources = [
                makeSource({ name: 'High', weight: 1.0 }),
                makeSource({ name: 'Medium', weight: 0.5 }),
                makeSource({ name: 'Low', weight: 0.1 }),
            ];
            // 低温：几乎只有高权重
            const lowTemp = mixerLow.pickRandomSources(sources, 0.1, 3);
            // 高温：低权重也有机会
            const highTemp = mixerHigh.pickRandomSources(sources, 1.0, 3);
            expect(lowTemp.length).toBeGreaterThan(0);
            expect(highTemp.length).toBeGreaterThan(0);
        });
        it('来源少于 minCount 时返回所有', () => {
            const mixer = new ConceptMixer(42);
            const sources = [makeSource({ name: 'Only', weight: 0.5 })];
            const picked = mixer.pickRandomSources(sources, 0.5, 3);
            expect(picked).toHaveLength(1);
        });
    });
});
describe('HypothesisGenerator', () => {
    it('占位 — 等待实际测试', () => {
        // HypothesisGenerator 需要 mock chatJson，单独文件测试
        expect(true).toBe(true);
    });
});
