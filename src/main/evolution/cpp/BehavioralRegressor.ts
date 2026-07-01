/**
 * BehavioralRegressor — 输出分布偏移检测（Dimension 6）
 *
 * v0 使用滑动窗口（最近 N 次执行）对比总体 successRate，
 * 检测行为回归趋势。不依赖真实 embedding，仅做统计比较。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { WORKSPACE } from '../../config/index'
import { log } from '../../logger/Logger'
import type { Capability } from '../CapabilityRegistry'

// —── Types ──────────────────────────────────────────────

export interface RegressorResult {
  passed: boolean
  shift: number
  trend: 'stable' | 'declining' | 'improving'
  detail: string
}

interface Observation {
  successRate: number
  latency: number
  timestamp: number
}

const OBSERVATIONS_DIR = join(WORKSPACE.evolution, 'cpp', 'regressor')
const SHIFT_THRESHOLD = 0.15
const DEFAULT_WINDOW_SIZE = 5

// —── BehavioralRegressor ────────────────────────────────

export class BehavioralRegressor {
  private windowSize: number
  private observations = new Map<string, Observation[]>()

  constructor(windowSize?: number) {
    this.windowSize = windowSize ?? DEFAULT_WINDOW_SIZE
    this.loadObservations()
  }

  /** 评估单个能力的回归状态 */
  evaluate(capability: Capability): RegressorResult {
    const obs = this.observations.get(capability.id) || []
    if (obs.length < this.windowSize || capability.usageCount < this.windowSize) {
      return { passed: true, shift: 0, trend: 'stable', detail: '数据不足，跳过回归检测' }
    }

    const recent = obs.slice(-this.windowSize)
    const recentAvg = recent.reduce((s, o) => s + o.successRate, 0) / recent.length
    const overall = capability.metrics.successRate
    const shift = Math.max(0, overall - recentAvg)

    // 趋势判定：对窗口内数据做简单线性近似
    const slope = this.estimateSlope(recent)
    let trend: RegressorResult['trend'] = 'stable'
    if (slope < -0.02) trend = 'declining'
    else if (slope > 0.02) trend = 'improving'

    const passed = shift < SHIFT_THRESHOLD
    return {
      passed,
      shift: Math.round(shift * 100) / 100,
      trend,
      detail: passed
        ? `偏移量 ${(shift * 100).toFixed(1)}% (阈值 ${SHIFT_THRESHOLD * 100}%)，${trend}`
        : `检测到回归：最近 ${this.windowSize} 次平均 ${(recentAvg * 100).toFixed(1)}% vs 整体 ${(overall * 100).toFixed(1)}%，偏移 ${(shift * 100).toFixed(1)}%`,
    }
  }

  /** 记录一次执行观测 */
  recordObservation(capabilityId: string, successRate: number, latency: number): void {
    if (!this.observations.has(capabilityId)) {
      this.observations.set(capabilityId, [])
    }
    const list = this.observations.get(capabilityId)!
    list.push({ successRate, latency, timestamp: Date.now() })
    this.persist(capabilityId, list)
  }

  // —── 内部方法 ─────────────────────────────────────

  private estimateSlope(obs: Observation[]): number {
    if (obs.length < 2) return 0
    const n = obs.length
    const indices = obs.map((_, i) => i)
    const rates = obs.map((o) => o.successRate)
    const meanX = indices.reduce((s, x) => s + x, 0) / n
    const meanY = rates.reduce((s, y) => s + y, 0) / n
    let num = 0,
      den = 0
    for (let i = 0; i < n; i++) {
      num += (indices[i] - meanX) * (rates[i] - meanY)
      den += (indices[i] - meanX) ** 2
    }
    return den === 0 ? 0 : num / den
  }

  private obsPath(id: string): string {
    return join(OBSERVATIONS_DIR, `${id}.json`)
  }

  private persist(id: string, obs: Observation[]): void {
    if (!existsSync(OBSERVATIONS_DIR)) mkdirSync(OBSERVATIONS_DIR, { recursive: true })
    writeFileSync(this.obsPath(id), JSON.stringify(obs.slice(-100)), 'utf-8')
  }

  private loadObservations(): void {
    if (!existsSync(OBSERVATIONS_DIR)) return
    try {
      const { readdirSync } = require('fs') as typeof import('fs')
      const files = readdirSync(OBSERVATIONS_DIR).filter((f: string) => f.endsWith('.json'))
      for (const file of files) {
        try {
          const id = file.replace(/\.json$/, '')
          const raw = readFileSync(this.obsPath(id), 'utf-8')
          this.observations.set(id, JSON.parse(raw) as Observation[])
        } catch {
          // skip corrupted
        }
      }
      log('INFO', 'behavioral_regressor_loaded', { count: this.observations.size })
    } catch {
      log('INFO', 'behavioral_regressor_load_skip')
    }
  }
}
