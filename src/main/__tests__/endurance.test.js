import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDatabase, closeDatabase } from '../db/connection';
import { existsSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
vi.mock('../../logger/Logger', () => ({ log: vi.fn() }));
import { eventBus as defaultBus } from '../core/EventBus';
import { DecisionStore } from '../memory/DecisionStore';
import { EventAuditor } from '../audit/EventAuditor';
describe('长时间耐力测试', () => {
    let bus;
    beforeEach(async () => {
        const dbPath = join(process.cwd(), 'akemi-mio.db');
        if (existsSync(dbPath))
            unlinkSync(dbPath);
        process.env.USER_DATA_DIR = process.cwd();
        await initDatabase();
        bus = defaultBus;
        bus.removeAll();
    });
    afterEach(() => {
        bus.removeAll();
        closeDatabase();
        const dbPath = join(process.cwd(), 'akemi-mio.db');
        if (existsSync(dbPath))
            unlinkSync(dbPath);
    });
    it('1000 轮 Agent 交互耐力', () => {
        const decisionStore = new DecisionStore();
        const auditor = new EventAuditor(undefined, bus);
        auditor.start();
        const initialSubs = bus.listenerCount('agent.tool.invoked');
        const dbPath = join(process.cwd(), 'akemi-mio.db');
        const sizeBefore = existsSync(dbPath) ? statSync(dbPath).size : 0;
        for (let i = 0; i < 1000; i++) {
            bus.emit('agent.input.received', { requestId: `endurance_${i}`, text: `用户输入 ${i}` });
            bus.emit('agent.tool.invoked', { requestId: `endurance_${i}`, tool: 'read_file', args: { path: `/test/${i}` } });
            decisionStore.record({
                agentId: 'endurance_test',
                category: 'tool_select',
                context: `轮次 ${i}`,
                choice: '选择了 read_file',
                outcome: 'success',
            });
            bus.emit('agent.tool.completed', { requestId: `endurance_${i}`, tool: 'read_file', result: 'ok' });
            bus.emit('agent.response.generated', { requestId: `endurance_${i}`, text: `响应 ${i}`, durationMs: 50 });
            if (i % 10 === 0) {
                bus.emit('agent.error', { requestId: `endurance_${i}`, error: 'timeout', step: 1 });
            }
        }
        auditor.flush();
        const subsAfter = bus.listenerCount('agent.tool.invoked');
        expect(subsAfter).toBeLessThanOrEqual(initialSubs + 1);
        const decisions = decisionStore.query({ limit: 999 });
        expect(decisions.length).toBeLessThanOrEqual(200);
        const sizeAfter = existsSync(dbPath) ? statSync(dbPath).size : 0;
        const growthPerRound = (sizeAfter - sizeBefore) / 1000;
        console.log(`DB growth per round: ${growthPerRound.toFixed(1)} bytes`);
        expect(growthPerRound).toBeLessThan(1024);
        auditor.stop();
    });
    it('100 轮 Evolution 循环不卡死', () => {
        const auditor = new EventAuditor(undefined, bus);
        auditor.start();
        for (let i = 0; i < 100; i++) {
            bus.emit('evolution.cycle.started', { round: i });
            bus.emit('agent.tool.invoked', { requestId: `ev_${i}`, tool: 'analyze_codebase', args: {} });
            bus.emit('agent.tool.completed', { requestId: `ev_${i}`, tool: 'analyze_codebase', result: 'done' });
            bus.emit('evolution.cycle.completed', { round: i, passed: i % 5 !== 0 });
        }
        auditor.flush();
        const stats = auditor.getStats();
        expect(stats.total).toBe(200); // 100 tool_invoked + 100 tool_completed
        auditor.stop();
    });
});
