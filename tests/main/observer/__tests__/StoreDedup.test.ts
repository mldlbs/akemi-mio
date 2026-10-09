import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { resolve } from 'path'
import { ObserverStore, normalizeForDedup } from '@akemi-mio/observer/ObserverStore'
import type { Observation } from '@akemi-mio/observer/types'

const logMock = vi.hoisted(() => vi.fn())

vi.mock('@akemi-mio/observer/logger', () => ({ log: logMock }))

function obs(source: string, content: string, id = 'x'): Observation {
  return { id, timestamp: '2026-10-09T00:00:00.000Z', source, content }
}

function dateStr(offsetDays = 0): string {
  const d = new Date()
  d.setDate(d.getDate() - offsetDays)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

describe('normalizeForDedup', () => {
  it('剥 HTML 标签、折叠空白、trim', () => {
    expect(normalizeForDedup('【GitHub】<b>Foo</b>   Bar\n')).toBe('【GitHub】Foo Bar')
    expect(normalizeForDedup('  a  b  ')).toBe('a b')
  })
})

describe('ObserverStore.store 去重', () => {
  let baseDir: string

  beforeEach(() => {
    baseDir = mkdtempSync(resolve(tmpdir(), 'obs-store-'))
    logMock.mockReset()
  })

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true })
  })

  it('同日同指纹第二次 store 不落盘（守住既有行为），且发 store_dedup 日志', () => {
    const store = new ObserverStore(baseDir)
    const a = obs('github-trending', '【GitHub】owner/repo ⭐1 — desc')

    store.store([a])
    store.store([obs('github-trending', '【GitHub】owner/repo ⭐1 — desc', 'y')])

    const daily = store.readDaily(dateStr())
    expect(daily.observations).toHaveLength(1)
    expect(daily.observations[0].id).toBe('x')
    expect(logMock).toHaveBeenCalledWith('INFO', 'store_dedup', { skipped: 1, stored: 0, windowDays: 7 })
  })

  it('跨日窗口：昨日文件已有同指纹，今日 store 被跳过', () => {
    const store = new ObserverStore(baseDir)
    mkdirSync(store.observationsDir, { recursive: true })
    const yesterday = dateStr(1)
    writeFileSync(
      resolve(store.observationsDir, `${yesterday}.json`),
      JSON.stringify({ date: yesterday, observations: [obs('github-trending', '【GitHub】owner/repo ⭐9 — old')] }),
      'utf-8',
    )

    store.store([obs('github-trending', '【GitHub】owner/repo ⭐9 — old')])

    expect(existsSync(resolve(store.observationsDir, `${dateStr()}.json`))).toBe(false)
    expect(logMock).toHaveBeenCalledWith('INFO', 'store_dedup', { skipped: 1, stored: 0, windowDays: 7 })
  })

  it('批内重复（含空白/HTML 差异）只留先到者', () => {
    const store = new ObserverStore(baseDir)

    store.store([
      obs('rss', '【RSS】Hello   World'),
      obs('rss', '【RSS】Hello <b>World</b>', 'y'),
      obs('rss', '【RSS】Different item', 'z'),
    ])

    const daily = store.readDaily(dateStr())
    expect(daily.observations).toHaveLength(2)
    expect(daily.observations.map((o) => o.id)).toEqual(['x', 'z'])
    expect(logMock).toHaveBeenCalledWith('INFO', 'store_dedup', { skipped: 1, stored: 2, windowDays: 7 })
  })

  it('同 content 不同 source 均落盘（指纹含 source）', () => {
    const store = new ObserverStore(baseDir)

    store.store([obs('source-a', 'same content'), obs('source-b', 'same content')])

    expect(store.readDaily(dateStr()).observations).toHaveLength(2)
    expect(logMock).not.toHaveBeenCalled()
  })

  it('7 日窗口边缘：8 天前的同指纹不再拦截', () => {
    const store = new ObserverStore(baseDir)
    mkdirSync(store.observationsDir, { recursive: true })
    const eightDaysAgo = dateStr(8)
    writeFileSync(
      resolve(store.observationsDir, `${eightDaysAgo}.json`),
      JSON.stringify({ date: eightDaysAgo, observations: [obs('weibo-hot', 'ancient item')] }),
      'utf-8',
    )

    store.store([obs('weibo-hot', 'ancient item')])

    expect(store.readDaily(dateStr()).observations).toHaveLength(1)
    expect(logMock).not.toHaveBeenCalled()
  })

  it('新旧数据规范化互认：老式带标签 content 拦截新式清洗 content', () => {
    const store = new ObserverStore(baseDir)
    mkdirSync(store.observationsDir, { recursive: true })
    const yesterday = dateStr(1)
    writeFileSync(
      resolve(store.observationsDir, `${yesterday}.json`),
      JSON.stringify({ date: yesterday, observations: [obs('github-trending', '【GitHub】<b>Foo</b> —   bar')] }),
      'utf-8',
    )

    store.store([obs('github-trending', '【GitHub】Foo — bar')])

    expect(existsSync(resolve(store.observationsDir, `${dateStr()}.json`))).toBe(false)
  })

  it('读回的 JSON 中 content 原样保留（规范化只作用于指纹）', () => {
    const store = new ObserverStore(baseDir)

    store.store([obs('rss', '  spaced   content  ')])

    const raw = JSON.parse(readFileSync(resolve(store.observationsDir, `${dateStr()}.json`), 'utf-8'))
    expect(raw.observations[0].content).toBe('  spaced   content  ')
  })
})
