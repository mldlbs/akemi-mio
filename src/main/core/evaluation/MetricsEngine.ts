/**
 * MetricsEngine — 对事实的纯函数映射
 *
 * 职责：一次扫描事件窗口，计算所有基础指标。
 * 不承担复合指标（Capability Density / Productivity / User Satisfaction），
 * 那些是 Fitness Engine 的职责。
 *
 * ── 核心原则 ──
 * - Metrics 描述系统，Fitness 评价系统
 * - compute(window) 是唯一入口
 * - 一次迭代扫描所有事件，避免重复遍历
 * - 输出 MetricSnapshot 不含任何价值判断
 *
 * ── 数据流 ──
 * EventIterator → MetricsEngine → MetricSnapshot → FitnessEngine
 */

import type { EventIterator, MetricSnapshot, MetricsEngine, TimeWindow } from './types'

export class MetricsEngineImpl implements MetricsEngine {
  private iterator: EventIterator

  constructor(iterator: EventIterator) {
    this.iterator = iterator
  }

  async compute(window: TimeWindow): Promise<MetricSnapshot> {
    // ── 1. 一次性获取所有 model 事件（invoked + completed） ──
    const [invokedEvents, completedEvents] = await Promise.all([
      this.iterator.getEvents(window, { type: 'model.invoked' }),
      this.iterator.getEvents(window, { type: 'model.completed' }),
    ])

    // ── 2. 流量 —— 总量 ──
    const totalCalls = invokedEvents.length

    const completed = completedEvents.filter((e) => !(e.payload as any).error)
    const failed = completedEvents.filter((e) => !!(e.payload as any).error)
    const completedCalls = completed.length
    const failedCalls = failed.length

    // ── 3. 质量 —— 以成功调用为分母 ──
    const completionRate = totalCalls > 0 ? completedCalls / totalCalls : 0

    const allOutputTokens = completed.map((e) => (e.payload as any).outputTokens as number)
    const avgOutputTokens = allOutputTokens.length > 0 ? allOutputTokens.reduce((a, b) => a + b, 0) / allOutputTokens.length : 0

    // ── 4. 延迟 —— 从成功的 completed 事件提取 ──
    const durations = completed.map((e) => (e.payload as any).durationMs as number).filter(Boolean)
    durations.sort((a, b) => a - b)

    const avgMs = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0
    const p50Ms = percentile(durations, 0.5)
    const p95Ms = percentile(durations, 0.95)
    const maxMs = durations.length > 0 ? durations[durations.length - 1] : 0

    // ── 5. 成本 —— Token ──
    let totalInputTokens = 0
    let totalOutputTokens = 0

    for (const e of completedEvents) {
      const p = e.payload as any
      totalInputTokens += p.inputTokens ?? 0
      totalOutputTokens += p.outputTokens ?? 0
    }

    return {
      window,
      capturedAt: Date.now(),
      traffic: { totalCalls, completedCalls, failedCalls },
      quality: { completionRate, avgOutputTokens },
      latency: { avgMs, p50Ms, p95Ms, maxMs },
      cost: { totalInputTokens, totalOutputTokens, totalTokens: totalInputTokens + totalOutputTokens },
    }
  }
}

/** 快速百分位计算（已排序数组） */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.ceil(p * sorted.length) - 1
  return sorted[Math.max(0, idx)]
}
