import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MechanismRegistryStore, canIndependentlyApprove, checkSubmitGate } from '@akemi-mio/creativity/MechanismRegistry'
import type { ExperimentRun } from '@akemi-mio/creativity/ExperimentRunStore'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mio-mech-reg-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function makeRuns(n: number, overrides: Partial<ExperimentRun> = {}): ExperimentRun[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `run-${i}`,
    assignment: 'candidate' as const,
    outcome: 'success' as const,
    metrics: {},
    evidenceIds: [],
    createdAt: Date.now(),
    ...overrides,
  }))
}

function newStore(): MechanismRegistryStore {
  return new MechanismRegistryStore(join(tmpDir, 'mechanisms.jsonl'))
}

describe('MechanismRegistryStore — 提交硬闸（stale / n<minSamples 禁止提交）', () => {
  it('n < minSamples 时 checkSubmitGate 拒绝', () => {
    const gate = checkSubmitGate({ minSamples: 30 }, makeRuns(5))
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toBe('below_min_samples')
  })

  it('stale run 时 checkSubmitGate 拒绝', () => {
    const runs = makeRuns(30, { stale: true })
    const gate = checkSubmitGate({ minSamples: 30 }, runs)
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toBe('stale_snapshot')
  })

  it('snapshot mismatch 时 checkSubmitGate 拒绝', () => {
    const runs = makeRuns(30, { baseSnapshotId: 'old-snap' })
    const gate = checkSubmitGate({ minSamples: 30 }, runs, 'new-snap')
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toBe('snapshot_mismatch')
  })

  it('n>=minSamples 且无 stale → 允许提交', () => {
    const gate = checkSubmitGate({ minSamples: 30 }, makeRuns(30))
    expect(gate.allowed).toBe(true)
  })

  it('submit 时 gate 不允许 → 拒绝且不创建请求', () => {
    const store = newStore()
    const result = store.submit({ mechanismId: 'm1', version: 1, submittedBy: 'alice' }, { allowed: false, reason: 'below_min_samples' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('below_min_samples')
    expect(store.listRequests()).toHaveLength(0)
  })

  it('submit 时 gate 允许 → 创建 pending 请求', () => {
    const store = newStore()
    const result = store.submit(
      { mechanismId: 'm1', version: 1, submittedBy: 'alice', experimentRunIds: ['r1', 'r2'] },
      { allowed: true, reason: 'ok' },
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.request.approvalStatus).toBe('pending')
      expect(result.request.id).toMatch(/^pr-\d+$/)
    }
  })

  it('重复 pending 提交被拒（duplicate_pending）', () => {
    const store = newStore()
    const gate = { allowed: true, reason: 'ok' }
    store.submit({ mechanismId: 'm1', version: 1, submittedBy: 'alice' }, gate)
    const dup = store.submit({ mechanismId: 'm1', version: 1, submittedBy: 'bob' }, gate)
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.reason).toBe('duplicate_pending')
  })
})

describe('A5 代码级校验 — 批准者≠提交者', () => {
  it('canIndependentlyApprove：相同 agent → false', () => {
    expect(canIndependentlyApprove('alice', 'alice')).toBe(false)
  })

  it('canIndependentlyApprove：不同 agent → true', () => {
    expect(canIndependentlyApprove('alice', 'bob')).toBe(true)
  })

  it('canIndependentlyApprove：空串 → false', () => {
    expect(canIndependentlyApprove('', 'bob')).toBe(false)
    expect(canIndependentlyApprove('alice', '')).toBe(false)
  })

  it('approve 时自批被拒（self_approval_forbidden）', () => {
    const store = newStore()
    const submit = store.submit({ mechanismId: 'm1', version: 1, submittedBy: 'alice' }, { allowed: true, reason: 'ok' })
    expect(submit.ok).toBe(true)
    if (!submit.ok) return

    const result = store.approve(submit.request.id, 'alice')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('self_approval_forbidden')
    // 仍是 pending
    expect(store.getRequest(submit.request.id)?.approvalStatus).toBe('pending')
  })

  it('approve 时不同 agent 批准成功，版本激活', () => {
    const store = newStore()
    const submit = store.submit({ mechanismId: 'm1', version: 1, submittedBy: 'alice' }, { allowed: true, reason: 'ok' })
    expect(submit.ok).toBe(true)
    if (!submit.ok) return

    const result = store.approve(submit.request.id, 'bob')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.request.approvalStatus).toBe('approved')
      expect(result.activated).toBeDefined()
      expect(result.activated?.status).toBe('active')
      expect(result.activated?.approvedBy).toBe('bob')
    }
    expect(store.getActive('m1')).not.toBeNull()
  })
})

