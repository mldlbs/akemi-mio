import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { WorldTrendProvider } from '../WorldTrendProvider';
function tmpDir() {
    const d = join(tmpdir(), `wtr-test-${Date.now()}`);
    mkdirSync(d, { recursive: true });
    return d;
}
describe('WorldTrendProvider', () => {
    let dir;
    let provider;
    beforeEach(() => {
        dir = tmpDir();
        provider = new WorldTrendProvider(dir);
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });
    describe('getTrends', () => {
        it('文件不存在时返回空数组', () => {
            expect(provider.getTrends()).toEqual([]);
        });
        it('返回按 momentum 降序排列的趋势', () => {
            const trendsDir = join(dir, 'world_model');
            mkdirSync(trendsDir, { recursive: true });
            writeFileSync(join(trendsDir, 'trends.json'), JSON.stringify([
                { name: '趋势B', momentum: 0.5, direction: 'rising' },
                { name: '趋势A', momentum: 0.9, direction: 'rising' },
                { name: '趋势C', momentum: 0.3, direction: 'falling' },
            ]), 'utf-8');
            const trends = provider.getTrends();
            expect(trends).toHaveLength(3);
            expect(trends[0]).toContain('趋势A');
            expect(trends[1]).toContain('趋势B');
            expect(trends[2]).toContain('趋势C');
        });
        it('最多返回 5 条', () => {
            const trendsDir = join(dir, 'world_model');
            mkdirSync(trendsDir, { recursive: true });
            const items = Array.from({ length: 10 }, (_, i) => ({
                name: `趋势${i}`,
                momentum: i / 10,
                direction: 'rising',
            }));
            writeFileSync(join(trendsDir, 'trends.json'), JSON.stringify(items), 'utf-8');
            expect(provider.getTrends()).toHaveLength(5);
        });
        it('跳过缺少 momentum 或 name 的条目', () => {
            const trendsDir = join(dir, 'world_model');
            mkdirSync(trendsDir, { recursive: true });
            writeFileSync(join(trendsDir, 'trends.json'), JSON.stringify([
                { name: '有效趋势', momentum: 0.8, direction: 'rising' },
                { momentum: 0.5, direction: 'rising' },
                { name: '无效', direction: 'rising' },
                { name: '有效2', momentum: 0.3, direction: 'falling' },
            ]), 'utf-8');
            expect(provider.getTrends()).toHaveLength(2);
        });
        it('JSON 解析失败时返回空数组', () => {
            const trendsDir = join(dir, 'world_model');
            mkdirSync(trendsDir, { recursive: true });
            writeFileSync(join(trendsDir, 'trends.json'), 'invalid json', 'utf-8');
            expect(provider.getTrends()).toEqual([]);
        });
        it('trends.json 不是数组时返回空数组', () => {
            const trendsDir = join(dir, 'world_model');
            mkdirSync(trendsDir, { recursive: true });
            writeFileSync(join(trendsDir, 'trends.json'), '{"not":"array"}', 'utf-8');
            expect(provider.getTrends()).toEqual([]);
        });
    });
    describe('getInsights', () => {
        it('insights 目录不存在时返回空数组', () => {
            expect(provider.getInsights()).toEqual([]);
        });
        it('读取最近 3 条 insight JSON 文件', () => {
            const insightsDir = join(dir, 'insights');
            mkdirSync(insightsDir, { recursive: true });
            for (let i = 0; i < 5; i++) {
                writeFileSync(join(insightsDir, `2024-01-${String(i + 1).padStart(2, '0')}.json`), JSON.stringify({
                    topic: `洞察${i}`,
                    sections: [{ title: '发生了什么', content: `洞察${i}的内容描述` }],
                }), 'utf-8');
            }
            const insights = provider.getInsights();
            expect(insights).toHaveLength(3);
            expect(insights[0]).toContain('洞察4');
            expect(insights[1]).toContain('洞察3');
            expect(insights[2]).toContain('洞察2');
        });
        it('处理旧格式 payload.topic / payload.sections', () => {
            const insightsDir = join(dir, 'insights');
            mkdirSync(insightsDir, { recursive: true });
            writeFileSync(join(insightsDir, 'insight.json'), JSON.stringify({
                payload: { topic: '旧格式话题', sections: [{ title: '发生了什么', content: '旧格式内容' }] },
            }), 'utf-8');
            const insights = provider.getInsights();
            expect(insights).toHaveLength(1);
            expect(insights[0]).toContain('旧格式话题');
        });
    });
});
