import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { InsightStore } from '@akemi-mio/intelligence-insight/InsightStore'
import type { Insight } from '@akemi-mio/intelligence-insight/types'

function makeInsight(id: string, createdAt: number): Insight {
  return {
    id,
    detector: 'conflict',
    title: `t-${id}`,
    description: 'desc',
    evidence: ['e1'],
    score: 50,
    confidence: 0.5,
    createdAt,
  }
}

describe('InsightStore', () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'insight-store-'))
    filePath = join(dir, 'insights.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('文件不存在时返回空 store', () => {
    const store = new InsightStore(filePath)
    expect(store.getAll()).toEqual([])
    expect(store.count()).toBe(0)
  })

  it('损坏 JSON 时兜底为空且不抛错', () => {
    writeFileSync(filePath, '{not-json', 'utf-8')
    const store = new InsightStore(filePath)
    expect(store.getAll()).toEqual([])
    expect(store.count()).toBe(0)
  })

  it('insights 非数组时兜底为空（L9）', () => {
    writeFileSync(filePath, JSON.stringify({ version: 1, insights: 'oops', reportedIds: [] }), 'utf-8')
    const store = new InsightStore(filePath)
    expect(store.getAll()).toEqual([])
    expect(store.count()).toBe(0)
  })

  it('非法元素被过滤、合法元素保留（L9）', () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        insights: [null, 42, { title: 'no-id' }, makeInsight('ok', 100)],
        reportedIds: ['ok', 42, null],
      }),
      'utf-8',
    )
    const store = new InsightStore(filePath)
    expect(store.count()).toBe(1)
    expect(store.getAll()[0].id).toBe('ok')
  })

  it('addMany 超过 500 条时按 createdAt 保留最新（M9）', () => {
    const store = new InsightStore(filePath)
    const batch = Array.from({ length: 520 }, (_, i) => makeInsight(`i${i}`, 1000 + i))
    store.addMany(batch)
    expect(store.count()).toBe(500)
    const all = store.getAll()
    expect(all[0].createdAt).toBe(1519)
    expect(all[all.length - 1].createdAt).toBe(1020)

    const reloaded = new InsightStore(filePath)
    expect(reloaded.count()).toBe(500)
  })

  it('prune 删除过期已报告、保留过期未报告', () => {
    const store = new InsightStore(filePath)
    const hundredDaysAgo = Date.now() - 100 * 24 * 60 * 60 * 1000
    store.addMany([makeInsight('old-reported', hundredDaysAgo), makeInsight('old-unreported', hundredDaysAgo), makeInsight('fresh', Date.now())])
    store.markReported('old-reported')
    const removed = store.prune(90)
    expect(removed).toBe(1)
    expect(store.count()).toBe(2)
    expect(store.getAll().map((i) => i.id).sort()).toEqual(['fresh', 'old-unreported'])
  })
})
