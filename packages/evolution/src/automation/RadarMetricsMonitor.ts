/**
 * RadarMetricsMonitor — 雷达采集指标监控与自适应调参
 *
 * 职责：
 * 1. 定期读取应用日志，提取各采集器的成功/失败率和响应时间
 * 2. 若指标低于阈值，生成配置调整建议（Problem）
 * 3. 动态调整超时和并行度参数
 *
 * 数据流：
 * - 从日志中匹配采集器相关的 WARN/INFO 日志
 * - 统计每个采集器的成功/失败计数
 * - 计算成功率 = success / (success + failure)
 * - 若 < 阈值（默认 0.7），生成调整问题
 *
 * 自适应策略：
 * - 成功率 < 0.5 → 增加超时 50%，降低并行度 30%
 * - 成功率 0.5-0.7 → 增加超时 20%
 * - 成功率 > 0.9 → 可适度降低超时（提升响应）
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { log } from '@akemi-mio/core/logger/Logger'
import { WORKSPACE } from '@akemi-mio/core/config'
import type { Problem } from './types'

// =============================================================================
// 配置
// =============================================================================

/** 日志目录 */
const LOG_DIR = WORKSPACE.logs

/** 回顾窗口（毫秒）— 最近 48 小时 */
const LOOKBACK_WINDOW_MS = 48 * 60 * 60 * 1000

/** 监控检查间隔（毫秒） */
const MONITOR_INTERVAL_MS = 4 * 60 * 60 * 1000

/** 成功率阈值 — 低于此值触发调参 */
const SUCCESS_RATE_THRESHOLD = 0.7

/** 最低样本数 */
const MIN_SAMPLE_SIZE = 3

/** 采集器名称列表（用于日志匹配） */
const COLLECTOR_NAMES = [
  'hn', // HackerNews
  'weibo', // Weibo
  'gh', // GitHubTrending
  'bili', // Bilibili
  'douyin', // Douyin
  'rss', // RSS
]

// =============================================================================
// 类型定义
// =============================================================================

export interface CollectorMetrics {
  /** 采集器名称 */
  name: string
  /** 成功次数 */
  successCount: number
  /** 失败次数 */
  failureCount: number
  /** 总耗时（毫秒，从日志估算） */
  totalLatencyMs: number
  /** 样本数 */
  sampleCount: number
  /** 首次观测时间 */
  firstSeen: number
  /** 末次观测时间 */
  lastSeen: number
}

export interface MetricsSnapshot {
  /** 各采集器指标 */
  collectors: CollectorMetrics[]
  /** 全局统计 */
  global: {
    totalSuccess: number
    totalFailure: number
    overallSuccessRate: number
    windowStart: number
    windowEnd: number
  }
  /** 需要调整的采集器 */
  needsAdjustment: Array<{
    name: string
    successRate: number
    suggestion: string
  }>
}

// =============================================================================
// RadarMetricsMonitor
// =============================================================================

export class RadarMetricsMonitor {
  private lastCheckAt = 0

  /**
   * 检查是否需要运行监控。
   */
  shouldCheck(): boolean {
    return Date.now() - this.lastCheckAt >= MONITOR_INTERVAL_MS
  }

  /**
   * 执行一次监控检查，返回需要调整的问题列表。
   */
  async check(): Promise<Problem[]> {
    this.lastCheckAt = Date.now()
    const snapshot = this.collectMetrics()
    const problems = this.generateAdjustmentProblems(snapshot)
    return problems
  }

