import { log } from '../../logger/Logger'
import type { Collector, Observation } from '../types'

interface GHRepo {
  title: string
  description?: string
  stars?: number
}

interface GHApiResponse {
  code: number
  data?: GHRepo[]
}

/**
 * GitHubTrendingCollector — GitHub Trending 热门项目
 *
 * 优先通过 DailyHotApi 获取，失败时 fallback 到 HTML scrape。
 */
export class GitHubTrendingCollector implements Collector {
  readonly name = 'github-trending'
  readonly intervalMs = 4 * 60 * 60 * 1000

  async collect(): Promise<Observation[]> {
    const now = new Date()
    const ts = now.toISOString()

    // 尝试 API
    try {
      const res = await fetch('https://hot.imsyy.top/hellogithub', { signal: AbortSignal.timeout(10000) })
      if (res.ok) {
        const body = (await res.json()) as GHApiResponse
        const list = body?.data ?? []
        if (list.length > 0) {
          log('INFO', 'gh_trending_collected', { count: list.length })
          return list.slice(0, 15).map((item, i) => ({
            id: `gh_${now.getTime()}_${i}`,
            timestamp: ts,
            source: this.name,
            content: `【GitHub】${item.title} ⭐${item.stars ?? '?'} — ${(item.description || '').slice(0, 100)}`,
          }))
        }
      }
    } catch (err: any) {
      log('WARN', 'gh_trending_api_failed', { error: err.message })
    }

    // Fallback: scrape
    try {
      const res = await fetch('https://github.com/trending?since=daily', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) return []
      const html = await res.text()
      const repos: Observation[] = []
      const articleRegex = /<article[^>]*class="[^"]*Box-row[^"]*"[^>]*>([\s\S]*?)<\/article>/g
      let idx = 0,
        m: RegExpExecArray | null
      while ((m = articleRegex.exec(html)) !== null && repos.length < 15) {
        const a = m[1]
        const title = a.match(/href="\/([^"]+)"/)
        const desc = a.match(/<p[^>]*class="[^"]*col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/)
        const stars = a.match(/octicon-star[\s\S]*?<span[^>]*class="[^"]*d-inline-block[^"]*"[^>]*>([\s\S]*?)<\/span>/)
        if (title)
          repos.push({
            id: `gh_${now.getTime()}_${idx++}`,
            timestamp: ts,
            source: this.name,
            content: `【GitHub】${title[1].trim()} ⭐${stars ? stars[1].trim() : '?'} — ${desc ? stripHtml(desc[1]).slice(0, 100) : ''}`,
          })
      }
      if (repos.length > 0) {
        log('INFO', 'gh_trending_scraped', { count: repos.length })
        return repos
      }
    } catch (err: any) {
      log('WARN', 'gh_trending_scrape_failed', { error: err.message })
    }

    return []
  }
}

function stripHtml(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
