import { describe, it, expect, beforeEach, vi } from 'vitest';
vi.mock('../../logger/Logger', () => ({ log: vi.fn() }));
import { KnowledgeBaseService } from '../KnowledgeBaseService';
describe('KnowledgeBaseService 压力测试', () => {
    let kbs;
    let mockSummary;
    let mockKG;
    let mockEngineering;
    let mockDecisionStore;
    let mockMemoryService;
    let mockUnifiedQuery;
    beforeEach(() => {
        mockSummary = { getAll: vi.fn(() => []) };
        mockKG = { getFormattedContext: vi.fn(() => '') };
        mockEngineering = { getAll: vi.fn(() => []) };
        mockDecisionStore = { query: vi.fn(() => []) };
        mockMemoryService = {
            getEntries: vi.fn(() => []),
            summary: mockSummary,
            knowledgeGraph: mockKG,
            engineering: mockEngineering,
            decisionStore: mockDecisionStore,
        };
        mockUnifiedQuery = { query: vi.fn(() => []), register: vi.fn() };
        kbs = new KnowledgeBaseService();
        kbs.setDeps({ memoryService: mockMemoryService, unifiedQuery: mockUnifiedQuery });
    });
    it('500 条输入，query 返回去重前 15 条', () => {
        const entries = Array.from({ length: 500 }, (_, i) => ({
            content: `事实 ${i % 100}`,
            confidence: 0.5 + (i % 5) * 0.1,
            tier: 'ephemeral',
            updatedAt: Date.now(),
        }));
        mockMemoryService.getEntries.mockReturnValue(entries);
        const results = kbs.query({ topK: 15 });
        expect(results.length).toBeLessThanOrEqual(15);
        expect(results.length).toBeGreaterThan(0);
        const uniqueKeys = new Set(results.map((r) => r.dedupKey));
        expect(uniqueKeys.size).toBe(results.length);
    });
    it('200 次 query 调用不崩溃', () => {
        mockMemoryService.getEntries.mockReturnValue(Array.from({ length: 50 }, (_, i) => ({
            content: `事实 ${i}`,
            confidence: 0.7,
            tier: 'ephemeral',
            updatedAt: Date.now(),
        })));
        for (let i = 0; i < 200; i++) {
            const results = kbs.query({ topK: 10 });
            expect(results.length).toBeLessThanOrEqual(10);
        }
    });
});
