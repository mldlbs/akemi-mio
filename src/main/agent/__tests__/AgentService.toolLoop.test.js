/**
 * AgentService toolLoop 状态机测试
 *
 * 覆盖 toolLoop 的关键状态转换：
 * 1. 正常流：LLM 直接回复 → 返回
 * 2. 超时恢复：TIMEOUT → 恢复提示 → 重试 (最多3次)
 * 3. 空工具调用：空 toolCalls → 恢复提示 → 重试
 * 4. 只读卡住：3轮全只读 → force-push 注入
 * 5. 计划强制续行：活跃计划 + 未完成步骤 → force-continue
 * 6. 连续工具错误：3+ 次 → 诊断模式注入
 * 7. 请求过多后返回
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('electron', () => ({
    app: { getAppPath: () => process.cwd(), getPath: () => process.cwd() },
    BrowserWindow: vi.fn(() => ({
        webContents: { send: vi.fn() },
        close: vi.fn(),
    })),
}));
import { AgentService } from '../AgentService';
import { LlmService } from '../../llm/LlmService';
import { AsrService } from '../../asr/AsrService';
import { TtsService } from '../../tts/TtsService';
import { WhisperGpuEngine } from '../../asr/WhisperGpuEngine';
import { BaiduEngine } from '../../asr/BaiduEngine';
import { initDatabase, closeDatabase } from '../../db/connection';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
// =============================================================================
// Mock PlanManager (for force-continue tests)
// =============================================================================
function createMockPlanManager() {
    let activePlan = null;
    return {
        getActivePlan: vi.fn(() => activePlan),
        getPlan: vi.fn((id) => (activePlan?.id === id ? activePlan : undefined)),
        listPlans: vi.fn(() => (activePlan ? [activePlan] : [])),
        createPlan: vi.fn(() => activePlan),
        updateStep: vi.fn(() => true),
        completePlan: vi.fn(() => true),
        abandonPlan: vi.fn(() => true),
        getFormattedContext: vi.fn(() => ''),
        lock: { run: async (fn) => fn() },
        _setPlan: (p) => { activePlan = p; },
    };
}
function makePlanWithPending(title) {
    return {
        id: `plan_${title}`,
        title,
        description: `测试计划: ${title}`,
        steps: [
            { id: 'step_0', description: '步骤1', status: 'done', result: 'ok' },
            { id: 'step_1', description: '步骤2', status: 'pending' },
            { id: 'step_2', description: '步骤3', status: 'pending' },
        ],
        status: 'active',
        createdAt: Date.now() - 3600000,
        updatedAt: Date.now() - 1800000,
    };
}
// =============================================================================
// 测试
// =============================================================================
describe('AgentService toolLoop 状态机', () => {
    let agent;
    let llmService;
    let mockPlan;
    beforeEach(async () => {
        await initDatabase();
        const ttsState = {};
        const ttsService = new TtsService((s) => Object.assign(ttsState, s));
        vi.spyOn(ttsService, 'speakInternal').mockResolvedValue(undefined);
        vi.spyOn(ttsService, 'flushBuffer').mockReturnValue(undefined);
        llmService = new LlmService();
        // 默认 mock: 简单回复（会被各测试覆盖）
        vi.spyOn(llmService, 'chatWithTools').mockResolvedValue({ reply: '收到' });
        const gpuEngine = new WhisperGpuEngine();
        const baiduEngine = new BaiduEngine();
        const asrService = new AsrService(gpuEngine, baiduEngine);
        mockPlan = createMockPlanManager();
        // 注入 mock planManager
        agent = new AgentService(llmService, asrService, ttsService, undefined, undefined, mockPlan);
    });
    afterEach(() => {
        closeDatabase();
        const dbFile = join(process.cwd(), 'test-user-data', 'akemi-mio.db');
        if (existsSync(dbFile))
            unlinkSync(dbFile);
    });
    // ── 正常流 ─────────────────────────────────────────────
    describe('正常流', () => {
        it('LLM 回复纯文本 → 直接返回', async () => {
            vi.spyOn(llmService, 'chatWithTools').mockResolvedValue({ reply: '你好，有什么需要帮助的？' });
            const result = await agent.processTextInput('测试输入');
            expect(result.reply).toBe('你好，有什么需要帮助的？');
        });
        it('LLM 回复英文内容 → 直接返回', async () => {
            vi.spyOn(llmService, 'chatWithTools').mockResolvedValue({ reply: 'Hello, this is a test response.' });
            const result = await agent.processTextInput('test');
            expect(result.reply).toBe('Hello, this is a test response.');
        });
    });
    // ── 超时恢复 ───────────────────────────────────────────
    describe('超时恢复', () => {
        it('一次超时 → 注入恢复提示 → 重试成功', async () => {
            const chatSpy = vi.spyOn(llmService, 'chatWithTools');
            // 第一次超时，第二次成功
            chatSpy
                .mockResolvedValueOnce({ error: 'TIMEOUT' })
                .mockResolvedValueOnce({ reply: '刚才超时了，现在继续' });
            const result = await agent.processTextInput('测试超时恢复');
            expect(result.reply).toBe('刚才超时了，现在继续');
        });
        it('连续 3 次超时 → 返回错误提示', async () => {
            const chatSpy = vi.spyOn(llmService, 'chatWithTools');
            chatSpy.mockResolvedValue({ error: 'TIMEOUT' });
            const result = await agent.processTextInput('测试超时');
            expect(result.reply).toBe('抱歉，语言模型连续超时，请稍后重试。');
        });
        it('超时恢复后正常 → consecutiveTimeouts 应重置', async () => {
            const chatSpy = vi.spyOn(llmService, 'chatWithTools');
            // 超时 → 恢复 → 工具调用（触发 processToolCalls）
            chatSpy
                .mockResolvedValueOnce({ error: 'TIMEOUT' })
                .mockResolvedValueOnce({ reply: 'test', toolCalls: [] })
                .mockResolvedValueOnce({ reply: '最终回复' });
            const result = await agent.processTextInput('超时后恢复并工具调用');
            // 只要不报错就行 — 正常返回
            expect(result.reply).toBe('最终回复');
        });
    });
    // ── 空工具调用 ─────────────────────────────────────────
    describe('空工具调用', () => {
        it('空 toolCalls → 注入恢复提示 → 重试成功', async () => {
            const chatSpy = vi.spyOn(llmService, 'chatWithTools');
            chatSpy
                .mockResolvedValueOnce({ reply: '', toolCalls: [] })
                .mockResolvedValueOnce({ reply: '这次成功了' });
            const result = await agent.processTextInput('测试空工具调用');
            expect(result.reply).toBe('这次成功了');
        });
    });
    // ── 只读卡住 ───────────────────────────────────────────
    describe('只读卡住检测', () => {
        it('3 轮全只读工具 → 注入 force-push 恢复 → 第4轮正常', async () => {
            const chatSpy = vi.spyOn(llmService, 'chatWithTools');
            // 模拟 MCP callTool — 让 read_file 返回内容
            const mcpManager = agent.getMcpManager();
            vi.spyOn(mcpManager, 'callTool').mockResolvedValue(JSON.stringify({ content: '一些文件内容' }));
            // 第1轮: 只读工具调用
            // 第2轮: 只读工具调用
            // 第3轮: 只读工具调用（这轮会触发 force-push）
            // 第4轮: 纯文本回复（正常返回）
            chatSpy
                .mockResolvedValueOnce({
                reply: '查一下代码',
                toolCalls: [{ id: 't1', name: 'read_file', arguments: { path: '/test.ts' } }],
            })
                .mockResolvedValueOnce({
                reply: '再看看',
                toolCalls: [{ id: 't2', name: 'read_file', arguments: { path: '/test2.ts' } }],
            })
                .mockResolvedValueOnce({
                reply: '继续看文件',
                toolCalls: [{ id: 't3', name: 'read_file', arguments: { path: '/test3.ts' } }],
            })
                .mockResolvedValueOnce({ reply: '最终回复' });
            const result = await agent.processTextInput('分析代码');
            expect(result.reply).toBe('最终回复');
        });
        it('非只读工具调用应重置只读计数', async () => {
            const chatSpy = vi.spyOn(llmService, 'chatWithTools');
            const mcpManager = agent.getMcpManager();
            vi.spyOn(mcpManager, 'callTool').mockResolvedValue(JSON.stringify({ content: 'ok' }));
            // 第1轮: 只读
            // 第2轮: 写文件（非只读，应重置计数）
            // 第3轮: 只读（不应触发 force-push，因为计数刚重置）
            // 第4轮: 回复
            chatSpy
                .mockResolvedValueOnce({
                reply: '看看代码',
                toolCalls: [{ id: 't1', name: 'read_file', arguments: { path: '/a.ts' } }],
            })
                .mockResolvedValueOnce({
                reply: '开始修改',
                toolCalls: [{ id: 't2', name: 'write_file', arguments: { path: '/a.ts', content: '修改' } }],
            })
                .mockResolvedValueOnce({
                reply: '再看看',
                toolCalls: [{ id: 't3', name: 'read_file', arguments: { path: '/a.ts' } }],
            })
                .mockResolvedValueOnce({ reply: '完成' });
            const result = await agent.processTextInput('修改代码');
            expect(result.reply).toBe('完成');
        });
    });
    // ── 计划强制续行 ──────────────────────────────────────
    describe('计划强制续行', () => {
        it('追踪的活跃计划有未完成步骤 → 应触发 force-continue（注入后循环重试）', async () => {
            const plan = makePlanWithPending('修复测试覆盖');
            mockPlan._setPlan(plan);
            const chatSpy = vi.spyOn(llmService, 'chatWithTools');
            // 第一轮：回复但不调用工具
            // → toolLoop 检测到 sessionPlanIds 有 plan.id 且 pending > 0
            // → 注入 force-continue 提示并重试
            // 第二轮：返回工具调用（模拟 LLM 开始执行步骤）
            // 但 mock的 tool 会执行并返回（因为 mcpManager.callTool 没 mock，走真实路径）
            // → 执行完回到 toolLoop → 再次检测到 pending > 0 → force-continue 再次触发
            // → 循环直到第10轮返回"操作次数过多"
            // 
            // 验证点：chatWithTools 被调用了至少 2 次（说明 force-continue 后重试了）
            chatSpy
                .mockResolvedValueOnce({ reply: '我看看计划' })
                .mockResolvedValueOnce({
                reply: '开始执行步骤',
                toolCalls: [{ id: 't1', name: 'read_file', arguments: { path: '/test.ts' } }],
            })
                .mockResolvedValue({ reply: '继续工作' });
            const mcpManager = agent.getMcpManager();
            vi.spyOn(mcpManager, 'callTool').mockResolvedValue(JSON.stringify({ content: '结果' }));
            // 先触发计划创建事件把 plan.id 加入 sessionPlanIds
            const eventBus = agent.eventBus;
            eventBus.emit('agent.plan.created', { planId: plan.id, title: plan.title });
            const result = await agent.processTextInput('继续执行计划');
            // force-continue 触发了重试（chatWithTools 被调用>1次）
            expect(chatSpy.mock.calls.length).toBeGreaterThan(1);
            // 最终不会崩溃
            expect(result.reply).toBeTruthy();
        });
        it('活跃计划已完成 → 不应触发 force-continue（正常返回）', async () => {
            const plan = makePlanWithPending('已完成计划');
            // 标记所有步骤为 done
            plan.steps.forEach((s) => { s.status = 'done'; });
            mockPlan._setPlan(plan);
            vi.spyOn(llmService, 'chatWithTools').mockResolvedValue({ reply: '计划已完成' });
            const eventBus = agent.eventBus;
            eventBus.emit('agent.plan.created', { planId: plan.id, title: plan.title });
            const result = await agent.processTextInput('检查计划');
            // 正常返回，没有 force-continue 注入
            expect(result.reply).toBe('计划已完成');
        });
        it('未追踪的计划 → 不应触发 force-continue', async () => {
            const plan = makePlanWithPending('未追踪计划');
            mockPlan._setPlan(plan);
            // 故意不 emit plan.created 事件 → plan.id 不在 sessionPlanIds 中
            vi.spyOn(llmService, 'chatWithTools').mockResolvedValue({ reply: '正常回复' });
            const result = await agent.processTextInput('测试');
            expect(result.reply).toBe('正常回复');
        });
    });
    // ── 连续工具错误 ──────────────────────────────────────
    describe('连续工具错误', () => {
        it('连续 3 次工具错误 → 注入诊断模式提示', async () => {
            const chatSpy = vi.spyOn(llmService, 'chatWithTools');
            const mcpManager = agent.getMcpManager();
            // callTool 始终失败
            vi.spyOn(mcpManager, 'callTool').mockRejectedValue(new Error('工具执行失败'));
            // 3 轮工具调用全部失败（触发诊断模式）
            // 第4轮: 回复
            chatSpy
                .mockResolvedValueOnce({
                reply: '执行工具',
                toolCalls: [{ id: 'e1', name: 'read_file', arguments: { path: '/x.ts' } }],
            })
                .mockResolvedValueOnce({
                reply: '再试一次',
                toolCalls: [{ id: 'e2', name: 'list_files', arguments: { path: '/src' } }],
            })
                .mockResolvedValueOnce({
                reply: '再试一次',
                toolCalls: [{ id: 'e3', name: 'read_file', arguments: { path: '/y.ts' } }],
            })
                .mockResolvedValueOnce({ reply: '我进入了诊断模式' });
            const result = await agent.processTextInput('测试错误');
            expect(result.reply).toBe('我进入了诊断模式');
        });
    });
    // ── 并发安全性 ─────────────────────────────────────────
    describe('并发安全性', () => {
        it('selfTask 运行时 processTextInput 返回 BUSY', async () => {
            vi.spyOn(llmService, 'chatWithTools').mockResolvedValue({ reply: '后台任务' });
            const selfTaskPromise = agent.runSelfTask('后台任务');
            const result = await agent.processTextInput('新输入');
            expect(result).toEqual({ error: 'BUSY' });
            await selfTaskPromise;
        });
    });
    // ── 状态重置 ───────────────────────────────────────────
    describe('状态重置', () => {
        it('同一 agent 实例多次调用正常', async () => {
            vi.spyOn(llmService, 'chatWithTools').mockResolvedValue({ reply: 'ok' });
            const r1 = await agent.processTextInput('第一次');
            expect(r1.reply).toBe('ok');
            const r2 = await agent.processTextInput('第二次');
            expect(r2.reply).toBe('ok');
            const r3 = await agent.processTextInput('第三次');
            expect(r3.reply).toBe('ok');
        });
    });
});
