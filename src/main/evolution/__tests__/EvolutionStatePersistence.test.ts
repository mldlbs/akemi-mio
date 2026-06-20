import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SelfEvolutionService } from '../SelfEvolutionService'
import type { AgentService } from '../../agent/AgentService'
import type { Scheduler } from '../../core/Scheduler'
import type { EventBus } from '../../core/EventBus'
import type { PlanManagerLike, DevPlan } from '../types'
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync, rmSync, statSync } from 'fs'
import { join, dirname } from 'path'

const TEST_STATE_DIR = join(process.cwd(), 'evolution_workspace', 'living_plan')
const TEST_STATE_PATH = join(TEST_STATE_DIR, 'evolution_state.test.json')

function createMockAgent(overrides?: Partial<AgentService>): AgentService {
  return {
    isBusy: vi.fn().mockReturnValue(false),
    runSelfTask: vi.fn().mockResolvedValue({ success: true, summary: 'test analysis done' }),
    setSuppressForceContinue: vi.fn(),
    ...overrides,
  } as unknown as AgentService
}

function createMockScheduler(): Scheduler {
  return { interval: vi.fn().mockReturnValue('task-1'), cancel: vi.fn() } as unknown as Scheduler
}

function createMockEventBus(): EventBus {
  return { emit: vi.fn(), on: vi.fn().mockReturnValue(() => {}) } as unknown as EventBus
}

function createMockPlanManager(): PlanManagerLike {
  return {
    getActivePlan: vi.fn().mockReturnValue(null),
    listPlans: vi.fn().mockReturnValue([]),
    getFormattedContext: vi.fn().mockReturnValue(''),
    completePlan: vi.fn(),
    abandonPlan: vi.fn(),
    freezePlan: vi.fn(),
    updateStep: vi.fn(),
    lock: { run: vi.fn((fn: any) => fn()) },
  } as unknown as PlanManagerLike
}

function makeService(opts?: { agent?: AgentService; statePath?: string; maxReasoning?: number; degThreshold?: number }) {
  return new SelfEvolutionService(opts?.agent ?? createMockAgent(), createMockScheduler(), createMockEventBus(), createMockPlanManager(), {
    analysisTimeoutMs: 30000,
    planExecTimeoutMs: 30000,
    stepRetryBaseMs: 100,
    maxLivingPlanBytes: 1024,
    stateFilePath: opts?.statePath ?? TEST_STATE_PATH,
    maxReasoningSteps: opts?.maxReasoning ?? 5,
    degenerationThreshold: opts?.degThreshold ?? 3,
  })
}

// =========================================================================
// State Persistence Tests — direct method calls (no tryRun dependency)
// =========================================================================

describe('State Persistence — direct', () => {
  beforeEach(() => {
    try {
      mkdirSync(TEST_STATE_DIR, { recursive: true })
    } catch {}
    try {
      unlinkSync(TEST_STATE_PATH)
    } catch {}
  })
  afterEach(() => {
    try {
      unlinkSync(TEST_STATE_PATH)
    } catch {}
  })

  it('saveState should create file with correct fields', () => {
    const svc = makeService() as any
    svc.tryRunFailures = 2
    svc.recoveryCooldownUntil = 999999
    svc.lastSuccessTime = 888888
    svc.analyzer.recordFingerprint('fp1')
    svc.saveState()

    expect(existsSync(TEST_STATE_PATH)).toBe(true)
    const state = JSON.parse(readFileSync(TEST_STATE_PATH, 'utf-8'))
    expect(state.tryRunFailures).toBe(2)
    expect(state.recoveryCooldownUntil).toBe(999999)
    expect(state.lastSuccessTime).toBe(888888)
    expect(state.fingerprints).toEqual(['fp1'])
    expect(state.savedAt).toBeGreaterThan(0)
    svc.stop()
  })

  it('loadState should restore values from file', () => {
    mkdirSync(TEST_STATE_DIR, { recursive: true })
    writeFileSync(
      TEST_STATE_PATH,
      JSON.stringify({
        tryRunFailures: 3,
        recoveryCooldownUntil: 123456,
        lastSuccessTime: 789012,
        recentAnalysisFingerprints: ['a', 'b', 'c'],
        savedAt: Date.now(),
      }),
      'utf-8',
    )

    const svc = makeService() as any
    expect(svc.tryRunFailures).toBe(3)
    expect(svc.recoveryCooldownUntil).toBe(123456)
    expect(svc.lastSuccessTime).toBe(789012)
    expect(svc.analyzer.getFingerprints()).toEqual(['a', 'b', 'c'])
    svc.stop()
  })

  it('loadState should not throw when file missing', () => {
    try {
      unlinkSync(TEST_STATE_PATH)
    } catch {}
    expect(() => {
      makeService()
    }).not.toThrow()
  })

  it('saveState should create directory if missing', () => {
    // Remove the test dir
    try {
      rmSync(TEST_STATE_DIR, { recursive: true, force: true })
    } catch {}
    const svc = makeService() as any
    svc.saveState()
    expect(existsSync(TEST_STATE_DIR)).toBe(true)
    expect(existsSync(TEST_STATE_PATH)).toBe(true)
    svc.stop()
  })
})

