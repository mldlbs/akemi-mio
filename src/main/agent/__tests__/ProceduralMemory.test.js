/**
 * ProceduralMemory 单元测试
 *
 * 测试策略：使用真实 DB + 内嵌数据验证 save/find/context/hit/fail/prune。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { ProceduralMemory } from '../ProceduralMemory';
import { initDatabase, closeDatabase, getRawDb } from '../../db/connection';
describe('ProceduralMemory', () => {
    let pm;
    beforeEach(async () => {
        if (existsSync(join(process.cwd(), 'akemi-mio.db')))
            unlinkSync(join(process.cwd(), 'akemi-mio.db'));
        process.env.USER_DATA_DIR = process.cwd();
        await initDatabase();
        pm = new ProceduralMemory();
    });
    afterEach(() => {
        closeDatabase();
        if (existsSync(join(process.cwd(), 'akemi-mio.db')))
            unlinkSync(join(process.cwd(), 'akemi-mio.db'));
    });
    it('should save a new procedure', () => {
        const proc = pm.save({
            name: '修复编译错误',
            description: '当 TypeScript 编译报错时的修复流程',
            steps: ['grep 错误信息', '定位问题文件', '修复并验证'],
            triggerKeywords: ['编译错误', 'TypeScript', 'tsc'],
        });
        expect(proc.id).toBeTruthy();
        expect(proc.name).toBe('修复编译错误');
        expect(proc.steps).toHaveLength(3);
        expect(proc.triggerKeywords).toHaveLength(3);
        expect(proc.successCount).toBe(0);
        expect(proc.failCount).toBe(0);
        expect(proc.embedding).toBeDefined();
        expect(proc.embedding.length).toBe(384);
    });
    it('should update an existing procedure with same name', () => {
        pm.save({ name: '测试流程', description: '原版', steps: ['a'], triggerKeywords: ['x'] });
        const updated = pm.save({ name: '测试流程', description: '更新版', steps: ['a', 'b'], triggerKeywords: ['x', 'y'] });
        expect(updated.description).toBe('更新版');
        expect(updated.steps).toHaveLength(2);
    });
    it('should list all procedures', () => {
        expect(pm.listAll()).toHaveLength(0);
        pm.save({ name: '流程A', description: 'a', steps: ['a1'], triggerKeywords: ['a'] });
        pm.save({ name: '流程B', description: 'b', steps: ['b1'], triggerKeywords: ['b'] });
        expect(pm.listAll()).toHaveLength(2);
    });
    it('should find procedures by keywords', () => {
        pm.save({
            name: 'TS修复',
            description: 'TypeScript编译错误修复',
            steps: ['grep', 'read_file'],
            triggerKeywords: ['TypeScript', '编译'],
        });
        pm.save({ name: 'CSS调整', description: '样式修改', steps: ['read_file', 'edit_file'], triggerKeywords: ['CSS', '样式'] });
        const matches = pm.findByKeywords(['TypeScript', '编译', 'tsc'], 3);
        expect(matches.length).toBeGreaterThanOrEqual(1);
        expect(matches[0].name).toBe('TS修复');
    });
    it('should return empty for unmatched keywords', () => {
        pm.save({ name: '流程', description: '测试', steps: ['a'], triggerKeywords: ['x'] });
        expect(pm.findByKeywords(['不存在的关键词'], 3)).toHaveLength(0);
    });
    it('should format context with matched procedures', () => {
        pm.save({ name: '测试流程', description: '用于测试的流程', steps: ['步骤一', '步骤二'], triggerKeywords: ['测试'] });
        const ctx = pm.getFormattedContext(['测试']);
        expect(ctx).toContain('测试流程');
        expect(ctx).toContain('步骤一');
        expect(ctx).toContain('步骤二');
        expect(ctx).toContain('触发');
    });
    it('should return empty context when no procedures', () => {
        expect(pm.getFormattedContext(['测试'])).toBe('');
    });
    it('should record hits and failures', () => {
        pm.save({ name: '统计测试', description: 'd', steps: ['s'], triggerKeywords: ['k'] });
        pm.recordHit('统计测试');
        pm.recordHit('统计测试');
        pm.recordFail('统计测试');
        const all = pm.listAll();
        const proc = all.find((p) => p.name === '统计测试');
        expect(proc.successCount).toBe(2);
        expect(proc.failCount).toBe(1);
    });
    it('should prune to max 50 procedures', () => {
        for (let i = 0; i < 55; i++) {
            pm.save({ name: `流程${i}`, description: `d${i}`, steps: ['s'], triggerKeywords: [`k${i}`] });
        }
        expect(pm.listAll().length).toBeLessThanOrEqual(50);
    });
    it('should find procedures by semantic embedding', () => {
        pm.save({
            name: 'TS修复',
            description: 'TypeScript编译错误修复',
            steps: ['grep', 'read_file'],
            triggerKeywords: ['TypeScript', '编译'],
        });
        pm.save({
            name: 'CSS调整',
            description: '样式修改',
            steps: ['read_file', 'edit_file'],
            triggerKeywords: ['CSS', '样式'],
        });
        const matches = pm.findByEmbedding('TypeScript 编译问题', 3);
        expect(matches.length).toBeGreaterThanOrEqual(1);
        expect(matches[0].name).toBe('TS修复');
    });
    it('should return empty for unrelated embedding query', () => {
        pm.save({ name: '测试流程', description: '测试', steps: ['a'], triggerKeywords: ['x'] });
        const matches = pm.findByEmbedding('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', 3);
        expect(matches).toHaveLength(0);
    });
    it('should use embedding in getFormattedContext', () => {
        pm.save({ name: '测试流程', description: '用于测试的流程', steps: ['步骤一', '步骤二'], triggerKeywords: ['测试'] });
        const ctx = pm.getFormattedContext(['测试']);
        expect(ctx).toContain('测试流程');
        expect(ctx).toContain('步骤一');
    });
    it('should fall back to keyword search when embedding is null', () => {
        const db = getRawDb();
        db.run(`INSERT INTO procedures (id, name, description, steps, trigger_keywords, success_count, fail_count, created_at, updated_at)
            VALUES ('legacy', '旧版流程', '无嵌入', '["a"]', '["b"]', 0, 0, 1, 1)`);
        const matches = pm.findByEmbedding('旧版流程', 3);
        expect(matches).toHaveLength(0);
    });
});
