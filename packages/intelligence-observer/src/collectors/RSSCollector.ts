import { httpFetch } from '../http'
import { log } from '@akemi-mio/core/logger/Logger'
import type { Collector, Observation } from '../types'

interface RssFeedEntry {
  title?: string
  link?: string
  description?: string
  content?: string
  pubDate?: string
}

export interface FeedHealth {
  feed: string
  successes: number
  failures: number
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastError: string | null
}

/**
 * RSSCollector — 采集用户订阅的 RSS 源
 *
 * 通过多个免费 RSS 转换服务获取 feed 内容。
 * 默认源可在 constructor 中配置。
 */
export class RSSCollector implements Collector {
  readonly name = 'rss'
  readonly intervalMs = 60 * 60 * 1000 // 每 60 分钟

  private feeds: string[]
  private seenUrls = new Set<string>()
  private health = new Map<string, { successes: number; failures: number; lastSuccessAt: string | null; lastFailureAt: string | null; lastError: string | null }>()

  constructor(feeds?: string[]) {
    this.feeds = feeds ?? [
      // 中文科技
      'https://feeds.feedburner.com/ruanyifeng',
      'https://36kr.com/feed',
      // 英文科技/行业
      'https://techcrunch.com/feed/',
      'https://www.theverge.com/rss/index.xml',
      'https://feeds.arstechnica.com/arstechnica/index',
      'https://www.wired.com/feed/rss',
      'https://feeds.feedburner.com/oreillyradar',
      // AI / ML
      'https://www.marktechpost.com/feed/',
      'https://www.artificialintelligence-news.com/feed/',
    ]
    for (const f of this.feeds) {
      this.health.set(f, { successes: 0, failures: 0, lastSuccessAt: null, lastFailureAt: null, lastError: null })
    }
  }

  getHealth(): FeedHealth[] {
    return [...this.health.entries()].map(([feed, h]) => ({ feed, ...h }))
  }

  async collect(): Promise<Observation[]> {
    const now = new Date()
    const ts = now.toISOString()
    const all: Observation[] = []
    let idCounter = 0

    for (const feedUrl of this.feeds) {
      const h = this.health.get(feedUrl)
      try {
        const items = await this.fetchFeed(feedUrl)
        if (h) {
          h.successes++
          h.lastSuccessAt = now.toISOString()
        }
        for (const item of items) {
          const url = item.link || item.title || ''
          if (url && this.seenUrls.has(url)) continue
          if (url) this.seenUrls.add(url)

          const content = item.title || stripHtml(item.description || '')
          if (!content || content.length < 5) continue

          all.push({
            id: `rss_${now.getTime()}_${idCounter++}`,
            timestamp: item.pubDate || ts,
            source: feedUrl,
            content: content.slice(0, 200),
            ...(item.link && /^https?:\/\//.test(item.link) ? { url: item.link } : {}),
          })
        }
      } catch (err: any) {
        if (h) {
          h.failures++
          h.lastFailureAt = now.toISOString()
          h.lastError = err.message
        }
        log('WARN', 'rss_collect_failed', { feed: feedUrl, error: err.message })
      }
    }

    if (this.seenUrls.size > 10000) {
      this.seenUrls = new Set([...this.seenUrls].slice(-5000))
    }

    const deadFeeds = this.getHealth().filter((h) => h.successes === 0 && h.failures > 0)
    if (deadFeeds.length > 0) {
      log('WARN', 'rss_feeds_dead', { feeds: deadFeeds.map((h) => h.feed) })
    }

    log('INFO', 'rss_collected', { feeds: this.feeds.length, new_items: all.length })
    return all
  }

  private async fetchFeed(feedUrl: string): Promise<RssFeedEntry[]> {
    const services = [`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feedUrl)}`]

    for (const serviceUrl of services) {
      try {
        const res = await httpFetch(serviceUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          signal: AbortSignal.timeout(15000),
        })
        if (!res.ok) continue

        const json = (await res.json()) as Record<string, unknown>
        const j = json as any
        if (j?.items && Array.isArray(j.items)) {
          return j.items.map((item: any) => ({
            title: item.title,
            link: item.link || item.guid || '',
            description: item.description || item.content,
            pubDate: item.pubDate || item.date,
          }))
        }
      } catch {
        continue
      }
    }

    return []
  }
}

function stripHtml(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}