// =========================================================================
// Constructor Options Tests
// =========================================================================

describe('Constructor Options', () => {
  it('should accept custom analysisTimeoutMs', () => {
    const svc = makeService({ statePath: TEST_STATE_PATH }) as any
    expect(svc.analyzer.currentAnalysisTimeoutMs).toBeGreaterThan(0)
    svc.stop()
  })

  it('should accept custom degenerationThreshold', () => {
    const svc = makeService({ statePath: TEST_STATE_PATH, degThreshold: 7 }) as any
    expect(svc.analyzer.degenerationThreshold).toBe(7)
    svc.stop()
  })
})

// =========================================================================
// Degeneration Detection Tests
// =========================================================================

describe('Degeneration Detection', () => {
  it('should not be degenerate initially', () => {
    const svc = makeService({ statePath: TEST_STATE_PATH }) as any
    expect(svc.analyzer.isDegenerate()).toBe(false)
    svc.stop()
  })

  it('should detect degeneration after N identical fingerprints', () => {
    const svc = makeService({ statePath: TEST_STATE_PATH, degThreshold: 3 }) as any
    svc.analyzer.recordFingerprint('result A')
    svc.analyzer.recordFingerprint('result A')
    svc.analyzer.recordFingerprint('result A')
    expect(svc.analyzer.isDegenerate()).toBe(true)
    svc.stop()
  })

  it('should not detect degeneration with varying results', () => {
    const svc = makeService({ statePath: TEST_STATE_PATH, degThreshold: 3 }) as any
    svc.analyzer.recordFingerprint('result A')
    svc.analyzer.recordFingerprint('result B')
    svc.analyzer.recordFingerprint('result C')
    expect(svc.analyzer.isDegenerate()).toBe(false)
    svc.stop()
  })

  it('should trim fingerprint to 100 chars', () => {
    const svc = makeService({ statePath: TEST_STATE_PATH }) as any
    const long = 'x'.repeat(200)
    // computeFingerprint is private; indirectly verify via recordFingerprint behavior
    svc.analyzer.recordFingerprint(long)
    const fps = svc.analyzer.getFingerprints()
    expect(fps.length).toBe(1)
    expect(fps[0].length).toBeLessThanOrEqual(100)
    svc.stop()
  })
})

// =========================================================================
// Analysis Cycle Integration — state file creation
// =========================================================================

describe('Analysis Cycle — state file creation', () => {
  beforeEach(() => {
    try {
      mkdirSync(TEST_STATE_DIR, { recursive: true })
    } catch {}
    try {
      unlinkSync(TEST_STATE_PATH)
    } catch {}
  })
  afterEach(() => {
    try {
      unlinkSync(TEST_STATE_PATH)
    } catch {}
  })

  it('should create state file after successful analysis', async () => {
    const agent = createMockAgent()
    const svc = makeService({ agent })
    ;(svc as any).firstRunComplete = true
    await (svc as any).runAnalysisCycle()
    expect(existsSync(TEST_STATE_PATH)).toBe(true)
    const state = JSON.parse(readFileSync(TEST_STATE_PATH, 'utf-8'))
    expect(state.tryRunFailures).toBe(0)
    svc.stop()
  })

  it('should update state file after failed analysis', async () => {
    const agent = createMockAgent({
      runSelfTask: vi.fn().mockResolvedValue({ success: false, summary: 'error' }),
    })
    const svc = makeService({ agent })
    ;(svc as any).firstRunComplete = true
    await (svc as any).runAnalysisCycle()
    expect(existsSync(TEST_STATE_PATH)).toBe(true)
    const state = JSON.parse(readFileSync(TEST_STATE_PATH, 'utf-8'))
    expect(state.tryRunFailures).toBe(1)
    svc.stop()
  })

  it('should skip analysis when degenerate', async () => {
    const agent = createMockAgent()
    const svc = makeService({ agent, degThreshold: 3 }) as any
    // Pre-load 3 identical fingerprints
    svc.analyzer.recordFingerprint('same')
    svc.analyzer.recordFingerprint('same')
    svc.analyzer.recordFingerprint('same')
    ;(svc as any).firstRunComplete = true
    await (svc as any).runAnalysisCycle()
    // runSelfTask should NOT have been called — pre-filter catches degeneration
    expect(agent.runSelfTask).not.toHaveBeenCalled()
    svc.stop()
  })
})
