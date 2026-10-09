import { httpFetch } from '../http'
import { log } from '../logger'
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
      const res = await httpFetch('https://hot.imsyy.top/hellogithub', { signal: AbortSignal.timeout(10000) })
      if (res.ok) {
        const body = (await res.json()) as GHApiResponse
        const list = body?.data ?? []
        if (list.length > 0) {
          log('INFO', 'gh_trending_collected', { count: list.length })
          return list
            .slice(0, 15)
            .map((item, i) => {
              const title = stripHtml(String(item.title ?? ''))
              const description = stripHtml(String(item.description ?? ''))
              return {
                id: `gh_${now.getTime()}_${i}`,
                timestamp: ts,
                source: this.name,
                content: `【GitHub】${title} ⭐${item.stars ?? '?'} — ${truncateAtWord(description, 100)}`,
                metadata: { description },
              }
            })
            .filter((obs) => /【GitHub】(\S)/.test(obs.content))
        }
      }
    } catch (err: any) {
      log('WARN', 'gh_trending_api_failed', { error: err.message })
    }

    // Fallback: scrape
    try {
      const res = await httpFetch('https://github.com/trending?since=daily', {
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
        const hrefRe = /href="\/([^"]+)"/g
        let repoPath: string | null = null,
          hm: RegExpExecArray | null
        while ((hm = hrefRe.exec(a)) !== null) {
          repoPath = validRepoPath(hm[1])
          if (repoPath) break
        }
        const desc = a.match(/<p[^>]*class="[^"]*col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/)
        const stars = a.match(/octicon-star[\s\S]*?<span[^>]*class="[^"]*d-inline-block[^"]*"[^>]*>([\s\S]*?)<\/span>/)
        const cleanDesc = stripHtml(desc ? desc[1] : '')
        if (repoPath)
          repos.push({
            id: `gh_${now.getTime()}_${idx++}`,
            timestamp: ts,
            source: this.name,
            content: `【GitHub】${repoPath} ⭐${stars ? (stripHtml(stars[1]).trim() || '?') : '?'} — ${truncateAtWord(cleanDesc, 100)}`,
            metadata: { description: cleanDesc },
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

/**
 * Path segments that look like a repo but never are one. Two-segment site
 * links (`/topics/ai`, `/collections/x`) pass the owner/repo shape check, so
 * known first-level GitHub sections are rejected explicitly; scanning then
 * continues to the real repo anchor inside the same article.
 */
const REPO_PATH_BLOCKLIST = new Set([
  'login',
  'sponsors',
  'sponsors_logos',
  'topics',
  'collections',
  'settings',
  'search',
  'explore',
  'marketplace',
  'pricing',
  'features',
  'orgs',
  'about',
  'notifications',
  'security',
  'terms',
  'privacy',
  'contact',
])

/**
 * Validates a scraped `/owner/repo` path. Rejects the anchors that actually
 * appear first inside trending `<article>` blocks (`login?return_to=…`,
 * `sponsors/…`), multi-segment links (`topics/…`, `collections/…`) and
 * anything with characters a real GitHub owner/repo cannot contain.
 * Returns the canonical `owner/repo` or null.
 */
export function validRepoPath(raw: string): string | null {
  const cleaned = raw.split(/[?#]/)[0].trim().replace(/^\/+|\/+$/g, '')
  const segs = cleaned.split('/').filter((s) => s.length > 0)
  if (segs.length !== 2) return null
  const [owner, repo] = segs
  if (REPO_PATH_BLOCKLIST.has(owner.toLowerCase())) return null
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null
  return `${owner}/${repo}`
}

/**
 * Word-boundary truncation: never cuts inside a word. Falls back to the raw
 * cut only when there is no usable space in the first half of the window
 * (otherwise a spaceless slug would degrade to an arbitrarily short prefix).
 */
export function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  if (lastSpace > max * 0.5) return cut.slice(0, lastSpace).trimEnd()
  return cut.trimEnd()
}

function stripHtml(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
