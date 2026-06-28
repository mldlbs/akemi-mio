import { describe, it, expect, beforeEach, vi } from 'vitest';
vi.mock('../../logger/Logger', () => ({ log: vi.fn() }));
import { KnowledgeBaseService } from '../KnowledgeBaseService';
describe('KnowledgeBaseService', () => {
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
    it('空存储返回空数组', () => {
        expect(kbs.query()).toEqual([]);
    });
    it('没有 deps 时返回空', () => {
        const empty = new KnowledgeBaseService();
        expect(empty.query()).toEqual([]);
    });
    it('从 MemoryService 读取 entries', () => {
        mockMemoryService.getEntries.mockReturnValue([
            { content: '用户喜欢 TypeScript', confidence: 0.9, tier: 'ephemeral', updatedAt: Date.now() },
        ]);
        const results = kbs.query();
        expect(results.length).toBe(1);
        expect(results[0].source).toBe('memory');
        expect(results[0].content).toContain('TypeScript');
    });
    it('permanent 层优先级最高', () => {
        mockMemoryService.getEntries.mockReturnValue([
            { content: '重要事实', confidence: 0.9, tier: 'permanent', updatedAt: Date.now() },
            { content: '临时事实', confidence: 0.8, tier: 'ephemeral', updatedAt: Date.now() },
        ]);
        const results = kbs.query();
        expect(results[0].priority).toBe(100);
        expect(results[1].priority).toBe(40);
    });
    it('从 SummaryMemory 读取摘要', () => {
        mockSummary.getAll.mockReturnValue([
            { summary: '讨论了 React 优化方案', turnEnd: Date.now(), topics: [], decisions: [], keyEntities: [] },
        ]);
        const results = kbs.query();
        expect(results.length).toBe(1);
        expect(results[0].source).toBe('summary');
    });
    it('从 KnowledgeGraph 读取实体', () => {
        mockKG.getFormattedContext.mockReturnValue('- 用户喜欢编程\n- 项目使用 TypeScript\n');
        const results = kbs.query();
        expect(results.length).toBe(2);
        expect(results.every((r) => r.source === 'kg')).toBe(true);
    });
    it('从 EngineeringMemory 读取模式', () => {
        mockEngineering.getAll.mockReturnValue([{ content: '架构模式：微服务拆分', confidence: 0.7, updatedAt: Date.now() }]);
        const results = kbs.query();
        expect(results.length).toBe(1);
        expect(results[0].source).toBe('engineering');
    });
    it('从 DecisionStore 读取决策', () => {
        mockDecisionStore.query.mockReturnValue([
            { category: 'tool_select', choice: '选择了 read_file', confidence: 0.8, timestamp: Date.now() },
        ]);
        const results = kbs.query();
        expect(results.length).toBe(1);
        expect(results[0].source).toBe('decisions');
    });
    it('includeStores 过滤', () => {
        mockMemoryService.getEntries.mockReturnValue([
            { content: '用户喜欢 TypeScript', confidence: 0.9, tier: 'ephemeral', updatedAt: Date.now() },
        ]);
        mockSummary.getAll.mockReturnValue([{ summary: '讨论了 React', turnEnd: Date.now(), topics: [], decisions: [], keyEntities: [] }]);
        const onlyMemory = kbs.query({ includeStores: ['memory'] });
        expect(onlyMemory.length).toBe(1);
        expect(onlyMemory[0].source).toBe('memory');
    });
    it('minConfidence 过滤低置信度', () => {
        mockMemoryService.getEntries.mockReturnValue([
            { content: '高置信度', confidence: 0.9, tier: 'ephemeral', updatedAt: Date.now() },
            { content: '低置信度', confidence: 0.3, tier: 'ephemeral', updatedAt: Date.now() },
        ]);
        const results = kbs.query({ minConfidence: 0.5 });
        expect(results.length).toBe(1);
        expect(results[0].content).toContain('高置信度');
    });
    it('topK 限制结果数', () => {
        mockMemoryService.getEntries.mockReturnValue(Array.from({ length: 20 }, (_, i) => ({
            content: `事实 ${i}`,
            confidence: 0.8,
            tier: 'ephemeral',
            updatedAt: Date.now(),
        })));
        expect(kbs.query({ topK: 5 }).length).toBe(5);
        expect(kbs.query({ topK: 3 }).length).toBe(3);
    });
    it('精确去重合并相同内容', () => {
        mockMemoryService.getEntries.mockReturnValue([
            { content: '用户喜欢 TypeScript', confidence: 0.9, tier: 'ephemeral', updatedAt: Date.now() },
        ]);
        mockSummary.getAll.mockReturnValue([
            { summary: '用户喜欢 TypeScript', turnEnd: Date.now(), topics: [], decisions: [], keyEntities: [] },
        ]);
        const results = kbs.query();
        expect(results.length).toBe(1);
        expect(results[0].source).toBe('summary');
    });
    it('getFormattedContext 空时返回空字符串', () => {
        expect(kbs.getFormattedContext()).toBe('');
    });
    it('getFormattedContext 返回格式化块', () => {
        mockMemoryService.getEntries.mockReturnValue([
            { content: '用户喜欢 TypeScript', confidence: 0.9, tier: 'permanent', updatedAt: Date.now() },
        ]);
        const ctx = kbs.getFormattedContext();
        expect(ctx).toContain('【知识库】');
        expect(ctx).toContain('TypeScript');
    });
    it('优先级排序：permanent > engineering > summary > memory > kg', () => {
        mockMemoryService.getEntries.mockReturnValue([
            { content: '临时记忆', confidence: 0.8, tier: 'ephemeral', updatedAt: Date.now() },
            { content: '永久记忆', confidence: 0.9, tier: 'permanent', updatedAt: Date.now() },
        ]);
        mockSummary.getAll.mockReturnValue([{ summary: '摘要内容', turnEnd: Date.now(), topics: [], decisions: [], keyEntities: [] }]);
        mockEngineering.getAll.mockReturnValue([{ content: '工程模式', confidence: 0.7, updatedAt: Date.now() }]);
        const results = kbs.query();
        expect(results[0].priority).toBe(100);
        expect(results[1].priority).toBe(70);
        expect(results[2].priority).toBe(60);
        expect(results[3].priority).toBe(40);
    });
    it('所有 5 个存储同时返回结果', () => {
        mockMemoryService.getEntries.mockReturnValue([{ content: '记忆内容', confidence: 0.8, tier: 'ephemeral', updatedAt: Date.now() }]);
        mockSummary.getAll.mockReturnValue([{ summary: '摘要', turnEnd: Date.now(), topics: [], decisions: [], keyEntities: [] }]);
        mockKG.getFormattedContext.mockReturnValue('- 知识图谱实体\n');
        mockEngineering.getAll.mockReturnValue([{ content: '工程模式', confidence: 0.7, updatedAt: Date.now() }]);
        mockDecisionStore.query.mockReturnValue([{ category: 'recovery', choice: '选择了恢复', confidence: 0.6, timestamp: Date.now() }]);
        const results = kbs.query();
        const sources = new Set(results.map((r) => r.source));
        expect(sources.has('memory')).toBe(true);
        expect(sources.has('summary')).toBe(true);
        expect(sources.has('kg')).toBe(true);
        expect(sources.has('engineering')).toBe(true);
        expect(sources.has('decisions')).toBe(true);
    });
});
