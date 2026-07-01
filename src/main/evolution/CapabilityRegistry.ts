/**
 * CapabilityRegistry — 能力注册表（Phase 3）
 *
 * 三层结构：
 * - core/       — 系统内置能力，不可删除
 * - derived/    — 从 trace 编译衍生的能力，支持 decay/unused archive
 * - experimental/ — 沙箱中验证的候选能力
 *
 * 每个 Capability 是一个结构化 artifact，
 * 包含 executor、evaluator、metrics、dependencies。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { WORKSPACE } from '../config'
import { log } from '../logger/Logger'

// ─── Capability 定义 ──────────────────────────────────────────────

export interface Capability {
  id: string
  intent: string
  inputSchema: object
  outputSchema: object
  executor: {
    type: 'code' | 'workflow' | 'toolchain'
    body: string
  }
  dependencies: string[]
  preconditions: string[]
  evaluator: {
    type: 'test' | 'heuristic' | 'llm_judge'
    spec: string
  }
  metrics: {
    successRate: number
    latency: number
    cost: number
  }
  tier: 'core' | 'derived' | 'experimental'
  createdAt: number
  updatedAt: number
  usageCount: number
  lastUsedAt: number
}

// ─── 路径 ──────────────────────────────────────────────────────────

const CAPABILITIES_DIR = join(WORKSPACE.evolution, 'capabilities')

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

// ─── CapabilityRegistry ───────────────────────────────────────────

export class CapabilityRegistry {
  private capabilities = new Map<string, Capability>()

  constructor() {
    this.loadAll()
  }

  /** 注册一个能力（同 id 覆盖） */
  register(cap: Capability): void {
    cap.updatedAt = Date.now()
    this.capabilities.set(cap.id, cap)
    this.persist(cap)
    log('INFO', 'capability_registered', { id: cap.id, tier: cap.tier, intent: cap.intent.slice(0, 80) })
  }

  /** 按 id 获取能力 */
  get(id: string): Capability | undefined {
    return this.capabilities.get(id)
  }

  /** 按 tier 列出能力 */
  list(tier?: 'core' | 'derived' | 'experimental'): Capability[] {
    const all = Array.from(this.capabilities.values())
    if (tier) return all.filter((c) => c.tier === tier)
    return all
  }

  /** 根据意图查找匹配的能力 */
  findByIntent(intent: string): Capability[] {
    const lowered = intent.toLowerCase()
    return Array.from(this.capabilities.values()).filter(
      (c) => c.intent.toLowerCase().includes(lowered) || lowered.includes(c.intent.toLowerCase()),
    )
  }

  /** 删除一个能力（core 不可删除） */
  remove(id: string): boolean {
    const cap = this.capabilities.get(id)
    if (!cap) return false
    if (cap.tier === 'core') {
      log('WARN', 'capability_remove_core_denied', { id })
      return false
    }
    this.capabilities.delete(id)
    this.removeFile(id)
    log('INFO', 'capability_removed', { id, tier: cap.tier })
    return true
  }

  /** 使用计数 +1 */
  recordUsage(id: string): void {
    const cap = this.capabilities.get(id)
    if (!cap) return
    cap.usageCount++
    cap.lastUsedAt = Date.now()
    cap.updatedAt = Date.now()
    this.persist(cap)
  }

  /** 归档未使用的衍生能力（usageCount=0 且超过 7 天） */
  archiveUnused(): number {
    const now = Date.now()
    const cutoff = now - 7 * 24 * 60 * 60 * 1000
    let archived = 0
    for (const [id, cap] of this.capabilities) {
      if (cap.tier === 'derived' && cap.usageCount === 0 && cap.createdAt < cutoff) {
        this.capabilities.delete(id)
        this.removeFile(id)
        log('INFO', 'capability_archived', { id, intent: cap.intent.slice(0, 80) })
        archived++
      }
    }
    return archived
  }

  /** 降级低成功率的能力 */
  degradeLowSuccess(threshold = 0.4): number {
    let degraded = 0
    for (const cap of this.capabilities.values()) {
      if (cap.tier === 'core') continue
      if (cap.metrics.successRate < threshold && cap.tier !== 'experimental') {
        cap.tier = 'experimental'
        cap.updatedAt = Date.now()
        this.persist(cap)
        log('INFO', 'capability_degraded', { id: cap.id, rate: cap.metrics.successRate })
        degraded++
      }
    }
    return degraded
  }

  /** 获取统计信息 */
  getStats(): { total: number; core: number; derived: number; experimental: number } {
    const stats = { total: 0, core: 0, derived: 0, experimental: 0 }
    for (const cap of this.capabilities.values()) {
      stats.total++
      stats[cap.tier]++
    }
    return stats
  }

  // ─── 持久化 ──────────────────────────────────────────────────

  private capPath(id: string): string {
    const tier = this.capabilities.get(id)?.tier || 'experimental'
    return join(CAPABILITIES_DIR, tier, `${id}.json`)
  }

  private persist(cap: Capability): void {
    const dir = join(CAPABILITIES_DIR, cap.tier)
    ensureDir(dir)
    writeFileSync(join(dir, `${cap.id}.json`), JSON.stringify(cap, null, 2), 'utf-8')
  }

  private removeFile(id: string): void {
    try {
      const f = this.capPath(id)
      if (existsSync(f)) {
        const { unlinkSync } = require('fs') as typeof import('fs')
        unlinkSync(f)
      }
    } catch {
      // ignore
    }
  }

  /** 启动时从磁盘加载所有能力 */
  private loadAll(): void {
    for (const tier of ['core', 'derived', 'experimental'] as const) {
      const dir = join(CAPABILITIES_DIR, tier)
      if (!existsSync(dir)) continue
      try {
        const { readdirSync } = require('fs') as typeof import('fs')
        const files = readdirSync(dir).filter((f: string) => f.endsWith('.json'))
        for (const file of files) {
          try {
            const raw = readFileSync(join(dir, file), 'utf-8')
            const cap = JSON.parse(raw) as Capability
            this.capabilities.set(cap.id, cap)
          } catch {
            // skip corrupted
          }
        }
      } catch {
        // skip unreadable
      }
    }
  }
}
