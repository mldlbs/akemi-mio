import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryService } from '../memory/MemoryService';
import { initDatabase, closeDatabase, getRawDb } from '../db/connection';
vi.mock('electron', () => ({
    app: {
        getAppPath: () => process.cwd(),
        getPath: () => process.cwd() + '/test-user-data',
    },
}));
beforeEach(async () => {
    await initDatabase();
    const db = getRawDb();
    db.run('DELETE FROM memories');
    db.run('DELETE FROM memory_summaries');
    db.run('DELETE FROM memory_vectors');
});
afterEach(() => {
    closeDatabase();
});
describe('MemoryService', () => {
    it('loads with empty store', () => {
        const mem = new MemoryService();
        expect(mem.getEntries()).toEqual([]);
        expect(mem.getInteractionCount()).toBe(0);
        mem.shutdown();
    });
    it('stores and retrieves entries', () => {
        const mem = new MemoryService();
        mem.addFact('用户喜欢编程', 0.8);
        mem.addEntry('interaction', '聊了Node.js', 0.7);
        const entries = mem.getEntries();
        expect(entries.length).toBe(2);
        const fact = entries.find((e) => e.type === 'user_fact');
        expect(fact?.content).toBe('用户喜欢编程');
        expect(fact?.confidence).toBe(0.8);
        mem.shutdown();
    });
    it('deduplicates identical entries', () => {
        const mem = new MemoryService();
        mem.addFact('用户喜欢编程', 0.7);
        mem.addFact('用户喜欢编程', 0.9);
        const entries = mem.getEntries().filter((e) => e.type === 'user_fact');
        expect(entries.length).toBe(1);
        expect(entries[0].confidence).toBe(0.9); // higher confidence preserved
        mem.shutdown();
    });
    it('rejects low confidence entries', () => {
        const mem = new MemoryService();
        mem.addFact('不确定的信息', 0.3);
        expect(mem.getEntries().length).toBe(0);
        mem.shutdown();
    });
    it('prunes entries beyond MAX_ENTRIES', () => {
        const mem = new MemoryService();
        for (let i = 0; i < 60; i++) {
            mem.addFact(`记忆条目${i}`, 0.5 + i / 120);
        }
        // 临时层上限 50
        expect(mem.getEntries().length).toBeLessThanOrEqual(50);
        mem.shutdown();
    });
    it('flushes to database and can be reloaded', () => {
        const mem = new MemoryService();
        mem.addFact('持久化的记忆', 0.8);
        mem.flush();
        // Verify data is in SQLite
        const db = getRawDb();
        const stmt = db.prepare('SELECT * FROM memories WHERE content = ?');
        stmt.bind(['持久化的记忆']);
        expect(stmt.step()).toBe(true);
        const row = stmt.getAsObject();
        expect(row.content).toBe('持久化的记忆');
        expect(row.tier).toBe('ephemeral'); // 初始入临时层
        stmt.free();
        mem.shutdown();
    });
    it('getFormattedContext includes facts and interactions', () => {
        const mem = new MemoryService();
        mem.addFact('用户喜欢编程', 0.8);
        mem.addEntry('interaction', '聊了Node.js', 0.7);
        const ctx = mem.getFormattedContext();
        // 临时层事实显示在"记得以下关于主人的事"下
        expect(ctx).toContain('用户喜欢编程');
        expect(ctx).toContain('聊了Node.js');
        mem.shutdown();
    });
    it('clear wipes all entries', () => {
        const mem = new MemoryService();
        mem.addFact('测试记忆', 0.8);
        expect(mem.getEntries().length).toBe(1);
        mem.clear();
        expect(mem.getEntries().length).toBe(0);
        mem.shutdown();
    });
});
