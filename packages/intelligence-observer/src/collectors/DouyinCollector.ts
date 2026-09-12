import { log } from '@akemi-mio/core/logger/Logger'
import type { Collector, Observation } from '../types'

interface DouyinHotItem {
  title: string
  hot?: number
}

interface DouyinApiResponse {
  code: number
  data?: DouyinHotItem[]
}

/**
 * DouyinCollector — 抖音热搜榜
 *
 * 通过第三方聚合 API（Cloudflare CDN，国内可访问）。
 */
export class DouyinCollector implements Collector {
  readonly name = 'douyin'
  readonly intervalMs = 60 * 60 * 1000

  private apis = ['https://60s.viki.moe/v2/douyin', 'https://hot.imsyy.top/douyin']

  async collect(): Promise<Observation[]> {
    const now = new Date()
    const ts = now.toISOString()

    for (const url of this.apis) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
        if (!res.ok) continue
        const body = (await res.json()) as DouyinApiResponse
        const list = body?.data ?? []
        if (list.length === 0) continue
        const obs = list.slice(0, 20).map((item, i) => ({
          id: `douyin_${now.getTime()}_${i}`,
          timestamp: ts,
          source: this.name,
          content: `【抖音热点】${item.title}`,
        }))
        log('INFO', 'douyin_collected', { count: obs.length })
        return obs
      } catch (err: any) {
        log('WARN', 'douyin_failed', { url, error: err.message })
      }
    }
    return []
  }
}
