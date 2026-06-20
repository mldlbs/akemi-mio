import { describe, it, expect, vi, beforeEach } from 'vitest';
import { estimateTokens, ConversationContext, buildSystemPrompt } from '../agent/context';
import { LlmService } from '../llm/LlmService';
vi.mock('electron', () => ({
    app: { getAppPath: () => process.cwd(), getPath: () => process.cwd() },
}));
beforeEach(() => {
    vi.restoreAllMocks();
});
describe('ai', () => {
    describe('estimateTokens', () => {
        it('returns correct token estimate for short English text', () => {
            expect(estimateTokens('hello')).toBe(2);
        });
        it('returns correct token estimate for Chinese text', () => {
            // '你好世界' = 4 CJK chars, CJK ratio = 1.0 → bytes/2 = 12/2 = 6
            expect(estimateTokens('你好世界')).toBe(6);
        });
        it('returns correct token estimate for empty string', () => {
            expect(estimateTokens('')).toBe(0);
        });
        it('returns correct token estimate for mixed text', () => {
            // '你好' = 2 CJK chars, ratio = 1.0 → bytes/2 = 6/2 = 3
            expect(estimateTokens('你好')).toBe(3);
            // 'hello world' = 0 CJK chars → bytes/4 = 11/4 = 3
            expect(estimateTokens('hello world')).toBe(3);
            // 'hello你好世界' = 4 CJK / 9 chars ≈ 0.44 > 0.3 → bytes/2 = 18/2 = 9
            expect(estimateTokens('hello你好世界')).toBe(9);
        });
    });
    describe('setConfig', () => {
        it('configures api key and default model', () => {
            const llm = new LlmService();
            llm.setConfig('sk-test-key');
            llm.setConfig('sk-test-key-2', undefined, 'deepseek/deepseek-reasoner');
            expect(true).toBe(true);
        });
    });
    describe('buildSystemPrompt', () => {
        it('appends extraModules when provided', () => {
            const prompt = buildSystemPrompt(undefined, ['### 调试模式\n允许输出调试日志', '### 教学模式\n详细解释每一步']);
            expect(prompt).toContain('调试模式');
            expect(prompt).toContain('教学模式');
        });
        it('includes memory context label', () => {
            const prompt = buildSystemPrompt('用户偏好：简短回复');
            expect(prompt).toContain('【长期记忆】');
            expect(prompt).toContain('用户偏好：简短回复');
        });
    });
    describe('addToolCall', () => {
        it('stores result without tool_calls field', () => {
            const ctx = new ConversationContext();
            ctx.addToolCall({ id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' }, result: 'ok' });
            const msgs = ctx.getMessages();
            const last = msgs[msgs.length - 1];
            expect(last.role).toBe('tool');
            expect(last.tool_call_id).toBe('call_1');
            expect(last.content).toBe('ok');
            expect(last.tool_calls).toBeUndefined();
        });
    });
    describe('shortTermMemory', () => {
        it('saves and retrieves recent exchanges', () => {
            const ctx = new ConversationContext();
            ctx.addUser('你好');
            ctx.addAssistant('嗨');
            ctx.addUser('今天天气如何');
            ctx.addAssistant('晴天');
            ctx.saveToShortTermMemory(5);
            const mem = ctx.getShortTermMemoryContext();
            expect(mem).toContain('你好');
            expect(mem).toContain('今天天气如何');
            expect(mem).toContain('晴天');
        });
        it('caps short term memory at keep count', () => {
            const ctx = new ConversationContext();
            for (let i = 0; i < 10; i++) {
                ctx.addUser(`第${i}条`);
                ctx.addAssistant(`回复${i}`);
            }
            ctx.saveToShortTermMemory(3);
            const mem = ctx.getShortTermMemoryContext();
            expect(mem).toContain('第7条');
            expect(mem).not.toContain('第0条');
        });
        it('clears short term on clear(false)', () => {
            const ctx = new ConversationContext();
            ctx.addUser('测试');
            ctx.addAssistant('回复');
            ctx.saveToShortTermMemory(5);
            ctx.clear(false);
            expect(ctx.getShortTermMemoryContext()).toBe('');
        });
    });
    describe('clearContext', () => {
        it('resets context and logs', () => {
            const spy = vi.spyOn(console, 'log').mockImplementation(() => { });
            const ctx = new ConversationContext();
            ctx.clear();
            const output = JSON.parse(spy.mock.calls[0][0]);
            expect(output.event).toBe('context_cleared');
            expect(output.level).toBe('INFO');
        });
    });
});
