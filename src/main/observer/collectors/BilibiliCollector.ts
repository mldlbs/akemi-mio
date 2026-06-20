import { log } from '../../logger/Logger'
import type { Collector, Observation } from '../types'

interface BiliHotwordItem {
  keyword: string
  show_name?: string
}

interface BiliPopularVideo {
  title: string
  aid: number
  owner?: { name: string }
}

interface BiliApiResponse<T> {
  code: number
  data?: T
}

/**
 * BilibiliCollector — B站热搜和热门视频
 *
 * 官方公开 API（无需 WBI 签名）：
 * - 热搜词: s.search.bilibili.com/main/hotword
 * - 热门视频: api.bilibili.com/x/web-interface/popular
 */
export class BilibiliCollector implements Collector {
  readonly name = 'bilibili'
  readonly intervalMs = 60 * 60 * 1000

  private headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Referer: 'https://www.bilibili.com/',
  }

  async collect(): Promise<Observation[]> {
    const now = new Date()
    const ts = now.toISOString()
    const all: Observation[] = []

    // 热搜词
    try {
      const res = await fetch('https://s.search.bilibili.com/main/hotword', {
        headers: this.headers,
        signal: AbortSignal.timeout(10000),
      })
      if (res.ok) {
        const data = (await res.json()) as BiliApiResponse<{ list?: BiliHotwordItem[] }>
        const list = data?.data?.list ?? []
        all.push(
          ...list.slice(0, 15).map((item, i) => ({
            id: `bili_hot_${now.getTime()}_${i}`,
            timestamp: ts,
            source: this.name,
            content: item.show_name || item.keyword,
          })),
        )
      }
    } catch (err: any) {
      log('WARN', 'bili_hotword_failed', { error: err.message })
    }

    // 热门视频
    try {
      const res = await fetch('https://api.bilibili.com/x/web-interface/popular?ps=10&pn=1', {
        headers: this.headers,
        signal: AbortSignal.timeout(10000),
      })
      if (res.ok) {
        const data = (await res.json()) as BiliApiResponse<{ list?: BiliPopularVideo[] }>
        const list = data?.data?.list ?? []
        all.push(
          ...list.map((v, i) => ({
            id: `bili_pop_${now.getTime()}_${i}`,
            timestamp: ts,
            source: this.name,
            content: `【B站热门】${v.title}`,
          })),
        )
      }
    } catch (err: any) {
      log('WARN', 'bili_popular_failed', { error: err.message })
    }

    log('INFO', 'bili_collected', { total: all.length })
    return all
  }
}
