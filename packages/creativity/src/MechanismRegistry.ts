/**
 * MechanismRegistry — 机制版本注册表 + PromotionRequest 薄实现（机制涌现 P4，定案 D5/A5）
 *
 * 生产轴：mechanisms.jsonl 存 MechanismVersion（mechanismId/version/status active|rolled_back/
 * rollbackTo/approvedBy/submittedBy）。A5 代码级校验：Registry 写入时断言批准者≠提交者。
 * PromotionRequest：提交前硬闸复用 checkPromotionGate（stale / n<minSamples 禁止提交），
 * 批准走 pending → approved|rejected，批准时激活新版本并标旧版本 rolled_back。
 * 回滚：rolled_back 路径——当前 active 标 rolled_back（rollbackTo=目标版本），目标版本重新激活。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { checkPromotionGate, type StoppingRuleConfig, type ExperimentRun } from './ExperimentRunStore'

// ══════════════════════════════════════════
// 实体
// ══════════════════════════════════════════

export type MechanismStatus = 'active' | 'rolled_back'

export interface MechanismVersion {
  mechanismId: string
  /** 单调递增版本号，从 1 开始 */
  version: number
  status: MechanismStatus
  /** 回滚目标版本（仅 status=rolled_back 时可设，指回滚后应激活的版本） */
  rollbackTo?: number
  /** A5：批准者 agent id（≠submittedBy） */
  approvedBy: string
  /** 提交者 agent id */
  submittedBy: string
  hypothesisId?: string
  experimentRunIds?: string[]
  createdAt: number
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected'

export interface PromotionRequest {
  id: string
  mechanismId: string
  version: number
  hypothesisId?: string
  experimentRunIds: string[]
  submittedBy: string
  approvalStatus: ApprovalStatus
  approvedBy?: string
  /** 拒绝/批准的公开原因 */
  reason?: string
  createdAt: number
  decidedAt?: number
}

// ══════════════════════════════════════════
// A5 代码级校验（批准者≠提交者，写进代码不是文档）
// ══════════════════════════════════════════

/** A5：批准者必须与提交者不同，且双方非空。 */
export function canIndependentlyApprove(submittedBy: string, approvedBy: string): boolean {
  if (!submittedBy || !approvedBy) return false
  return submittedBy !== approvedBy
}

// ══════════════════════════════════════════
// 提交前硬闸（复用 P2b checkPromotionGate：A3 + A4）
// ══════════════════════════════════════════

export interface SubmitGateResult {
  allowed: boolean
  reason: string
}

/** 提交 PromotionRequest 前的硬闸检查。stale 或 n<minSamples 一律禁止提交。 */
export function checkSubmitGate(config: StoppingRuleConfig, runs: readonly ExperimentRun[], currentSnapshotId?: string): SubmitGateResult {
  const gate = checkPromotionGate(config, runs, currentSnapshotId)
  if (!gate.allowed) {
    return { allowed: false, reason: gate.reason }
  }
  return { allowed: true, reason: 'ok' }
}

// ══════════════════════════════════════════
// 文件持久化（jsonl，append-only 语义，整文件重写）
// ══════════════════════════════════════════

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  const raw = readFileSync(path, 'utf8').trim()
  if (!raw) return []
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)
}

function writeJsonl<T>(path: string, entries: readonly T[]): void {
  mkdirSync(dirname(path), { recursive: true })
  const body = entries.map((e) => JSON.stringify(e)).join('\n')
  writeFileSync(path, body ? `${body}\n` : '', 'utf8')
}

// ══════════════════════════════════════════
// MechanismRegistryStore
// ══════════════════════════════════════════

export interface SubmitPromotionInput {
  mechanismId: string
  version: number
  hypothesisId?: string
  experimentRunIds?: string[]
  submittedBy: string
}

export type SubmitResult = { ok: true; request: PromotionRequest } | { ok: false; reason: string }

export type DecideResult = { ok: true; request: PromotionRequest; activated?: MechanismVersion } | { ok: false; reason: string }

export type RollbackResult = { ok: true; rolledBack: MechanismVersion; restored: MechanismVersion } | { ok: false; reason: string }

/**
 * 薄 Registry：文件级 jsonl 存储（机制设计定稿 P4 首版，不必上数据库）。
 * 状态机：
 * - PromotionRequest: pending → approved | rejected（批准时激活版本）
 * - MechanismVersion: active | rolled_back（rolled_back 可带 rollbackTo）
 */
export class MechanismRegistryStore {
  private versions: MechanismVersion[] = []
  private requests: PromotionRequest[] = []
  private requestSeq = 0

  constructor(
    private readonly versionsPath: string,
    private readonly requestsPath?: string,
  ) {
    this.versions = readJsonl<MechanismVersion>(versionsPath)
    const reqPath = requestsPath ?? versionsPath.replace(/mechanisms\.jsonl$/, 'promotion-requests.jsonl')
    this.requests = readJsonl<PromotionRequest>(reqPath)
    // 恢复 requestSeq（幂等续号）
    for (const r of this.requests) {
      const m = /^pr-(\d+)$/.exec(r.id)
      if (m) this.requestSeq = Math.max(this.requestSeq, Number(m[1]))
    }
  }

  // ── 查询 ──

  listVersions(mechanismId?: string): MechanismVersion[] {
    if (!mechanismId) return [...this.versions]
    return this.versions.filter((v) => v.mechanismId === mechanismId)
  }

  getActive(mechanismId: string): MechanismVersion | null {
    const actives = this.versions.filter((v) => v.mechanismId === mechanismId && v.status === 'active')
    // 防御：多 active 取最高版本
    if (actives.length === 0) return null
    return actives.reduce((a, b) => (b.version > a.version ? b : a))
  }

