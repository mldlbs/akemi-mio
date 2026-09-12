import { log } from '@akemi-mio/core/logger/Logger'
import type { Collector, Observation } from '../types'

/**
 * HackerNewsCollector — 采集 HackerNews 技术趋势
 *
 * 使用官方 Firebase API：https://hacker-news.firebaseio.com/v0/
 * 每次采集 top 30 条，过滤掉已见的。
 */
export class HackerNewsCollector implements Collector {
  readonly name = 'hackernews'
  readonly intervalMs = 60 * 60 * 1000 // 每 60 分钟

  private seenUrls = new Set<string>()

  async collect(): Promise<Observation[]> {
    const now = new Date()
    const ts = now.toISOString()
    const all: Observation[] = []

    try {
      // 1. 获取 top stories ID 列表
      const idsRes = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json', {
        signal: AbortSignal.timeout(15000),
      })
      if (!idsRes.ok) {
        log('WARN', 'hn_fetch_ids_failed', { status: idsRes.status })
        return []
      }
      const ids: number[] = await idsRes.json()
      const topIds = ids.slice(0, 30)

      // 2. 逐个获取详情（HN API 不支持批量）
      const batchSize = 10
      for (let i = 0; i < topIds.length; i += batchSize) {
        const batch = topIds.slice(i, i + batchSize)
        const stories = await Promise.all(
          batch.map((id) =>
            fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, {
              signal: AbortSignal.timeout(10000),
            })
              .then((r) => (r.ok ? r.json() : null))
              .catch(() => null),
          ),
        )

        for (const story of stories) {
          if (!story || story.type !== 'story' || !story.title) continue
          const url = story.url || `https://news.ycombinator.com/item?id=${story.id}`
          if (this.seenUrls.has(url)) continue
          this.seenUrls.add(url)

          const points = story.score ?? 0
          const by = story.by ?? 'unknown'
          all.push({
            id: `hn_${now.getTime()}_${story.id}`,
            timestamp: new Date((story.time || 0) * 1000).toISOString(),
            source: 'hackernews',
            content: `${story.title} (${points} points by ${by})`.slice(0, 200),
          })
        }
      }
    } catch (err: any) {
      log('WARN', 'hn_collect_failed', { error: err.message })
    }

    if (this.seenUrls.size > 10000) {
      this.seenUrls = new Set([...this.seenUrls].slice(-5000))
    }

    log('INFO', 'hn_collected', { new_items: all.length })
    return all
  }
}
