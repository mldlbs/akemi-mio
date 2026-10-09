import { describe, it, expect } from 'vitest'
import { sourceFamily, sampleBySourceQuota } from '@akemi-mio/observer/sourceQuota'
import type { Observation } from '@akemi-mio/observer/types'

function obs(source: string, n: number, tag: string): Observation[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${tag}-${i}`,
    timestamp: `2026-10-08T00:00:${String(i).padStart(2, '0')}.000Z`,
    source,
    content: `${tag} item ${i}`,
  }))
}

function bySource(list: Observation[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const o of list) m.set(o.source, (m.get(o.source) ?? 0) + 1)
  return m
}

describe('sourceFamily', () => {
  it('folds http(s) feed urls into the rss family', () => {
    expect(sourceFamily('https://example.com/feed.xml')).toBe('rss')
    expect(sourceFamily('http://feeds.example.org/rss')).toBe('rss')
    expect(sourceFamily('https://rsshub.app/bilibili/user/video/1')).toBe('rss')
  })

  it('keeps collector names as-is', () => {
    expect(sourceFamily('github-trending')).toBe('github-trending')
    expect(sourceFamily('hackernews')).toBe('hackernews')
    expect(sourceFamily('bilibili')).toBe('bilibili')
  })
})

describe('sampleBySourceQuota', () => {
  it('keeps GH/HN when entertainment sources flood the window', () => {
    const input = [
      ...obs('bilibili', 45, 'bili'),
      ...obs('douyin', 30, 'douyin'),
      ...obs('https://example.com/feed.xml', 20, 'rss'),
      ...obs('github-trending', 3, 'gh'),
      ...obs('hackernews', 2, 'hn'),
    ]
    const out = sampleBySourceQuota(input, 30, 5)
    const counts = bySource(out)
    expect(out).toHaveLength(30)
    expect(counts.get('github-trending')).toBe(3)
    expect(counts.get('hackernews')).toBe(2)
    const entertainment = (counts.get('bilibili') ?? 0) + (counts.get('douyin') ?? 0)
    expect(entertainment).toBeLessThan(30)
    expect((counts.get('github-trending') ?? 0) + (counts.get('hackernews') ?? 0)).toBeGreaterThan(0)
  })

  it('matches slice(0, limit) exactly for a single source', () => {
    const input = obs('bilibili', 100, 'single')
    expect(sampleBySourceQuota(input, 30, 5)).toEqual(input.slice(0, 30))
  })

  it('folds 17 feed urls into one rss family so they cannot eat the quota', () => {
    const feeds = Array.from({ length: 17 }, (_, i) => `https://feed${i}.example.com/rss`)
    const input = [
      ...feeds.flatMap((f, i) => obs(f, 4, `f${i}`)),
      ...obs('github-trending', 4, 'gh'),
      ...obs('hackernews', 4, 'hn'),
      ...obs('bilibili', 30, 'bili'),
      ...obs('douyin', 20, 'douyin'),
    ]
    const out = sampleBySourceQuota(input, 30, 5)
    const counts = bySource(out)
    expect(out).toHaveLength(30)
    const rssTotal = [...counts.entries()].filter(([s]) => sourceFamily(s) === 'rss').reduce((a, [, n]) => a + n, 0)
    expect(rssTotal).toBeGreaterThanOrEqual(5)
    expect(rssTotal).toBeLessThan(30)
    expect(counts.get('github-trending')).toBeGreaterThanOrEqual(4)
    expect(counts.get('hackernews')).toBe(4)
  })

  it('shrinks the quota when families x minPerSource exceeds the limit', () => {
    const input = Array.from({ length: 8 }, (_, f) => obs(`src-${f}`, 10, `s${f}`)).flat()
    const out = sampleBySourceQuota(input, 30, 5)
    expect(out).toHaveLength(30)
    const counts = bySource(out)
    expect(counts.size).toBe(8)
    for (const [, n] of counts) expect(n).toBeGreaterThanOrEqual(3)
  })

  it('preserves input (time) order', () => {
    const input = [
      ...obs('bilibili', 40, 'bili'),
      ...obs('github-trending', 6, 'gh'),
      ...obs('hackernews', 6, 'hn'),
    ]
    const out = sampleBySourceQuota(input, 30, 5)
    const positions = out.map((o) => input.indexOf(o))
    for (let i = 1; i < positions.length; i++) expect(positions[i]).toBeGreaterThan(positions[i - 1])
  })

  it('returns everything in order when input is below the limit', () => {
    const input = [...obs('bilibili', 3, 'bili'), ...obs('github-trending', 2, 'gh')]
    expect(sampleBySourceQuota(input, 30, 5)).toEqual(input)
  })

  it('returns an empty array for empty input', () => {
    expect(sampleBySourceQuota([], 30, 5)).toEqual([])
    expect(sampleBySourceQuota(obs('bilibili', 50, 'x'), 0, 5)).toEqual([])
  })
})
