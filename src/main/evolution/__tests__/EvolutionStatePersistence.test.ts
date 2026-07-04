import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../config', () => ({
  LLM_API_URL: 'https://api.example.com/chat',
  LLM_CHAT_MODEL: 'test-model',
  LLM_CODE_MODEL: 'test-model',
  LLM_CODE_API_URL: 'https://api.example.com/code',
  LLM_VISION_API_URL: 'https://api.example.com/vision',
  LLM_VISION_MODEL: 'test-vision-model',
  LLM_VISION_KEY: '',
  LLM_TEXT_API_URL: 'https://api.example.com/text',
  LLM_TEXT_MODEL: 'test-text-model',
  LLM_TEXT_KEY: '',
  FFPLAY_PATHS: ['ffplay'],
  PIPER_SCRIPT: '/dev/null/piper.py',
  PIPER_MODEL: '/dev/null/model.onnx',
  USE_LOCAL_TTS: false,
  EVOLUTION_SAFETY_MODE: 'review',
  FFMPEG_PATHS: ['ffmpeg'],
  ASR_HOTWORDS: [],
  ASR_SAMPLE_RATE: 16000,
  ASR_MAX_AUDIO_SECONDS: 25,
  WAKE_WORDS: ['mio'],
  WINDOW_WIDTH: 420,
  WINDOW_HEIGHT: 640,
  GGML_MODELS_DIR: '/dev/null/models',
  INITIAL_HOTWORDS: [],
  ASR_INITIAL_PROMPT: '',
  WORKSPACE: {
    projects: '/dev/null/projects',
    memory: '/dev/null/memory',
    knowledge: '/dev/null/knowledge',
    skills: '/dev/null/skills',
    workflows: '/dev/null/workflows',
    proposals: '/dev/null/proposals',
    logs: '/dev/null/logs',
    cache: '/dev/null/cache',
    evolution: '/dev/null/evolution',
  },
  RUNTIME_ROOT: '/dev/null',
  WORKSPACE_ROOT: '/dev/null',
  DEV_PROJECT_ROOT: '',
  LLM_MODEL: 'test-model',
}))

import { SelfEvolutionService } from '../SelfEvolutionService'
import type { AgentService } from '../../agent/AgentService'
import type { Scheduler } from '../../core/Scheduler'
import type { EventBus } from '../../core/EventBus'
import type { PlanManagerLike } from '../types'
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'

const TEST_STATE_DIR = join(process.cwd(), 'evolution_workspace', 'living_plan')
const TEST_STATE_PATH = join(TEST_STATE_DIR, 'evolution_state.test.json')

function createMockAgent(overrides?: Partial<AgentService>): AgentService {
  return {
    isBusy: vi.fn().mockReturnValue(false),
    runAgentTask: vi.fn().mockResolvedValue({ success: true, summary: 'test analysis done' }),
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

function makeService(opts?: { agent?: AgentService; statePath?: string; intervalMs?: number; maxFailures?: number }) {
  return new SelfEvolutionService(
    opts?.agent ?? createMockAgent(),
    createMockScheduler(),
    createMockEventBus(),
    createMockPlanManager(),
    {
      stateFilePath: opts?.statePath ?? TEST_STATE_PATH,
      intervalMs: opts?.intervalMs,
      maxFailures: opts?.maxFailures,
    },
  )
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
    svc.executeFailures = 1
    svc.recoveryCooldownUntil = 999999
    svc.lastSuccessTime = 888888
    svc.saveState()

    expect(existsSync(TEST_STATE_PATH)).toBe(true)
    const state = JSON.parse(readFileSync(TEST_STATE_PATH, 'utf-8'))
    expect(state.tryRunFailures).toBe(2)
    expect(state.executeFailures).toBe(1)
    expect(state.recoveryCooldownUntil).toBe(999999)
    expect(state.lastSuccessTime).toBe(888888)
    expect(state.savedAt).toBeGreaterThan(0)
    svc.stop()
  })

  it('loadState should restore values from file', () => {
    mkdirSync(TEST_STATE_DIR, { recursive: true })
    writeFileSync(
      TEST_STATE_PATH,
      JSON.stringify({
        tryRunFailures: 3,
        executeFailures: 2,
        recoveryCooldownUntil: 123456,
        lastSuccessTime: 789012,
        savedAt: Date.now(),
      }),
      'utf-8',
    )

    const svc = makeService() as any
    expect(svc.tryRunFailures).toBe(3)
    expect(svc.executeFailures).toBe(2)
    expect(svc.recoveryCooldownUntil).toBe(123456)
    expect(svc.lastSuccessTime).toBe(789012)
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
  it('should accept custom stateFilePath', () => {
    const customPath = join(TEST_STATE_DIR, 'custom_state.test.json')
    const svc = makeService({ statePath: customPath }) as any
    expect(svc.stateFilePath).toBe(customPath)
    svc.stop()
  })

  it('should accept custom maxFailures', () => {
    const svc = makeService({ statePath: TEST_STATE_PATH, maxFailures: 7 }) as any
    expect(svc.maxFailures).toBe(7)
    svc.stop()
  })

  it('should accept custom intervalMs', () => {
    const svc = makeService({ statePath: TEST_STATE_PATH, intervalMs: 60000 }) as any
    expect(svc.intervalMs).toBe(60000)
    svc.stop()
  })
})

// =========================================================================
// Analysis Cycle Integration — state file creation
// =========================================================================

describe('Analysis Cycle — state file creation', () => {
  const TEST_HISTORY_PATH = join(TEST_STATE_DIR, 'history.test.json')
  beforeEach(() => {
    try {
      mkdirSync(TEST_STATE_DIR, { recursive: true })
    } catch {}
    try {
      unlinkSync(TEST_STATE_PATH)
    } catch {}
    try {
      unlinkSync(TEST_HISTORY_PATH)
    } catch {}
  })
  afterEach(() => {
    try {
      unlinkSync(TEST_STATE_PATH)
    } catch {}
    try {
      unlinkSync(TEST_HISTORY_PATH)
    } catch {}
  })

  it('should create state file after successful analysis', async () => {
    const agent = createMockAgent()
    const svc = makeService({ agent })
    // Inject a mock pipeline that returns success metrics
    ;(svc as any).pipeline = {
      runOnce: vi.fn().mockResolvedValue({ totalCollected: 0, totalFixed: 0, totalFailed: 0, queueSize: 0, lastRunAt: Date.now() }),
    }
    ;(svc as any).firstRunComplete = true
    await (svc as any).runAnalysisCycle()
    expect(existsSync(TEST_STATE_PATH)).toBe(true)
    const state = JSON.parse(readFileSync(TEST_STATE_PATH, 'utf-8'))
    expect(state.tryRunFailures).toBe(0)
    svc.stop()
  })

  it('should update state file after failed analysis', async () => {
    const agent = createMockAgent()
    const svc = makeService({ agent })
    // Inject a mock pipeline that throws to trigger the catch path
    ;(svc as any).pipeline = {
      runOnce: vi.fn().mockRejectedValue(new Error('test pipeline failure')),
    }
    ;(svc as any).firstRunComplete = true
    await (svc as any).runAnalysisCycle()
    expect(existsSync(TEST_STATE_PATH)).toBe(true)
    const state = JSON.parse(readFileSync(TEST_STATE_PATH, 'utf-8'))
    expect(state.tryRunFailures).toBe(1)
    svc.stop()
  })
})
