/**
 * EvidenceBridge Contract Tests — Phase 2
 *
 * 验证 EvidenceBridge 作为信号出口的正确性：
 *   RegressionReport → Event
 *
 * 不验证：
 *   - SelfEvolutionService 接线
 *   - ProblemQueue 集成
 *   - EvidenceCollector 调用
 *
 * 覆盖场景：
 *   | 测试                    | 目的                    |
 *   | ----------------------- | ----------------------- |
 *   | report ready emits      | 验证事件 emit           |
 *   | payload unchanged       | 防止修改 report         |
 *   | no listener safe        | 测试解耦安全            |
 *   | null emitter            | 禁用事件时的安全行为    |
 *   | reportId 格式           | reportId 格式一致        |
 *   | bridge 不修改输入       | 不变性约束              |
 */
import { describe, it, expect, vi } from 'vitest'
import { EvidenceBridge, EVIDENCE_REPORT_READY } from '../EvidenceBridge'
import type { EvidenceReportReadyPayload } from '../EvidenceBridge'
import type { RegressionReport } from '../../../reasoning/golden/types'
import { ReportGenerator } from '../../../reasoning/golden/ReportGenerator'

const gen = new ReportGenerator()

function mockReplayResult() {
  return {
    total: 44,
    passed: 42,
    failed: 2,
    skipped: 0,
    durationMs: 1523,
    failures: [
      {
        caseId: 'Q01',
        expected: { pattern: 'cause_effect', goals: ['g1'], constraints: [], outputStyle: 'json' },
        actual: { pattern: 'hypothesis_verification', goals: ['g1'], constraints: [], outputStyle: 'json' },
        diff: 'p: cause_effect vs hypothesis_verification',
      },
    ],
    runnerVersion: '0.1',
    executedAt: '2026-07-21T19:00:00.000Z',
  }
}

function mockReport(): RegressionReport {
  return gen.generate(mockReplayResult(), { sha: 'a06e7ff', branch: 'feat/evaluation-bridge', dirty: false })
}

// =============================================================================
// 1. 事件发出验证
// =============================================================================
describe('EvidenceBridge — 事件发出', () => {
  it('bridge(report) 通过 emitter.emit 发出 evidence.report.ready', () => {
    const emit = vi.fn()
    const bridge = new EvidenceBridge({ emit })
    const report = mockReport()

    bridge.bridge(report)

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(
      EVIDENCE_REPORT_READY,
      expect.objectContaining({ reportId: expect.stringContaining('report_') }),
    )
  })

  it('payload 包含 reportId, report, generatedAt', () => {
    const calls: unknown[] = []
    const bridge = new EvidenceBridge({ emit: (event, payload) => { calls.push(payload) } })
    const report = mockReport()

    bridge.bridge(report)
    expect(calls).toHaveLength(1)

    const payload = calls[0] as EvidenceReportReadyPayload
    expect(payload.reportId).toBeTruthy()
    expect(payload.report).toBe(report)
    expect(payload.generatedAt).toBeGreaterThan(0)
  })

  it('reportId 格式为 report_{executedAt}_{sha}', () => {
    const calls: unknown[] = []
    const bridge = new EvidenceBridge({ emit: (event, payload) => { calls.push(payload) } })
    bridge.bridge(mockReport())

    const payload = calls[0] as EvidenceReportReadyPayload
    expect(payload.reportId).toMatch(/^report_\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z_[a-f0-9]+$/)
  })
})

// =============================================================================
// 2. 不变性：bridge 不修改 report
// =============================================================================
describe('EvidenceBridge — 不变性', () => {
  it('bridge 不修改输入 report', () => {
    const bridge = new EvidenceBridge({ emit: () => {} })
    const report = mockReport()
    const frozen = JSON.stringify(report)

    bridge.bridge(report)

    expect(JSON.stringify(report)).toBe(frozen)
  })

  it('payload 中的 report 引用指向原对象', () => {
    const calls: unknown[] = []
    const bridge = new EvidenceBridge({ emit: (event, payload) => { calls.push(payload) } })
    const report = mockReport()

    bridge.bridge(report)

    const payload = calls[0] as EvidenceReportReadyPayload
    expect(payload.report).toBe(report)
  })
})

// =============================================================================
// 3. 无消费者安全
// =============================================================================
describe('EvidenceBridge — 无消费者安全', () => {
  it('nullEmitter 不 throw', () => {
    const bridge = new EvidenceBridge(null) // null → nullEmitter
    expect(() => bridge.bridge(mockReport())).not.toThrow()
  })

  it('无 emitter 参数时使用 nullEmitter', () => {
    const bridge = new EvidenceBridge() // undefined → nullEmitter
    expect(() => bridge.bridge(mockReport())).not.toThrow()
  })

  it('多次 bridge 安全', () => {
    const emit = vi.fn()
    const bridge = new EvidenceBridge({ emit })
    bridge.bridge(mockReport())
    bridge.bridge(mockReport())
    bridge.bridge(mockReport())
    expect(emit).toHaveBeenCalledTimes(3)
  })
})

// =============================================================================
// 4. ReportGenerator 未受影响
// =============================================================================
describe('EvidenceBridge — ReportGenerator 未受影响', () => {
  it('ReportGenerator 仍是纯函数', () => {
    const report = gen.generate(mockReplayResult())
    const json = JSON.stringify(report)
    expect(JSON.stringify(gen.generate(mockReplayResult()))).toBe(json)
  })

  it('ReportGenerator 不需要 EventBus', () => {
    expect(gen).toBeInstanceOf(ReportGenerator)
    // 验证没有 emit 依赖
    const proto = Object.getOwnPropertyNames(ReportGenerator.prototype)
    expect(proto).not.toContain('emit')
    expect(proto).not.toContain('bridge')
  })
})
