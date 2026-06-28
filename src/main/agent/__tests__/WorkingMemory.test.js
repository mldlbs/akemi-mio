import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scratchpad, AttentionSet, WorkingMemory } from '../WorkingMemory';
// ─── Scratchpad ───
describe('Scratchpad', () => {
    let pad;
    beforeEach(() => {
        pad = new Scratchpad();
    });
    it('初始为空', () => {
        expect(pad.size).toBe(0);
    });
    it('add + size', () => {
        pad.add('observe', '看到文件 test.ts');
        expect(pad.size).toBe(1);
        pad.add('think', '需要修改');
        expect(pad.size).toBe(2);
    });
    it('flush 返回所有条目并清空', () => {
        pad.add('observe', '观察到 X');
        pad.add('think', '思考 Y');
        const entries = pad.flush();
        expect(entries).toHaveLength(2);
        expect(entries[0]).toMatchObject({ type: 'observe', content: '观察到 X' });
        expect(entries[0].timestamp).toBeGreaterThan(0);
        expect(entries[1]).toMatchObject({ type: 'think', content: '思考 Y' });
        expect(pad.size).toBe(0);
    });
    it('flushNew 只返回新条目', () => {
        pad.add('observe', '第一轮');
        const before = pad.size;
        pad.add('think', '后续');
        const entries = pad.flushNew(before);
        expect(entries).toHaveLength(1);
        expect(entries[0].content).toBe('后续');
        // 旧条目保留，新条目已消费
        expect(pad.size).toBe(before);
    });
    it('flushNew 没有新条目时返回空数组', () => {
        pad.add('observe', '只有一条');
        expect(pad.flushNew(1)).toEqual([]);
    });
    it('injectInto 空 pad 不注入', () => {
        const msgs = [{ role: 'system', content: 'sys' }];
        const count = pad.injectInto(msgs, 'system');
        expect(count).toBe(0);
        expect(msgs).toHaveLength(1);
    });
    it('injectInto 将条目渲染为一条消息', () => {
        pad.add('observe', '观察');
        pad.add('think', '思考');
        const msgs = [{ role: 'system', content: 'sys' }];
        const count = pad.injectInto(msgs, 'user');
        expect(count).toBe(2);
        expect(msgs).toHaveLength(2);
        expect(msgs[1].role).toBe('user');
        expect(msgs[1].content).toContain('[observe] 观察');
        expect(msgs[1].content).toContain('[think] 思考');
    });
    it('clear', () => {
        pad.add('observe', '数据');
        pad.clear();
        expect(pad.size).toBe(0);
    });
});
// ─── AttentionSet ───
describe('AttentionSet', () => {
    let attn;
    beforeEach(() => {
        vi.useFakeTimers();
        attn = new AttentionSet();
    });
    afterEach(() => {
        vi.useRealTimers();
    });
    it('add 新实体', () => {
        attn.add('test.ts', 'file', 0.8);
        const active = attn.getActive(0);
        expect(active).toHaveLength(1);
        expect(active[0].name).toBe('test.ts');
    });
    it('add 已有实体以高 relevance 为准', () => {
        attn.add('test.ts', 'file', 0.5);
        attn.add('test.ts', 'file', 1.0);
        const active = attn.getActive(0);
        expect(active[0].relevance).toBeCloseTo(1.0, 2);
    });
    it('extractFrom 提取文件路径', () => {
        attn.extractFrom('请修改 src/main/foo.ts');
        expect(attn.getActive(0).some((e) => e.name === 'src/main/foo.ts')).toBe(true);
    });
    it('extractFrom 提取引号概念', () => {
        attn.extractFrom('关注「性能优化」和"代码质量"');
        const names = attn.getActive(0).map((e) => e.name);
        expect(names).toContain('性能优化');
        expect(names).toContain('代码质量');
    });
    it('extractFrom 短文本不提取', () => {
        attn.extractFrom('ab');
        expect(attn.getActive(0)).toHaveLength(0);
    });
    it('getActive 按相关度降序排列', () => {
        attn.add('次要', 'concept', 0.3);
        attn.add('主要', 'concept', 1.0);
        const active = attn.getActive(0);
        expect(active[0].name).toBe('主要');
        expect(active[1].name).toBe('次要');
    });
    it('getActive 低于 threshold 的过滤掉', () => {
        attn.add('低相关', 'concept', 0.1);
        expect(attn.getActive(0.3)).toHaveLength(0);
    });
    it('getFormattedContext 有实体时返回格式化的字符串', () => {
        attn.add('test.ts', 'file', 1.0);
        const ctx = attn.getFormattedContext();
        expect(ctx).toContain('test.ts');
        expect(ctx).toContain('【当前关注】');
    });
    it('getFormattedContext 空时返回空字符串', () => {
        expect(attn.getFormattedContext()).toBe('');
    });
    it('tick 移除超过 30 分钟未提及的实体', () => {
        attn.add('old', 'concept', 1.0);
        vi.advanceTimersByTime(31 * 60 * 1000);
        attn.tick();
        expect(attn.getActive(0)).toHaveLength(0);
    });
    it('tick 保留 30 分钟内提及的实体', () => {
        attn.add('fresh', 'concept', 1.0);
        vi.advanceTimersByTime(20 * 60 * 1000);
        attn.tick();
        expect(attn.getActive(0)).toHaveLength(1);
    });
});
// ─── WorkingMemory ───
describe('WorkingMemory', () => {
    let wm;
    beforeEach(() => {
        vi.useFakeTimers();
        wm = new WorkingMemory('chat', '记忆: 用户喜欢编码', 2000);
    });
    afterEach(() => {
        vi.useRealTimers();
    });
    it('构造后包含子对象', () => {
        expect(wm.context).toBeDefined();
        expect(wm.scratchpad).toBeDefined();
        expect(wm.attention).toBeDefined();
        expect(wm.interactionCount).toBe(0);
    });
    it('addUser 添加消息、提取注意力、写入 scratchpad', () => {
        wm.addUser('修改 src/main/foo.ts 中的「性能」');
        expect(wm.getMessages()).toHaveLength(2); // system + user
        expect(wm.getMessages()[1].content).toBe('修改 src/main/foo.ts 中的「性能」');
        // scratchpad 写入 observation
        expect(wm.scratchpad.size).toBeGreaterThanOrEqual(1);
        // attention 已提取
        expect(wm.attention.getActive(0).length).toBeGreaterThanOrEqual(2);
    });
    it('addAssistant 添加助手回复', () => {
        wm.addUser('hi');
        wm.addAssistant('hello');
        const msgs = wm.getMessages();
        expect(msgs[2].role).toBe('assistant');
        expect(msgs[2].content).toBe('hello');
    });
    it('addAssistant 带 toolCalls 时加入 attention', () => {
        wm.addAssistant('处理中', [{ name: 'read_file' }]);
        const active = wm.attention.getActive(0);
        expect(active.some((e) => e.name === 'read_file')).toBe(true);
    });
    it('addToolResult 添加 tool 消息', () => {
        wm.addToolResult('call_1', '结果');
        const msgs = wm.getMessages();
        expect(msgs[1].role).toBe('tool');
        expect(msgs[1].content).toBe('结果');
    });
    it('injectScratchpad 将 scratchpad 注入消息数组', () => {
        wm.addUser('问题');
        const external = [{ role: 'system', content: 'sys' }];
        const count = wm.injectScratchpad(external);
        expect(count).toBeGreaterThanOrEqual(1);
        expect(external.length).toBeGreaterThanOrEqual(2);
    });
    it('tick 递增 interactionCount', () => {
        expect(wm.interactionCount).toBe(0);
        wm.tick();
        expect(wm.interactionCount).toBe(1);
    });
    it('tick 清空 scratchpad', () => {
        wm.addUser('测试');
        expect(wm.scratchpad.size).toBeGreaterThan(0);
        wm.tick();
        expect(wm.scratchpad.size).toBe(0);
    });
    it('tick 每 5 次保存短期记忆', () => {
        wm.addUser('一轮');
        wm.addAssistant('回复');
        // tick 5 次
        for (let i = 0; i < 5; i++) {
            wm.tick();
        }
        // short term memory 应有内容
        expect(wm.context.getShortTermMemoryContext()).not.toBe('');
    });
    it('tick 可附带 userText', () => {
        wm.tick('额外文本 src/main/test.ts');
        expect(wm.attention.getActive(0).some((e) => e.name === 'src/main/test.ts')).toBe(true);
    });
    it('refreshMemory 不清历史时只更新 system prompt', () => {
        wm.addUser('对话');
        wm.addAssistant('回复');
        const oldSystem = wm.getMessages()[0].content;
        wm.refreshMemory('新记忆');
        expect(wm.getMessages()[0].content).not.toBe(oldSystem);
        expect(wm.getMessages()).toHaveLength(3); // system + user + assistant
    });
    it('refreshMemory 清历史时创建全新 context', () => {
        wm.addUser('对话历史');
        wm.refreshMemory(undefined, undefined, undefined, undefined, true);
        expect(wm.getMessages()).toHaveLength(1); // 只有新的 system
        expect(wm.getMessages()[0].role).toBe('system');
    });
    it('getMessages 返回 context 消息', () => {
        wm.addUser('你好');
        const msgs = wm.getMessages();
        expect(msgs[0].role).toBe('system');
        expect(msgs[1].content).toBe('你好');
    });
    it('clear 清空但不保留短期记忆', () => {
        wm.addUser('你好');
        wm.addAssistant('嗨');
        wm.clear(false);
        expect(wm.scratchpad.size).toBe(0);
        expect(wm.attention.getActive(0)).toHaveLength(0);
        expect(wm.getMessages()).toHaveLength(1);
    });
    it('trimToTokenBudget 委托给 context', () => {
        wm.addUser('hello');
        wm.trimToTokenBudget(999999);
        expect(wm.getMessages()).toHaveLength(2);
    });
});
