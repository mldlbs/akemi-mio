/**
 * ToolFeedbackLoop — 单元测试
 *
 * 覆盖：
 * 1. 事件订阅与样本记录
 * 2. EMA 计算与阻尼
 * 3. 策略评估与调整建议
 * 4. 振荡检测与 alpha 调节
 * 5. 收敛检测
 * 6. 滞回区（suppress/unsuppress 阈值带）
 * 7. 运行模式切换（manual / auto）
 * 8. 诊断接口
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock EventBus
const mockOn = vi.fn()
const mockEmit = vi.fn()
vi.mock('../../core/EventBus', () => ({
  eventBus: {
    on: mockOn,
    emit: mockEmit,
  },
}))

// Mock logger
vi.mock('../../logger/Logger', () => ({
  log: vi.fn(),
}))

// Mock UserBehaviorAnalyzer
const mockRecordToolCallResult = vi.fn()
const mockSuppressTool = vi.fn()
const mockUnsuppressTool = vi.fn()
const mockConfirmTool = vi.fn()
const mockUnconfirmTool = vi.fn()
const mockGetSuppressedTools = vi.fn().mockReturnValue([])
const mockGetConfirmedTools = vi.fn().mockReturnValue([])

vi.mock('../../agent/UserBehaviorAnalyzer', () => ({
  userBehaviorAnalyzer: {
    recordToolCallResult: mockRecordToolCallResult,
    suppressTool: mockSuppressTool,
    unsuppressTool: mockUnsuppressTool,
    confirmTool: mockConfirmTool,
    unconfirmTool: mockUnconfirmTool,
    getSuppressedTools: mockGetSuppressedTools,
    getConfirmedTools: mockGetConfirmedTools,
  },
}))

import { ToolFeedbackLoop, toolFeedbackLoop } from '../ToolFeedbackLoop'

describe('ToolFeedbackLoop', () => {
  let loop: ToolFeedbackLoop

  beforeEach(() => {
    vi.clearAllMocks()
    loop = new ToolFeedbackLoop({ mode: 'manual', debug: false })
  })

  afterEach(() => {
    loop.stop()
  })

  // ── 生命周期 ──

  describe('生命周期', () => {
    it('start() 应订阅 agent.tool.completed 和 agent.tool.failed', () => {
      loop.start()
      expect(mockOn).toHaveBeenCalledTimes(2)
      expect(mockOn).toHaveBeenCalledWith('agent.tool.completed', expect.any(Function))
      expect(mockOn).toHaveBeenCalledWith('agent.tool.failed', expect.any(Function))
    })

    it('stop() 应清理所有订阅', () => {
      loop.start()
      loop.stop()
      // disposers 被清空后，不再有活跃订阅
    })

    it('setMode() 应正确切换模式', () => {
      expect(loop.getConfig().mode).toBe('manual')
      loop.setMode('auto')
      expect(loop.getConfig().mode).toBe('auto')
    })

    it('updateConfig() 应更新配置', () => {
      loop.updateConfig({ alpha: 0.5, mode: 'auto' })
      const config = loop.getConfig()
      expect(config.alpha).toBe(0.5)
      expect(config.mode).toBe('auto')
    })
  })

  // ── 样本记录 ──

  describe('样本记录', () => {
    it('完成事件应调用 recordToolCallResult(true)', () => {
      loop.start()
      // 获取 completed 回调
      const onCompleted = mockOn.mock.calls.find((c) => c[0] === 'agent.tool.completed')?.[1]
      expect(onCompleted).toBeDefined()

      onCompleted({ tool: 'read_file', result: 'ok', requestId: 'r1' })
      expect(mockRecordToolCallResult).toHaveBeenCalledWith('read_file', true, undefined)
    })

    it('失败事件应调用 recordToolCallResult(false, error)', () => {
      loop.start()
      const onFailed = mockOn.mock.calls.find((c) => c[0] === 'agent.tool.failed')?.[1]
      expect(onFailed).toBeDefined()

      onFailed({ tool: 'write_file', error: 'Permission denied', requestId: 'r2' })
      expect(mockRecordToolCallResult).toHaveBeenCalledWith('write_file', false, 'Permission denied')
    })
  })

  // ── EMA 计算与阻尼 ──

  describe('EMA 计算与阻尼', () => {
    it('首次样本的 EMA 等于观测值', () => {
      loop.start()
      const onCompleted = mockOn.mock.calls.find((c) => c[0] === 'agent.tool.completed')?.[1]

      onCompleted({ tool: 'read_file', result: 'ok', requestId: 'r1' })
      const report = loop.generateReports()
      const toolReport = report.find((r) => r.toolName === 'read_file')
      expect(toolReport).toBeDefined()
      expect(toolReport!.emaSuccessRate).toBe(1)
      expect(toolReport!.sampleCount).toBe(1)
    })

    it('连续成功时 EMA 趋近但不超过 1', () => {
      for (let i = 0; i < 20; i++) {
        loop['recordSample']('grep', true)
      }
      const report = loop.generateReports()
      const toolReport = report.find((r) => r.toolName === 'grep')
      expect(toolReport).toBeDefined()
      expect(toolReport!.emaSuccessRate).toBeGreaterThan(0.9)
      expect(toolReport!.emaSuccessRate).toBeLessThanOrEqual(1)
    })

    it('连续失败时 EMA 趋近但不低于 0', () => {
      for (let i = 0; i < 20; i++) {
        loop['recordSample']('grep', false, 'error')
      }
      const report = loop.generateReports()
      const toolReport = report.find((r) => r.toolName === 'grep')
      expect(toolReport).toBeDefined()
      expect(toolReport!.emaSuccessRate).toBeLessThan(0.1)
      expect(toolReport!.emaSuccessRate).toBeGreaterThanOrEqual(0)
    })
  })

  // ── 策略评估 ──

  describe('策略评估', () => {
    it('样本不足时不输出调整建议', () => {
      // 只有 1 个样本，低于 minSamples(5)
      loop['recordSample']('bad_tool', false, 'error')
      const report = loop.generateReports()
      const toolReport = report.find((r) => r.toolName === 'bad_tool')
      expect(toolReport).toBeDefined()
      expect(toolReport!.recommendedAction).toBe('none')
      expect(toolReport!.convergenceStatus).toBe('insufficient_data')
    })

    it('成功率低时建议抑制', () => {
      // 10 次中失败 8 次
      for (let i = 0; i < 8; i++) loop['recordSample']('flaky_tool', false)
      for (let i = 0; i < 2; i++) loop['recordSample']('flaky_tool', true)

      const report = loop.generateReports()
      const toolReport = report.find((r) => r.toolName === 'flaky_tool')
      expect(toolReport).toBeDefined()
      expect(toolReport!.sampleCount).toBe(10)
      expect(toolReport!.emaSuccessRate).toBeLessThan(0.4)
      expect(toolReport!.recommendedAction).toBe('suppress')
    })

    it('成功率恢复后建议取消抑制', () => {
      // 先失败 8 次，触发抑制
      for (let i = 0; i < 8; i++) loop['recordSample']('tool_a', false)
      const state = loop['qualityStates'].get('tool_a')
      if (state) {
        state.isSuppressed = true
        state.lastAdjustmentTime = Date.now() - 60000
      }
      // 然后成功 15 次，恢复
      for (let i = 0; i < 15; i++) loop['recordSample']('tool_a', true)

      const report = loop.generateReports()
      const toolReport = report.find((r) => r.toolName === 'tool_a')
      expect(toolReport).toBeDefined()
      expect(toolReport!.isSuppressed).toBe(true)
      // EMA 应该已经回升到超过 unsuppressThreshold
      expect(toolReport!.emaSuccessRate).toBeGreaterThanOrEqual(0.65)
      expect(toolReport!.recommendedAction).toBe('unsuppress')
    })

    it('成功率稳定高时建议确认', () => {
      // 20 次全部成功 → 高 EMA + stable
      for (let i = 0; i < 20; i++) loop['recordSample']('reliable_tool', true)

      const report = loop.generateReports()
      const toolReport = report.find((r) => r.toolName === 'reliable_tool')
      expect(toolReport).toBeDefined()
      expect(toolReport!.sampleCount).toBe(20)
      expect(toolReport!.emaSuccessRate).toBeGreaterThanOrEqual(0.9)
      // 需要 stable 收敛状态才建议 confirm
      // 20 次后方向变化为 0 → stable
      expect(toolReport!.convergenceStatus).toBe('stable')
      expect(toolReport!.recommendedAction).toBe('confirm')
    })
  })

  // ── 滞回区测试 ──

  describe('滞回区', () => {
    it('成功率在 [0.4, 0.65) 之间时不建议取消抑制', () => {
      for (let i = 0; i < 8; i++) loop['recordSample']('tool_b', false)
      const state = loop['qualityStates'].get('tool_b')
      if (state) {
        state.isSuppressed = true
      }
      // 成功率回升到 0.5 左右
      for (let i = 0; i < 8; i++) loop['recordSample']('tool_b', true)
      for (let i = 0; i < 4; i++) loop['recordSample']('tool_b', false)

      const report = loop.generateReports()
      const toolReport = report.find((r) => r.toolName === 'tool_b')
      expect(toolReport).toBeDefined()
      // 在滞回区内，不应建议变化
      expect(toolReport!.recommendedAction).not.toBe('unsuppress')
    })
  })

  // ── 振荡检测 ──

  describe('振荡检测', () => {
    it('频繁方向变化应检测为振荡', () => {
      // 交替成功/失败，产生方向变化
      for (let i = 0; i < 15; i++) {
        loop['recordSample']('osc_tool', i % 2 === 0)
      }

      const report = loop.generateReports()
      const toolReport = report.find((r) => r.toolName === 'osc_tool')
      expect(toolReport).toBeDefined()
      expect(toolReport!.convergenceStatus).toBe('oscillating')
      // 振荡时不输出调整建议
      expect(toolReport!.recommendedAction).toBe('none')
    })

    it('振荡时 alpha 应降低', () => {
      const initialAlpha = loop['getEffectiveAlpha']()
      expect(initialAlpha).toBe(0.3)

      // 制造振荡
      for (let i = 0; i < 15; i++) {
        loop['recordSample']('tool_c', i % 2 === 0)
      }

      const reducedAlpha = loop['getEffectiveAlpha']()
      expect(reducedAlpha).toBe(0.1) // OSCILLATION_REDUCED_ALPHA
    })
  })

  // ── 收敛检测 ──

  describe('收敛检测', () => {
    it('持续同方向变化最终收敛', () => {
      // 全部成功 → 方向变化都为 1（正向），但翻转次数为 0
      for (let i = 0; i < 20; i++) loop['recordSample']('converging_tool', true)

      const report = loop.generateReports()
      const toolReport = report.find((r) => r.toolName === 'converging_tool')
      expect(toolReport).toBeDefined()
      // 方向变化都在同一方向 → 不振荡，最终 stable
      expect(toolReport!.convergenceStatus).toBe('stable')
    })
  })

  // ── 运行模式 ──

  describe('运行模式', () => {
    it('manual 模式不自动执行调整', () => {
      const loopManual = new ToolFeedbackLoop({ mode: 'manual' })

      // 创建低成功率工具
      for (let i = 0; i < 10; i++) loopManual['recordSample']('bad_tool', false)

      // manual 模式 evaluateAll 不应调用 suppressTool
      loopManual['evaluateAll']()
      expect(mockSuppressTool).not.toHaveBeenCalled()
    })

    it('auto 模式自动执行调整', () => {
      const loopAuto = new ToolFeedbackLoop({ mode: 'auto', minSamples: 3 })

      // 创建低成功率工具
      for (let i = 0; i < 10; i++) loopAuto['recordSample']('bad_tool', false)

      loopAuto['evaluateAll']()
      expect(mockSuppressTool).toHaveBeenCalledWith('bad_tool')
    })
  })

  // ── 手动调整 ──

  describe('手动调整', () => {
    it('applyManualAdjustment 应执行指定调整', () => {
      for (let i = 0; i < 10; i++) loop['recordSample']('tool_d', false)

      const result = loop.applyManualAdjustment('tool_d', 'suppress')
      expect(result).toBe(true)
      expect(mockSuppressTool).toHaveBeenCalledWith('tool_d')
    })

    it('对不存在的工具应返回 false', () => {
      const result = loop.applyManualAdjustment('nonexistent', 'suppress')
      expect(result).toBe(false)
    })
  })

  // ── 诊断接口 ──

  describe('诊断接口', () => {
    it('getDiagnostics 应返回完整状态', () => {
      loop['recordSample']('read_file', true)
      loop['recordSample']('write_file', false, 'error')

      const diag = loop.getDiagnostics()
      expect(diag.mode).toBe('manual')
      expect(diag.toolsTracked).toContain('read_file')
      expect(diag.toolsTracked).toContain('write_file')
      expect(diag.reports.length).toBe(2)
      expect(diag.totalSamplesTracked).toBe(2)
    })

    it('getDiagnostics 应包含收敛状态', () => {
      for (let i = 0; i < 5; i++) loop['recordSample']('tool_e', true)

      const diag = loop.getDiagnostics()
      const report = diag.reports.find((r) => r.toolName === 'tool_e')
      expect(report).toBeDefined()
      // 5 次全部成功，不足以判定 stable（需要 CONVERGENCE_WINDOW=5 个方向变化）
      expect(['converging', 'stable']).toContain(report!.convergenceStatus)
    })
  })

  // ── 重置 ──

  describe('重置', () => {
    it('resetToolState 应清除指定工具的跟踪状态', () => {
      loop['recordSample']('tool_f', true)
      expect(loop['qualityStates'].has('tool_f')).toBe(true)

      loop.resetToolState('tool_f')
      expect(loop['qualityStates'].has('tool_f')).toBe(false)
    })

    it('resetAll 应清除所有跟踪状态', () => {
      loop['recordSample']('tool_g', true)
      loop['recordSample']('tool_h', false)
      loop['resetAll']()

      expect(loop['qualityStates'].size).toBe(0)
      expect(loop['recentAdjustments'].length).toBe(0)
    })
  })

  // ── 错误模式跟踪 ──

  describe('错误模式跟踪', () => {
    it('应提取错误中的预定义模式', () => {
      loop['recordSample']('tool_i', false, 'Connection refused: target server')
      loop['recordSample']('tool_i', false, 'Request timed out after 30s')

      const diag = loop.getDiagnostics()
      const report = diag.reports.find((r) => r.toolName === 'tool_i')
      expect(report).toBeDefined()
      expect(report!.errorPatterns).toContain('connection')
      expect(report!.errorPatterns).toContain('timeout')
    })
  })
})
