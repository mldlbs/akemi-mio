/**
 * ActionRegistry 和 ActionPlanner 的测试
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ActionRegistry } from '../ActionRegistry'
import { plan as planActions } from '../ActionPlanner'

// Mock fs and config paths
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
}))

vi.mock('../../config', () => ({
  WORKSPACE: { evolution: '/mock/evolution_workspace' },
}))

vi.mock('../../logger/Logger', () => ({
  log: vi.fn(),
}))

vi.mock('../../core/EventBus', () => ({
  eventBus: { emit: vi.fn() },
}))

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs'

describe('ActionRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('fix_config', () => {
    it('should fix a drifted config value', async () => {
      ;(existsSync as any).mockReturnValue(true)
      ;(readFileSync as any).mockReturnValue(JSON.stringify({ historyMaxEntries: 3, savedAt: 123 }))

      const action = ActionRegistry.get('fix_config')
      expect(action).toBeDefined()
      expect(action!.category).toBe('config_fix')

      const result = await action!.run({ key: 'historyMaxEntries', value: 10 })
      expect(result.success).toBe(true)
      expect(result.summary).toContain('historyMaxEntries')
      expect(result.summary).toContain('3')
      expect(result.summary).toContain('10')

      // Verify writeFileSync was called with the fixed config
      expect(writeFileSync).toHaveBeenCalled()
      const writeCall = (writeFileSync as any).mock.calls[0]
      const written = JSON.parse(writeCall[1])
      expect(written.historyMaxEntries).toBe(10)
      expect(written.configDriftHistory).toBeDefined()
    })

    it('should skip if value is already correct', async () => {
      ;(existsSync as any).mockReturnValue(true)
      ;(readFileSync as any).mockReturnValue(JSON.stringify({ historyMaxEntries: 10 }))

      const action = ActionRegistry.get('fix_config')
      const result = await action!.run({ key: 'historyMaxEntries', value: 10 })
      expect(result.success).toBe(true)
      expect(result.summary).toContain('已经是期望值')
      expect(writeFileSync).not.toHaveBeenCalled()
    })

    it('should handle missing file', async () => {
      ;(existsSync as any).mockReturnValue(false)

      const action = ActionRegistry.get('fix_config')
      const result = await action!.run({ key: 'historyMaxEntries', value: 10 })
      expect(result.success).toBe(false)
      expect(result.summary).toContain('不存在')
    })
  })

  describe('batch_fix_config', () => {
    it('should fix all drifted configs', async () => {
      ;(existsSync as any).mockReturnValue(true)
      ;(readFileSync as any).mockReturnValue(
        JSON.stringify({
          promptTrimMode: false,
          historyMaxEntries: 3,
          analysisTimeoutMs: 120000,
          analysisStuckTimeoutMs: 60000,
          savedAt: 123,
        }),
      )

      const action = ActionRegistry.get('batch_fix_config')
      const result = await action!.run({})
      expect(result.success).toBe(true)
      expect(result.details.corrected).toBeGreaterThanOrEqual(1)
      expect(writeFileSync).toHaveBeenCalled()
    })
  })

  describe('verify_state', () => {
    it('should detect drifts', async () => {
      ;(existsSync as any).mockReturnValue(true)
      ;(readFileSync as any).mockReturnValue(JSON.stringify({ historyMaxEntries: 3 }))

      const action = ActionRegistry.get('verify_state')
      const result = await action!.run({})
      expect(result.success).toBe(true)
      expect(result.details.drifted).toBe(true)
    })

    it('should report clean state', async () => {
      ;(existsSync as any).mockReturnValue(true)
      ;(readFileSync as any).mockReturnValue(
        JSON.stringify({
          promptTrimMode: true,
          analysisStuckTimeoutMs: 30000,
          analysisTimeoutMs: 150000,
          historyMaxEntries: 10,
        }),
      )

      const action = ActionRegistry.get('verify_state')
      const result = await action!.run({})
      expect(result.success).toBe(true)
      expect(result.details.drifted).toBe(false)
    })
  })

  describe('executeSequence', () => {
    it('should execute multiple actions in order', async () => {
      ;(existsSync as any).mockReturnValue(true)
      ;(readFileSync as any).mockReturnValue(
        JSON.stringify({
          promptTrimMode: false,
          historyMaxEntries: 3,
          savedAt: 123,
        }),
      )

      const results = await ActionRegistry.executeSequence([
        { name: 'fix_config', params: { key: 'historyMaxEntries', value: 10 } },
        { name: 'fix_config', params: { key: 'promptTrimMode', value: true } },
      ])

      expect(results).toHaveLength(2)
      expect(results[0].success).toBe(true)
      expect(results[1].success).toBe(true)
    })

    it('should stop on failure', async () => {
      ;(existsSync as any).mockReturnValue(true)
      ;(readFileSync as any).mockReturnValue(JSON.stringify({ savedAt: 123 }))

      const results = await ActionRegistry.executeSequence([
        { name: 'run_script', params: { script: 'nonexistent.mjs' } },
        { name: 'fix_config', params: { key: 'historyMaxEntries', value: 10 } },
      ])

      expect(results).toHaveLength(1)
      expect(results[0].success).toBe(false)
    })

    it('should list registered actions', () => {
      const actions = ActionRegistry.list()
      expect(actions.length).toBeGreaterThan(0)

      const names = actions.map((a) => a.name)
      expect(names).toContain('fix_config')
      expect(names).toContain('run_script')
      expect(names).toContain('batch_fix_config')
      expect(names).toContain('verify_state')
    })
  })
})

describe('ActionPlanner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should plan batch_fix_config when config drifts exist', () => {
    ;(existsSync as any).mockReturnValue(true)
    ;(readFileSync as any).mockReturnValue(JSON.stringify({ historyMaxEntries: 3, savedAt: 123 }))

    const result = planActions({
      success: true,
      summary: '分析完成，发现少量配置漂移',
      planCreated: false,
    })

    expect(result.actions.length).toBeGreaterThan(0)
    expect(result.actions[0].name).toBe('batch_fix_config')
  })

  it('should return empty plan when config is clean and no instructions', () => {
    ;(existsSync as any).mockReturnValue(true)
    ;(readFileSync as any).mockReturnValue(
      JSON.stringify({
        promptTrimMode: true,
        analysisStuckTimeoutMs: 30000,
        analysisTimeoutMs: 150000,
        historyMaxEntries: 10,
        savedAt: 123,
      }),
    )

    const result = planActions({
      success: true,
      summary: '系统运行正常，无需修改',
      planCreated: false,
    })

    expect(result.actions).toHaveLength(0)
  })

  it('should extract ##fix instructions from summary', () => {
    ;(existsSync as any).mockReturnValue(true)
    ;(readFileSync as any).mockReturnValue(
      JSON.stringify({
        promptTrimMode: true,
        analysisStuckTimeoutMs: 30000,
        analysisTimeoutMs: 150000,
        historyMaxEntries: 10,
        savedAt: 123,
      }),
    )

    const result = planActions({
      success: true,
      summary: ['分析完成', '##fix: analysisTimeoutMs = 180000', '##fix: promptTrimMode = false'].join('\n'),
      planCreated: false,
    })

    expect(result.actions.length).toBeGreaterThan(0)
    const fixActions = result.actions.filter((a) => a.name === 'fix_config')
    expect(fixActions.length).toBeGreaterThan(0)
  })

  it('should run config-watchdog as default when plan created', () => {
    ;(existsSync as any).mockReturnValue(true)
    ;(readFileSync as any).mockReturnValue(
      JSON.stringify({
        promptTrimMode: true,
        analysisStuckTimeoutMs: 30000,
        analysisTimeoutMs: 150000,
        historyMaxEntries: 10,
        savedAt: 123,
      }),
    )
    // Mock that config-watchdog.mjs exists
    ;(readdirSync as any).mockReturnValue(['config-watchdog.mjs'])

    const result = planActions({
      success: true,
      summary: '需要创建新计划来实现架构改进',
      planCreated: true,
    })

    expect(result.actions.length).toBeGreaterThan(0)
    expect(result.actions[0].name).toBe('run_config_watchdog')
  })

  it('should cap actions at 3 max', () => {
    ;(existsSync as any).mockReturnValue(true)
    ;(readdirSync as any).mockReturnValue(['config-watchdog.mjs'])

    const result = planActions({
      success: true,
      summary: [
        '分析完成，发现多个修复点',
        '##fix: promptTrimMode = true',
        '##fix: historyMaxEntries = 10',
        '##fix: analysisTimeoutMs = 150000',
        '##fix: analysisStuckTimeoutMs = 30000',
      ].join('\n'),
      planCreated: false,
    })

    expect(result.actions.length).toBeLessThanOrEqual(3)
  })
})
