import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

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

  constructor(observerDir: string) {
    this.observerDir = observerDir
  }

  /** 获取近期世界趋势列表（最多 5 条） */
  getTrends(): string[] {
    const trendsFile = join(this.observerDir, 'world_model', 'trends.json')
    if (!existsSync(trendsFile)) return []

    try {
      const raw = readFileSync(trendsFile, 'utf-8')
      const trends = JSON.parse(raw)
      if (!Array.isArray(trends)) return []

      return trends
        .filter((t: any) => t.name && t.momentum != null)
        .sort((a: any, b: any) => (b.momentum || 0) - (a.momentum || 0))
        .slice(0, 5)
        .map((t: any) => `[${t.direction === 'rising' ? '↑' : '↓'}] ${t.name} (强度:${(t.momentum * 100).toFixed(0)})`)
    } catch {
      return []
    }
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
