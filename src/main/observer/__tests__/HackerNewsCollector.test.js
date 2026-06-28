import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HackerNewsCollector } from '../collectors/HackerNewsCollector';
const mockFetch = vi.fn();
function mockTopStories(ids) {
    mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(ids),
    });
}
function mockItem(story) {
    mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
            id: story.id ?? 1,
            type: story.type ?? 'story',
            title: story.title ?? 'Test Story',
            url: story.url,
            score: story.score ?? 100,
            by: story.by ?? 'testuser',
            time: story.time ?? Math.floor(Date.now() / 1000),
        }),
    });
}
function mockItemNull() {
    mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(null),
    });
}
describe('HackerNewsCollector', () => {
    let collector;
    beforeEach(() => {
        collector = new HackerNewsCollector();
        mockFetch.mockReset();
        global.fetch = mockFetch;
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });
    it('返回 name "hackernews" 和 1h interval', () => {
        expect(collector.name).toBe('hackernews');
        expect(collector.intervalMs).toBe(60 * 60 * 1000);
    });
    it('正常采集返回 observation 数组', async () => {
        const now = Math.floor(Date.now() / 1000);
        mockTopStories([101, 102]);
        mockItem({ id: 101, title: 'AI Breakthrough', score: 250, by: 'alice', time: now - 3600 });
        mockItem({ id: 102, title: 'Rust in Linux', score: 180, by: 'bob', time: now - 7200 });
        const obs = await collector.collect();
        expect(obs).toHaveLength(2);
        expect(obs[0].source).toBe('hackernews');
        expect(obs[0].content).toContain('AI Breakthrough');
        expect(obs[0].content).toContain('250 points');
        expect(obs[1].content).toContain('Rust in Linux');
    });
    it('去重：同一 URL 第二次采集不再出现', async () => {
        mockTopStories([1]);
        mockItem({ id: 1, title: 'Unique Story', url: 'https://example.com/1' });
        const first = await collector.collect();
        expect(first).toHaveLength(1);
        mockTopStories([1]);
        mockItem({ id: 1, title: 'Unique Story', url: 'https://example.com/1' });
        const second = await collector.collect();
        expect(second).toHaveLength(0);
    });
    it('过滤非 story 类型条目', async () => {
        const now = Math.floor(Date.now() / 1000);
        mockTopStories([1, 2]);
        mockItem({ id: 1, title: 'A real story', type: 'story', time: now });
        mockItem({ id: 2, title: 'A comment', type: 'comment', time: now });
        const obs = await collector.collect();
        expect(obs).toHaveLength(1);
        expect(obs[0].content).toContain('A real story');
    });
    it('过滤无标题条目', async () => {
        const now = Math.floor(Date.now() / 1000);
        mockTopStories([1]);
        // 无 title 的 item（title is not provided at all）
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ id: 1, type: 'story', time: now }),
        });
        const obs = await collector.collect();
        expect(obs).toHaveLength(0);
    });
    it('topstories API 非 200 时返回空数组', async () => {
        mockFetch.mockResolvedValueOnce({ ok: false, status: 429 });
        const obs = await collector.collect();
        expect(obs).toEqual([]);
    });
    it('网络异常时返回空数组', async () => {
        mockFetch.mockRejectedValueOnce(new Error('Network error'));
        const obs = await collector.collect();
        expect(obs).toEqual([]);
    });
    it('部分 item 为 null 时不影响其他条目', async () => {
        const now = Math.floor(Date.now() / 1000);
        mockTopStories([1, 2, 3]);
        mockItem({ id: 1, title: 'Good story', time: now });
        mockItemNull();
        mockItem({ id: 3, title: 'Another story', time: now });
        const obs = await collector.collect();
        expect(obs).toHaveLength(2);
    });
});