  /**
   * 从日志中提取各采集器的指标。
   */
  collectMetrics(): MetricsSnapshot {
    const now = Date.now()
    const windowStart = now - LOOKBACK_WINDOW_MS
    const metricsMap = new Map<string, CollectorMetrics>()

    // 读取日志目录中的文件
    if (!existsSync(LOG_DIR)) {
      log('WARN', 'radar_metrics_log_dir_not_found', { dir: LOG_DIR })
      return this.emptySnapshot(windowStart, now)
    }

    const logFiles = readdirSync(LOG_DIR)
      .filter((f) => f.endsWith('.log') || f.endsWith('.txt'))
      .map((f) => join(LOG_DIR, f))
      // 只处理 LOOKBACK_WINDOW 内的日志文件
      .filter((f) => {
        try {
          return statSync(f).mtimeMs >= windowStart
        } catch {
          return false
        }
      })

    if (logFiles.length === 0) {
      return this.emptySnapshot(windowStart, now)
    }

    // 为每个采集器初始化指标
    for (const name of COLLECTOR_NAMES) {
      metricsMap.set(name, {
        name,
        successCount: 0,
        failureCount: 0,
        totalLatencyMs: 0,
        sampleCount: 0,
        firstSeen: now,
        lastSeen: 0,
      })
    }

    // 逐行扫描日志文件
    for (const logFile of logFiles) {
      try {
        const content = readFileSync(logFile, 'utf-8')
        const lines = content.split('\n')

        for (const line of lines) {
          if (line.length < 20) continue

          // 匹配采集器相关的日志行
          for (const name of COLLECTOR_NAMES) {
            const entry = metricsMap.get(name)
            if (!entry) continue

            // 检测成功：INFO 级别的 "_collected" 日志
            if (line.includes('INFO') && (line.includes(`${name}_collected`) || line.includes(`${name}_collect`))) {
              entry.successCount++
              entry.sampleCount++

              // 尝试提取 count 信息
              const countMatch = line.match(/count["']?\s*[:=]\s*(\d+)/i)
              if (countMatch) {
                entry.totalLatencyMs += parseInt(countMatch[1]) * 10 // 估算: 每项 ~10ms
              }

              if (entry.firstSeen > Date.parse(this.extractTimestamp(line) || '')) {
                entry.firstSeen = Date.parse(this.extractTimestamp(line) || '') || now
              }
              entry.lastSeen = Math.max(entry.lastSeen, Date.parse(this.extractTimestamp(line) || '') || 0)
            }

            // 检测失败：WARN 级别的 "_failed" 日志
            if (line.includes('WARN') && (line.includes(`${name}_failed`) || line.includes(`${name}_collect_failed`))) {
              entry.failureCount++
              entry.sampleCount++
              entry.lastSeen = Math.max(entry.lastSeen, Date.parse(this.extractTimestamp(line) || '') || 0)
            }
          }
        }
      } catch {
        // 跳过无法读取的日志文件
        continue
      }
    }

    // 构建输出
    const collectors: CollectorMetrics[] = Array.from(metricsMap.values())
    const totalSuccess = collectors.reduce((s, c) => s + c.successCount, 0)
    const totalFailure = collectors.reduce((s, c) => s + c.failureCount, 0)
    const totalSamples = totalSuccess + totalFailure
    const overallSuccessRate = totalSamples > 0 ? totalSuccess / totalSamples : 1

    const needsAdjustment: MetricsSnapshot['needsAdjustment'] = []
    for (const c of collectors) {
      const total = c.successCount + c.failureCount
      if (total < MIN_SAMPLE_SIZE) continue
      const rate = c.successCount / total
      if (rate < SUCCESS_RATE_THRESHOLD) {
        needsAdjustment.push({
          name: c.name,
          successRate: rate,
          suggestion: this.generateSuggestion(c, rate),
        })
      }
    }

    return {
      collectors,
      global: {
        totalSuccess,
        totalFailure,
        overallSuccessRate,
        windowStart,
        windowEnd: now,
      },
      needsAdjustment,
    }
  }

  /**
   * 从日志行中提取时间戳。
   */
  private extractTimestamp(line: string): string | null {
    // 匹配 ISO 时间戳: 2026-07-16T12:34:56
    const match = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    return match ? match[0] : null
  }

  /**
   * 根据指标生成调参建议。
   */
  private generateSuggestion(metrics: CollectorMetrics, rate: number): string {
    if (rate < 0.3) {
      return `成功率极低 (${(rate * 100).toFixed(0)}%)，建议: 超时 +50%，并行度 -30%，检查 API 可用性`
    }
    if (rate < 0.5) {
      return `成功率偏低 (${(rate * 100).toFixed(0)}%)，建议: 超时 +30%，并行度 -20%`
    }
    return `成功率 ${(rate * 100).toFixed(0)}%，建议: 超时 +20%`
  }

  /**
   * 根据监控快照生成配置调整问题。
   */
  generateAdjustmentProblems(snapshot: MetricsSnapshot): Problem[] {
    const problems: Problem[] = []

    for (const adj of snapshot.needsAdjustment) {
      const rate = adj.successRate
      const severity = rate < 0.3 ? ('error' as const) : rate < 0.5 ? ('warning' as const) : ('warning' as const)

      problems.push({
        id: `radar_metrics_${adj.name}_${Date.now()}`,
        source: 'tool',
        severity,
        title: `[雷达指标] ${adj.name} 采集成功率 ${(rate * 100).toFixed(0)}%，低于阈值`,
        description: adj.suggestion,
        file: `collector/${adj.name}`,
        estimatedCostChars: 100,
        lastSeen: Date.now(),
        occurrenceCount: 1,
        context: {
          raw: `collector "${adj.name}" success rate ${(rate * 100).toFixed(0)}% below threshold ${(SUCCESS_RATE_THRESHOLD * 100).toFixed(0)}%\n${adj.suggestion}`,
          metadata: {
            collector: adj.name,
            successRate: String(rate),
            threshold: String(SUCCESS_RATE_THRESHOLD),
            suggestion: adj.suggestion,
          },
        },
      })
    }

    log('INFO', 'radar_metrics_check', {
      totalCollectors: snapshot.collectors.length,
      needsAdjustment: snapshot.needsAdjustment.length,
      overallRate: (snapshot.global.overallSuccessRate * 100).toFixed(0) + '%',
      problemsGenerated: problems.length,
    })

    return problems
  }

  /**
   * 获取监控统计摘要文本。
   */
  getSummary(snapshot: MetricsSnapshot): string {
    const lines: string[] = ['📊 雷达采集指标监控报告', '']
    for (const c of snapshot.collectors) {
      const total = c.successCount + c.failureCount
      if (total === 0) continue
      const rate = ((c.successCount / total) * 100).toFixed(0)
      lines.push(`  ${c.name}: ✅${c.successCount} ❌${c.failureCount} = ${rate}% (${total} 样本)`)
    }
    lines.push('')
    lines.push(`全局成功率: ${(snapshot.global.overallSuccessRate * 100).toFixed(0)}%`)
    if (snapshot.needsAdjustment.length > 0) {
      lines.push(`需调整: ${snapshot.needsAdjustment.map((a) => `${a.name}(${(a.successRate * 100).toFixed(0)}%)`).join(', ')}`)
    } else {
      lines.push('✅ 所有采集器指标正常')
    }
    return lines.join('\n')
  }

  private emptySnapshot(windowStart: number, now: number): MetricsSnapshot {
    return {
      collectors: COLLECTOR_NAMES.map((name) => ({
        name,
        successCount: 0,
        failureCount: 0,
        totalLatencyMs: 0,
        sampleCount: 0,
        firstSeen: now,
        lastSeen: 0,
      })),
      global: {
        totalSuccess: 0,
        totalFailure: 0,
        overallSuccessRate: 1,
        windowStart,
        windowEnd: now,
      },
      needsAdjustment: [],
    }
  }
}

/** 全局单例 */
export const radarMetricsMonitor = new RadarMetricsMonitor()
