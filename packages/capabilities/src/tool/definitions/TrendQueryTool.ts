import { buildTool, formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'
import { WORKSPACE } from '@akemi-mio/core/config'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const OBSERVER_DIR = join(WORKSPACE.evolution, 'observer')

interface TrendSignal {
  keyword: string
  score: number
  source: string
  occurrenceCount: number
  recentObservationIds: string[]
}

interface Observation {
  id: string
  content: string
  source: string
}

function loadSignals(days: number): TrendSignal[] {
  const dir = join(OBSERVER_DIR, 'trends')
  if (!existsSync(dir)) return []

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, days)

  const signals: TrendSignal[] = []
  for (const file of files) {
    const raw = readFileSync(join(dir, file), 'utf-8')
    const data = JSON.parse(raw)
    if (data.signals) {
      for (const s of data.signals) {
        signals.push({
          keyword: s.keyword,
          score: s.score ?? 0,
          source: s.source ?? 'unknown',
          occurrenceCount: s.occurrenceCount ?? 0,
          recentObservationIds: s.recentObservationIds ?? [],
        })
      }
    }
  }
  signals.sort((a, b) => b.score - a.score)
  return signals
}

function buildObsMap(days: number): Map<string, Observation> {
  const map = new Map<string, Observation>()
  const dir = join(OBSERVER_DIR, 'observations')
  if (!existsSync(dir)) return map

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, days)

  for (const file of files) {
    const raw = readFileSync(join(dir, file), 'utf-8')
    const data = JSON.parse(raw)
    if (data.observations) {
      for (const obs of data.observations) {
        if (obs.id && obs.content && !map.has(obs.id)) {
          map.set(obs.id, { id: obs.id, content: obs.content, source: obs.source })
        }
      }
    }
  }
  return map
}

export const queryTrendsTool = buildTool({
  name: 'query_trends',
  description:
    '查询近期的网络热点。返回具体的观察片段（如"一个考生查分时全家屏住呼吸的视频获得300万点赞"），不只是关键词。可指定关键词过滤',
  inputJSONSchema: {
    type: 'object',
    properties: {
      keyword: {
        type: 'string',
        description: '可选，过滤关键词。留空返回全部热门片段',
      },
      days: {
        type: 'number',
        description: '回看天数，默认 3 天',
      },
    },
    required: [],
  },
  handler: async (args: { keyword?: string; days?: number }) => {
    try {
      const days = Math.min(Math.max(args.days ?? 3, 1), 7)
      const signals = loadSignals(days)

      if (signals.length === 0) {
        return formatToolResult('近期无趋势数据（Observer 尚未跑过 pipeline 或趋势为空）')
      }

      const obsMap = buildObsMap(days)
      const keyword = args.keyword?.trim()

      if (keyword) {
        const matched = signals.filter((s) => s.keyword.includes(keyword) || keyword.includes(s.keyword))
        if (matched.length === 0) {
          return formatToolResult(`未找到包含「${keyword}」的趋势信号`)
        }

        const lines: string[] = []
        const seen = new Set<string>()
        for (const s of matched) {
          lines.push(`\n— ${s.keyword}（热度 ${(s.score * 100).toFixed(0)}，${s.occurrenceCount} 条）`)
          const ids = (s.recentObservationIds ?? []).slice(0, 5)
          for (const id of ids) {
            const obs = obsMap.get(id)
            if (!obs) continue
            const dedupKey = obs.content.slice(0, 40)
            if (seen.has(dedupKey)) continue
            seen.add(dedupKey)
            lines.push(`  [${obs.source}] ${obs.content}`)
          }
        }

        return formatToolResult(lines.join('\n'))
      }

      // 无 keyword：展示 top-10 热点的精选片段
      const top = signals.slice(0, 10)
      const lines: string[] = []
      const seen = new Set<string>()

      for (const s of top) {
        const ids = (s.recentObservationIds ?? []).slice(0, 2)
        let snippetCount = 0
        for (const id of ids) {
          const obs = obsMap.get(id)
          if (!obs) continue
          const dedupKey = obs.content.slice(0, 40)
          if (seen.has(dedupKey)) continue
          seen.add(dedupKey)
          if (snippetCount === 0) {
            lines.push(`\n${s.keyword}:`)
          }
          lines.push(`  [${obs.source}] ${obs.content}`)
          snippetCount++
        }
        if (snippetCount === 0) {
          lines.push(`\n${s.keyword} — 热度 ${(s.score * 100).toFixed(0)}`)
        }
      }

      return formatToolResult(`近期热点（共 ${signals.length} 个话题）:\n${lines.join('\n')}`)
    } catch (err: any) {
      return formatToolError(`查询趋势失败: ${err.message}`)
    }
  },
  isReadOnly: true,
})

