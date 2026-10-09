import type { Observation } from './types'

/**
 * 抽样分组键：RSS 各 feedUrl 收敛为一个家族，collector 名原样返回。
 * 只影响抽样分组，不改 Observation.source 的落库语义。
 */
export function sourceFamily(source: string): string {
  return /^https?:\/\//.test(source) ? 'rss' : source
}

interface Entry {
  idx: number
  obs: Observation
}

interface Share {
  family: string
  group: Entry[]
  pool: number
  base: number
  frac: number
}

/**
 * insight 输入窗口按来源配额抽样（纯函数、确定性、无随机）。
 *
 * 1. 输入 ≤ limit → 原序全量（与旧 slice(0, limit) 行为等价）。
 * 2. 按 sourceFamily 分组，家族首现序即优先序。
 * 3. 自适应保底配额：家族数 × minPerSource > limit 时缩为 floor(limit / 家族数)。
 * 4. Phase A 每家族取其组前 quota 条（小源全进 → GH/HN 占比 >0）。
 * 5. Phase B 余量按各家族余池占比（最大余数法、tie 取首现序）补齐。
 * 6. 输出保持原始输入时间序。
 */
export function sampleBySourceQuota(
  observations: Observation[],
  limit = 30,
  minPerSource = 5
): Observation[] {
  if (limit <= 0) return []
  if (observations.length <= limit) return observations.slice()

  const groups = new Map<string, Entry[]>()
  observations.forEach((obs, idx) => {
    const family = sourceFamily(obs.source)
    let g = groups.get(family)
    if (!g) {
      g = []
      groups.set(family, g)
    }
    g.push({ idx, obs })
  })

  const families = [...groups.keys()]
  let quota = minPerSource
  if (families.length * quota > limit) {
    quota = Math.max(1, Math.floor(limit / families.length))
  }

  const picked = new Set<number>()
  const taken = new Map<string, number>()

  // Phase A：每家族保底
  for (const family of families) {
    const g = groups.get(family)!
    const take = Math.min(quota, g.length)
    for (let i = 0; i < take; i++) picked.add(g[i].idx)
    taken.set(family, take)
  }

  // Phase B：余量按余池占比分配（最大余数法）
  const remaining = limit - picked.size
  if (remaining > 0) {
    const shares: Share[] = families.map((family) => {
      const group = groups.get(family)!
      return { family, group, pool: group.length - taken.get(family)!, base: 0, frac: 0 }
    })
    const totalPool = shares.reduce((s, x) => s + x.pool, 0)
    if (totalPool > 0) {
      for (const s of shares) {
        const exact = (remaining * s.pool) / totalPool
        s.base = Math.floor(exact)
        s.frac = exact - s.base
      }
      let leftover = remaining - shares.reduce((s, x) => s + x.base, 0)
      const byFrac = [...shares].sort((a, b) => b.frac - a.frac)
      for (const s of byFrac) {
        if (leftover <= 0) break
        if (s.pool > s.base) {
          s.base++
          leftover--
        }
      }
      for (const s of shares) {
        const start = taken.get(s.family)!
        for (let i = start; i < start + s.base; i++) picked.add(s.group[i].idx)
      }
    }
  }

  return observations.filter((_, i) => picked.has(i))
}
