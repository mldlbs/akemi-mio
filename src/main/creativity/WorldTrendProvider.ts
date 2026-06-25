import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { resolveRandom, type RandomGenerator } from '../utils/random'

/**
 * WorldTrendProvider — 从 Observer 工作线程的世界模型中读取趋势和洞察
 *
 * 数据来源：
 * - evolution_workspace/observer/world_model/trends.json
 * - evolution_workspace/observer/insights/<latest>.json
 *
 * 如果文件不存在（Observer 尚未运行过），返回空数组。
 */
export class WorldTrendProvider {
  private observerDir: string
  private consumedNames: Set<string> = new Set()
  private rng: RandomGenerator

  constructor(observerDir: string, seed?: number) {
    this.observerDir = observerDir
    this.rng = resolveRandom(seed)
  }

  /** 重置已消费记录，让所有趋势重新可被选取 */
  resetConsumed(): void {
    this.consumedNames.clear()
  }

  /** 获取近期世界趋势列表（轮换选取，每次不同） */
  getTrends(): string[] {
    const trendsFile = join(this.observerDir, 'world_model', 'trends.json')
    if (!existsSync(trendsFile)) return []

    try {
      const raw = readFileSync(trendsFile, 'utf-8')
      const trends = JSON.parse(raw)
      if (!Array.isArray(trends)) return []

      const valid = trends.filter((t: any) => t.name && t.momentum != null).sort((a: any, b: any) => (b.momentum || 0) - (a.momentum || 0))

      // 取 top-15，跳过已消费的，从剩余中随机选 3-5 条
      const candidates = valid.slice(0, 50).filter((t: any) => !this.consumedNames.has(t.name))
      if (candidates.length === 0) {
        this.consumedNames.clear()
        const refill = valid.slice(0, 50)
        return this.pickRandom(refill)
      }

      const picked = this.pickRandom(candidates)
      for (const t of picked) this.consumedNames.add(t.name)
      return picked
    } catch {
      return []
    }
  }

  /** 从趋势数组中随机取 3-5 条 */
  private pickRandom(trends: any[]): string[] {
    const count = Math.min(trends.length, 3 + Math.floor(this.rng() * 3))
    const shuffled = [...trends].sort(() => this.rng() - 0.5)
    return shuffled
      .slice(0, count)
      .map((t: any) => `[${t.direction === 'rising' ? '↑' : '↓'}] ${t.name} (强度:${(t.momentum * 100).toFixed(0)})`)
  }

  /** 获取近期洞察摘要（最多 3 条） */
  getInsights(): string[] {
    const insightsDir = join(this.observerDir, 'insights')
    if (!existsSync(insightsDir)) return []

    try {
      const { readdirSync } = require('fs') as typeof import('fs')
      const files = readdirSync(insightsDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, 3)

      const insights: string[] = []
      for (const file of files) {
        const raw = readFileSync(join(insightsDir, file), 'utf-8')
        const data = JSON.parse(raw)
        // InsightOutput 结构
        const topic = data.topic || data.payload?.topic || ''
        const sections = data.sections || data.payload?.sections || []
        const summary = sections
          .filter((s: any) => s.title === '发生了什么' || s.title === '我的理解')
          .map((s: any) => s.content?.slice(0, 100))
          .filter(Boolean)
          .join(' | ')
        if (topic) insights.push(`${topic}: ${summary || '(无摘要)'}`)
      }
      return insights
    } catch {
      return []
    }
  }
}
