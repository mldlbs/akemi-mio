/**
 * AgentPerformanceCollector — Agent 性能退化的采集器
 *
 * 从 AgentMonitor 读取当前趋势分析，当检测到持续的性能退化（成功率下降、
 * 情感分数下降、延迟增加等）时生成 Problem 供管道消费。
 *
 * 触发条件（全部满足）：
 * 1. AgentMonitor 报告 hasSufficientData（>= 10 轮）
 * 2. TrendAnalysis.isDegraded === true
 * 3. 至少有一个 critical 或 2 个 warning 信号
 * 4. 距离上次报告的冷却期已过（24h）
 */

import { log } from '@akemi-mio/core/logger/Logger'

import type { SignalCollector, Problem } from './types'
import type { AgentMonitor, TrendAnalysis } from '@akemi-mio/intelligence/agent/AgentMonitor'

export class AgentPerformanceCollector implements SignalCollector {
  readonly name = 'agent-performance-collector'
  readonly source = 'agent' as const

  private lastRun = 0
  private minIntervalMs = 60 * 60 * 1000
  /** 报告冷却：同一类退化信号 24h 内不重复报告 */
  private signalCooldowns = new Map<string, number>()
  private static readonly SIGNAL_COOLDOWN_MS = 24 * 60 * 60 * 1000

  private agentMonitor: AgentMonitor

  constructor(monitor: AgentMonitor) {
    this.agentMonitor = monitor
  }

  shouldRun(): boolean {
    if (Date.now() - this.lastRun < this.minIntervalMs) return false
    return true
  }

  getSkipReason(): string {
    if (Date.now() - this.lastRun < this.minIntervalMs) {
      const remaining = Math.round((this.minIntervalMs - (Date.now() - this.lastRun)) / 1000)
      return `cooldown: ${remaining}s remaining`
    }
    return 'unknown'
  }

  async collect(): Promise<Problem[]> {
    this.lastRun = Date.now()
    const problems: Problem[] = []

    try {
      const trend = this.agentMonitor.getTrendAnalysis()

      if (!trend.hasSufficientData) {
        log('INFO', 'agent_perf_collector_insufficient_data', {
          rounds: this.agentMonitor.count,
          minRequired: this.agentMonitor.getConfig().minRoundsForAnalysis,
        })
        return []
      }

      if (!trend.isDegraded || trend.degradationSignals.length === 0) {
        log('INFO', 'agent_perf_collector_healthy', {
          successRate: (trend.current.successRate * 100).toFixed(0) + '%',
          sentiment: (trend.current.avgSentiment * 100).toFixed(0) + '%',
          durationMs: trend.current.avgDurationMs.toFixed(0) + 'ms',
        })
        return []
      }

      // 过滤：至少一个 critical 或 2 个 warning
      const criticalSignals = trend.degradationSignals.filter((s) => s.severity === 'critical')
      const warningSignals = trend.degradationSignals.filter((s) => s.severity === 'warning')

      if (criticalSignals.length === 0 && warningSignals.length < 2) {
        log('INFO', 'agent_perf_collector_insufficient_severity', {
          critical: criticalSignals.length,
          warning: warningSignals.length,
        })
        return []
      }

      log('WARN', 'agent_perf_collector_degraded', {
        signals: trend.degradationSignals.length,
        critical: criticalSignals.length,
        successRate: `${(trend.current.successRate * 100).toFixed(0)}%`,
        previousSuccessRate: trend.previous ? `${(trend.previous.successRate * 100).toFixed(0)}%` : 'N/A',
        sentiment: `${(trend.current.avgSentiment * 100).toFixed(0)}%`,
        previousSentiment: trend.previous ? `${(trend.previous.avgSentiment * 100).toFixed(0)}%` : 'N/A',
      })

      const now = Date.now()

      // 为关键信号生成 Problem
      for (const signal of [...criticalSignals, ...warningSignals]) {
        const signalId = `agent:${signal.type}`

        // 冷却检查
        const lastReported = this.signalCooldowns.get(signalId)
        if (lastReported && now - lastReported < AgentPerformanceCollector.SIGNAL_COOLDOWN_MS) {
          log('INFO', 'agent_perf_collector_cooldown', {
            signalId,
            remainingHours: Math.round((AgentPerformanceCollector.SIGNAL_COOLDOWN_MS - (now - lastReported)) / 3600000),
          })
          continue
        }

        this.signalCooldowns.set(signalId, now)

        // 构建严重度
        let severity: Problem['severity'] = 'info'
        if (signal.severity === 'critical') {
          severity = 'error'
        } else if (signal.severity === 'warning') {
          severity = 'warning'
        }

        // 构建退化描述
        const signalDescriptions = trend.degradationSignals.map((s) => s.description).join('\n')

        problems.push({
          id: signalId,
          source: 'agent',
          severity,
          title: this.buildTitle(signal),
          description: signal.description,
          estimatedCostChars: 2000,
          lastSeen: now,
          occurrenceCount: 1,
          context: {
            raw: [
              `【Agent 性能退化检测】`,
              ``,
              `检测到 ${trend.degradationSignals.length} 个退化信号：`,
              signalDescriptions,
              ``,
              `当前性能概览（最近 ${trend.current.totalRounds} 轮）：`,
              `- 成功率: ${(trend.current.successRate * 100).toFixed(1)}%`,
              `- 情感分数: ${(trend.current.avgSentiment * 100).toFixed(1)}%`,
              `- 平均延迟: ${trend.current.avgDurationMs.toFixed(0)}ms`,
              `- 工具调用/轮: ${trend.current.avgToolCalls.toFixed(1)}`,
              `- 中断率: ${(trend.current.interruptionRate * 100).toFixed(1)}%`,
              ...(trend.previous
                ? [
                    ``,
                    `对比基准（前 ${trend.previous.totalRounds} 轮）：`,
                    `- 成功率: ${(trend.previous.successRate * 100).toFixed(1)}%`,
                    `- 情感分数: ${(trend.previous.avgSentiment * 100).toFixed(1)}%`,
                    `- 平均延迟: ${trend.previous.avgDurationMs.toFixed(0)}ms`,
                  ]
                : []),
            ].join('\n'),
            metadata: {
              type: signal.type,
              severity: signal.severity,
              currentSuccessRate: String(trend.current.successRate),
              previousSuccessRate: String(trend.previous?.successRate ?? ''),
              currentSentiment: String(trend.current.avgSentiment),
              previousSentiment: String(trend.previous?.avgSentiment ?? ''),
              currentDurationMs: String(trend.current.avgDurationMs),
              previousDurationMs: String(trend.previous?.avgDurationMs ?? ''),
              currentInterruptionRate: String(trend.current.interruptionRate),
              previousInterruptionRate: String(trend.previous?.interruptionRate ?? ''),
              windowRounds: String(this.agentMonitor.count),
            },
          },
        })
      }

      if (problems.length > 0) {
        log('INFO', 'agent_perf_collector_problems', { count: problems.length })
      }
    } catch (err: any) {
      log('ERROR', 'agent_perf_collector_error', { error: err.message })
    }

    return problems
  }

  private buildTitle(signal: TrendAnalysis['degradationSignals'][0]): string {
    switch (signal.type) {
      case 'success_rate':
        return 'Agent 对话成功率持续下降'
      case 'sentiment':
        return '用户情感分数持续走低'
      case 'latency':
        return 'Agent 响应延迟显著增加'
      case 'interruption':
        return '用户频繁中断对话'
      default:
        return `Agent 性能退化：${signal.type}`
    }
  }
}
