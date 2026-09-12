import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SummaryMemory } from '@akemi-mio/intelligence/memory/SummaryMemory'
import { initDatabase, closeDatabase, getRawDb } from '@akemi-mio/core/db/connection'
import { useIsolatedTestDatabase } from '../../db/__tests__/testDatabase'

describe('SummaryMemory', () => {
  let sm: SummaryMemory
  let restoreTestDatabase: () => void

  beforeEach(async () => {
    restoreTestDatabase = useIsolatedTestDatabase()
    await initDatabase()
    sm = new SummaryMemory()
  })

  afterEach(() => {
    closeDatabase()
    restoreTestDatabase()
  })

  it('空数据库构造后 getAll 为空', () => {
    expect(sm.getAll()).toEqual([])
  })

  it('addSummary 添加条目', () => {
    sm.addSummary('用户问了天气', 100, 200)
    expect(sm.getAll()).toHaveLength(1)
    expect(sm.getRecent(1)).toEqual(['用户问了天气'])
  })

  it('addSummary 含 topics/decisions/entities', () => {
    sm.addSummary('开发对话', 1, 2, { topics: ['编码', 'bug'], decisions: ['修复方案A'], keyEntities: ['模块X'] })
    const full = sm.getRecentFull(1)
    expect(full[0].topics).toEqual(['编码', 'bug'])
    expect(full[0].decisions).toEqual(['修复方案A'])
    expect(full[0].keyEntities).toEqual(['模块X'])
  })

  it('超出 50 条时自动裁剪', () => {
    for (let i = 1; i <= 55; i++) sm.addSummary(`s${i}`, i, i)
    expect(sm.getAll()).toHaveLength(50)
    expect(sm.getRecent(1)[0]).toBe('s55')
  })

  it('getRecent 返回最后 N 条', () => {
    for (let i = 1; i <= 10; i++) sm.addSummary(`s${i}`, i, i)
    expect(sm.getRecent(3)).toEqual(['s8', 's9', 's10'])
  })

  it('getRecent 不足 limit 返回全部', () => {
    sm.addSummary('a', 1, 2)
    expect(sm.getRecent(5)).toHaveLength(1)
  })

  it('getRecentFull 返回完整 SummaryEntry', () => {
    sm.addSummary('test', 1, 2, { topics: ['t1'] })
    const full = sm.getRecentFull(1)
    expect(full[0].summary).toBe('test')
    expect(full[0].turnStart).toBe(1)
    expect(full[0].turnEnd).toBe(2)
    expect(full[0].id).toMatch(/^sum_\d+_\d+$/)
  })

  it('getAll 返回副本', () => {
    sm.addSummary('内容', 1, 2)
    const all = sm.getAll()
    all.pop()
    expect(sm.getAll()).toHaveLength(1)
  })

  it('flush 写入 DB', () => {
    sm.addSummary('要持久化', 1, 2)
    sm.flush()
    const sm2 = new SummaryMemory()
    expect(sm2.getRecent(1)).toEqual(['要持久化'])
  })

  it('flush 非 dirty 时跳过', () => {
    sm.flush()
  })

  it('parseJsonField null/undefined', () => {
    expect((sm as any).parseJsonField(null, [])).toEqual([])
    expect((sm as any).parseJsonField(undefined, 'def')).toBe('def')
  })

  it('parseJsonField Array 原样', () => {
    expect((sm as any).parseJsonField(['a'], [])).toEqual(['a'])
  })

  it('parseJsonField 有效 JSON', () => {
    expect((sm as any).parseJsonField('["x","y"]', [])).toEqual(['x', 'y'])
  })

  it('parseJsonField 无效字符串 wrap', () => {
    expect((sm as any).parseJsonField('not-json', 'fb')).toEqual(['not-json'])
  })

  it('DB 无 topics 列时自动 ALTER TABLE', () => {
    const db = getRawDb()
    db.run('ALTER TABLE memory_summaries RENAME TO memory_summaries_old')
    db.run(
      'CREATE TABLE IF NOT EXISTS memory_summaries (id TEXT PRIMARY KEY, summary TEXT NOT NULL, turn_start INTEGER NOT NULL, turn_end INTEGER NOT NULL, created_at INTEGER NOT NULL)',
    )
    const sm2 = new SummaryMemory()
    expect(() => sm2.addSummary('降级测试', 1, 2, { topics: ['topic'] })).not.toThrow()
    db.run('DROP TABLE IF EXISTS memory_summaries')
    db.run('ALTER TABLE memory_summaries_old RENAME TO memory_summaries')
  })

  it('DB 写入失败不抛异常', () => {
    const db = getRawDb()
    db.run('DROP TABLE memory_summaries')
    expect(() => sm.addSummary('失败', 1, 2)).not.toThrow()
    db.run(
      "CREATE TABLE IF NOT EXISTS memory_summaries (id TEXT PRIMARY KEY, summary TEXT NOT NULL, turn_start INTEGER NOT NULL, turn_end INTEGER NOT NULL, topics TEXT DEFAULT '[]', decisions TEXT DEFAULT '[]', key_entities TEXT DEFAULT '[]', created_at INTEGER NOT NULL)",
    )
  })
})