  getHistory(mechanismId: string): MechanismVersion[] {
    return this.versions.filter((v) => v.mechanismId === mechanismId).sort((a, b) => a.version - b.version)
  }

  listRequests(status?: ApprovalStatus): PromotionRequest[] {
    if (!status) return [...this.requests]
    return this.requests.filter((r) => r.approvalStatus === status)
  }

  getRequest(id: string): PromotionRequest | null {
    return this.requests.find((r) => r.id === id) ?? null
  }

  // ── 提交（Pending） ──

  /**
   * 提交 PromotionRequest。
   * 硬闸：stale / snapshot_mismatch / below_min_samples 一律拒绝（复用 checkSubmitGate）。
   * A5 双人：提交时不做批准校验（批准时校验）。
   */
  submit(input: SubmitPromotionInput, gate: SubmitGateResult): SubmitResult {
    if (!gate.allowed) {
      return { ok: false, reason: gate.reason }
    }
    if (!input.mechanismId || !input.submittedBy) {
      return { ok: false, reason: 'invalid_input' }
    }
    if (!Number.isInteger(input.version) || input.version < 1) {
      return { ok: false, reason: 'invalid_version' }
    }
    // 拒绝重复 pending（同 mechanismId+version）
    const dup = this.requests.find(
      (r) => r.mechanismId === input.mechanismId && r.version === input.version && r.approvalStatus === 'pending',
    )
    if (dup) {
      return { ok: false, reason: 'duplicate_pending' }
    }
    this.requestSeq += 1
    const request: PromotionRequest = {
      id: `pr-${this.requestSeq}`,
      mechanismId: input.mechanismId,
      version: input.version,
      hypothesisId: input.hypothesisId,
      experimentRunIds: input.experimentRunIds ?? [],
      submittedBy: input.submittedBy,
      approvalStatus: 'pending',
      createdAt: Date.now(),
    }
    this.requests.push(request)
    this.persistRequests()
    return { ok: true, request }
  }

  // ── 批准（A5 双人校验 + 激活版本） ──

  /**
   * 批准 PromotionRequest。
   * A5 代码级校验：批准者必须≠提交者（写进代码不是文档）。
   * 批准成功：写入 MechanismVersion active，旧 active 标 rolled_back。
   */
  approve(requestId: string, approvedBy: string, now = Date.now()): DecideResult {
    const req = this.requests.find((r) => r.id === requestId)
    if (!req) return { ok: false, reason: 'request_not_found' }
    if (req.approvalStatus !== 'pending') {
      return { ok: false, reason: 'not_pending' }
    }
    // A5：批准者≠提交者（代码级）
    if (!canIndependentlyApprove(req.submittedBy, approvedBy)) {
      return { ok: false, reason: 'self_approval_forbidden' }
    }

    // 标记旧 active → rolled_back（回滚目标=本版本）
    const previous = this.getActive(req.mechanismId)
    if (previous) {
      previous.status = 'rolled_back'
      previous.rollbackTo = req.version
    }

    // 写入新 active 版本
    const version: MechanismVersion = {
      mechanismId: req.mechanismId,
      version: req.version,
      status: 'active',
      approvedBy,
      submittedBy: req.submittedBy,
      hypothesisId: req.hypothesisId,
      experimentRunIds: req.experimentRunIds,
      createdAt: now,
    }
    this.versions.push(version)

    req.approvalStatus = 'approved'
    req.approvedBy = approvedBy
    req.decidedAt = now
    this.persistVersions()
    this.persistRequests()
    return { ok: true, request: req, activated: version }
  }

  // ── 拒绝 ──

  reject(requestId: string, approvedBy: string, reason: string, now = Date.now()): DecideResult {
    const req = this.requests.find((r) => r.id === requestId)
    if (!req) return { ok: false, reason: 'request_not_found' }
    if (req.approvalStatus !== 'pending') {
      return { ok: false, reason: 'not_pending' }
    }
    req.approvalStatus = 'rejected'
    req.approvedBy = approvedBy
    req.reason = reason
    req.decidedAt = now
    this.persistRequests()
    return { ok: true, request: req }
  }

  // ── 回滚 ──

  /**
   * 回滚：当前 active 标 rolled_back（rollbackTo=目标版本），目标版本重新激活。
   * 生产观察恶化触发重评估 → 调用本方法回到 rollbackTo 指定的历史版本。
   */
  rollback(mechanismId: string, now = Date.now()): RollbackResult {
    const current = this.getActive(mechanismId)
    if (!current) {
      return { ok: false, reason: 'no_active_version' }
    }
    const history = this.getHistory(mechanismId)
    // 找目标：当前版本之前最高的历史版本
    const target = history
      .filter((v) => v.version < current.version)
      .reduce<MechanismVersion | null>((acc, v) => (!acc || v.version > acc.version ? v : acc), null)
    if (!target) {
      return { ok: false, reason: 'no_rollback_target' }
    }

    // 当前 → rolled_back
    current.status = 'rolled_back'
    current.rollbackTo = target.version

    // 目标 → 重新激活（更新 status；不动 createdAt 保留审计）
    target.status = 'active'
    target.approvedBy = current.approvedBy // 沿用原批准者（审计不改）

    this.persistVersions()
    return { ok: true, rolledBack: current, restored: target }
  }

  // ── 持久化 ──

  private persistVersions(): void {
    writeJsonl(this.versionsPath, this.versions)
  }

  private persistRequests(): void {
    const reqPath = this.requestsPath ?? this.versionsPath.replace(/mechanisms\.jsonl$/, 'promotion-requests.jsonl')
    writeJsonl(reqPath, this.requests)
  }
}
