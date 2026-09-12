/**
 * CreativityMetrics — 创意管道监控指标
 *
 * 跟踪四个核心指标，用于判断吞吐实验是否成功：
 * 1. idea/day — 每天生成的假设数
 * 2. promote/day — 每天 promote 的假设数
 * 3. promote→execution rate — promote 后真正进入执行的比例
 * 4. promote→useful outcome rate — 执行后产生有效结果的比例
 *
 * 判断标准：
 * - 1、2 高，4 下降 → 阈值过松，需收紧
 * - 1、2 高，4 稳定 → 调整成功
 * - 1、2 都低 → 生成器问题，不是周期问题
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { eventBus } from '@akemi-mio/core/core/EventBus'

interface MetricEntry {
  timestamp: number
  type: 'generated' | 'promoted' | 'executed' | 'outcome'
  hypothesisId: string
  success?: boolean
}

export class CreativityMetrics {
  private entries: MetricEntry[] = []
  private maxEntries = 10000

  constructor() {
    // 监听 EventBus 事件自动采集
    eventBus.on('creativity.ideas.generated', (p: any) => {
      this.record('generated', p.hypothesisId || '')
    })
    eventBus.on('creativity.hypothesis.promoted', (p: any) => {
      this.record('promoted', p.hypothesisId || '')
    })
    eventBus.on('creativity.executed', (p: any) => {
      this.record('executed', p.hypothesisId || '', p.applied === true)
    })
  }

  record(type: MetricEntry['type'], hypothesisId: string, success?: boolean): void {
    this.entries.push({ timestamp: Date.now(), type, hypothesisId, success })
    // 滚动窗口：只保留最近 7 天
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    this.entries = this.entries.filter(e => e.timestamp >= cutoff)
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries)
    }
  }

  /** 获取最近 N 天的指标摘要 */
  report(days = 1): {
    ideaCount: number
    promoteCount: number
    executionCount: number
    outcomeCount: number
    promoteRate: number
    executionRate: number
    outcomeRate: number
  } {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    const recent = this.entries.filter(e => e.timestamp >= cutoff)

    const ideaCount = recent.filter(e => e.type === 'generated').length
    const promoteCount = recent.filter(e => e.type === 'promoted').length
    const executionCount = recent.filter(e => e.type === 'executed').length
    const outcomeCount = recent.filter(e => e.type === 'outcome' && e.success).length

    return {
      ideaCount,
      promoteCount,
      executionCount,
      outcomeCount,
      promoteRate: ideaCount > 0 ? promoteCount / ideaCount : 0,
      executionRate: promoteCount > 0 ? executionCount / promoteCount : 0,
      outcomeRate: executionCount > 0 ? outcomeCount / executionCount : 0,
    }
  }

  /** 生成 Markdown 报告 */
  reportMarkdown(days = 7): string {
    const r = this.report(days)
    return [
      `## 创意管道指标 (${days}天)`,
      '',
      `| 指标 | 值 |`,
      `|---|---|`,
      `| 生成量 | ${r.ideaCount} idea/${days}d |`,
      `| Promote 量 | ${r.promoteCount}/${days}d |`,
      `| 执行量 | ${r.executionCount}/${days}d |`,
      `| 有效结果 | ${r.outcomeCount}/${days}d |`,
      `| promote 率 | ${(r.promoteRate * 100).toFixed(1)}% |`,
      `| 执行率 | ${(r.executionRate * 100).toFixed(1)}% |`,
      `| 有效率 | ${(r.outcomeRate * 100).toFixed(1)}% |`,
      '',
      r.promoteRate > 0.5 ? '⚠️ promote 率偏高，阈值可能过松' : '',
      r.outcomeRate < 0.3 && r.executionCount > 5 ? '⚠️ 有效率偏低，执行质量需关注' : '',
      r.ideaCount < 3 && days >= 1 ? '⚠️ 生成量偏低，检查生成器是否正常' : '',
    ].filter(Boolean).join('\n')
  }
}

export const creativityMetrics = new CreativityMetrics()