describe('MechanismRegistryStore — 状态机（pending→approved/rejected）', () => {
  it('reject 后不可再 approve', () => {
    const store = newStore()
    const submit = store.submit({ mechanismId: 'm1', version: 1, submittedBy: 'alice' }, { allowed: true, reason: 'ok' })
    expect(submit.ok).toBe(true)
    if (!submit.ok) return

    const rejected = store.reject(submit.request.id, 'bob', 'not_ready')
    expect(rejected.ok).toBe(true)
    expect(store.getRequest(submit.request.id)?.approvalStatus).toBe('rejected')

    const late = store.approve(submit.request.id, 'bob')
    expect(late.ok).toBe(false)
    if (!late.ok) expect(late.reason).toBe('not_pending')
  })

  it('approve 后不可再 approve', () => {
    const store = newStore()
    const submit = store.submit({ mechanismId: 'm1', version: 1, submittedBy: 'alice' }, { allowed: true, reason: 'ok' })
    expect(submit.ok).toBe(true)
    if (!submit.ok) return

    store.approve(submit.request.id, 'bob')
    const again = store.approve(submit.request.id, 'carol')
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.reason).toBe('not_pending')
  })

  it('多个 pending 并存（不同版本），审批互不干扰', () => {
    const store = newStore()
    const gate = { allowed: true, reason: 'ok' }
    const s1 = store.submit({ mechanismId: 'm1', version: 1, submittedBy: 'alice' }, gate)
    const s2 = store.submit({ mechanismId: 'm1', version: 2, submittedBy: 'alice' }, gate)
    expect(s1.ok).toBe(true)
    expect(s2.ok).toBe(true)
    if (!s1.ok || !s2.ok) return

    // 批准 v2 → v2 active
    const a2 = store.approve(s2.request.id, 'bob')
    expect(a2.ok).toBe(true)
    expect(store.getActive('m1')?.version).toBe(2)

    // 拒绝 v1（仍 pending，未被激活）
    const r1 = store.reject(s1.request.id, 'bob', 'superseded')
    expect(r1.ok).toBe(true)
    expect(store.getActive('m1')?.version).toBe(2)
  })
})

describe('MechanismRegistryStore — 回滚路径（rolled_back → rollbackTo）', () => {
  function setupTwoVersions(): MechanismRegistryStore {
    const store = newStore()
    const gate = { allowed: true, reason: 'ok' }
    // v1
    const s1 = store.submit({ mechanismId: 'm1', version: 1, submittedBy: 'alice' }, gate)
    if (s1.ok) store.approve(s1.request.id, 'bob')
    // v2
    const s2 = store.submit({ mechanismId: 'm1', version: 2, submittedBy: 'alice' }, gate)
    if (s2.ok) store.approve(s2.request.id, 'bob')
    return store
  }

  it('v2 激活后 v1 变为 rolled_back', () => {
    const store = setupTwoVersions()
    const history = store.getHistory('m1')
    expect(history).toHaveLength(2)
    const v1 = history.find((v) => v.version === 1)
    const v2 = history.find((v) => v.version === 2)
    expect(v1?.status).toBe('rolled_back')
    expect(v1?.rollbackTo).toBe(2)
    expect(v2?.status).toBe('active')
  })

  it('rollback：v2 rolled_back，v1 恢复 active', () => {
    const store = setupTwoVersions()
    const result = store.rollback('m1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.rolledBack.version).toBe(2)
      expect(result.rolledBack.status).toBe('rolled_back')
      expect(result.rolledBack.rollbackTo).toBe(1)
      expect(result.restored.version).toBe(1)
      expect(result.restored.status).toBe('active')
    }
    expect(store.getActive('m1')?.version).toBe(1)
  })

  it('rollback 无 active → 拒绝', () => {
    const store = newStore()
    const result = store.rollback('unknown-mech')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('no_active_version')
  })

  it('rollback 只有 v1 无更早版本 → 拒绝', () => {
    const store = newStore()
    const s1 = store.submit({ mechanismId: 'm1', version: 1, submittedBy: 'alice' }, { allowed: true, reason: 'ok' })
    if (s1.ok) store.approve(s1.request.id, 'bob')
    const result = store.rollback('m1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('no_rollback_target')
  })

  it('rollback 后可再次 approve 新版本（v3）', () => {
    const store = setupTwoVersions()
    store.rollback('m1')
    const gate = { allowed: true, reason: 'ok' }
    const s3 = store.submit({ mechanismId: 'm1', version: 3, submittedBy: 'alice' }, gate)
    expect(s3.ok).toBe(true)
    if (!s3.ok) return
    const a3 = store.approve(s3.request.id, 'bob')
    expect(a3.ok).toBe(true)
    expect(store.getActive('m1')?.version).toBe(3)
  })
})

describe('MechanismRegistryStore — 持久化（jsonl 文件）', () => {
  it('submit/approve 后重新加载，状态一致', () => {
    const path = join(tmpDir, 'mechanisms.jsonl')
    const store = new MechanismRegistryStore(path)
    const gate = { allowed: true, reason: 'ok' }
    const s1 = store.submit({ mechanismId: 'm1', version: 1, submittedBy: 'alice', experimentRunIds: ['r1'] }, gate)
    expect(s1.ok).toBe(true)
    if (!s1.ok) return
    store.approve(s1.request.id, 'bob')

    // 重新加载
    const reloaded = new MechanismRegistryStore(path)
    expect(reloaded.getActive('m1')?.version).toBe(1)
    expect(reloaded.getActive('m1')?.approvedBy).toBe('bob')
    expect(reloaded.getRequest(s1.request.id)?.approvalStatus).toBe('approved')
  })

  it('rollback 后重新加载，rolled_back/active 状态一致', () => {
    const path = join(tmpDir, 'mechanisms.jsonl')
    const store = new MechanismRegistryStore(path)
    const gate = { allowed: true, reason: 'ok' }
    const s1 = store.submit({ mechanismId: 'm1', version: 1, submittedBy: 'alice' }, gate)
    if (s1.ok) store.approve(s1.request.id, 'bob')
    const s2 = store.submit({ mechanismId: 'm1', version: 2, submittedBy: 'alice' }, gate)
    if (s2.ok) store.approve(s2.request.id, 'bob')
    store.rollback('m1')

    const reloaded = new MechanismRegistryStore(path)
    expect(reloaded.getActive('m1')?.version).toBe(1)
    const v2 = reloaded.getHistory('m1').find((v) => v.version === 2)
    expect(v2?.status).toBe('rolled_back')
    expect(v2?.rollbackTo).toBe(1)
  })
})
