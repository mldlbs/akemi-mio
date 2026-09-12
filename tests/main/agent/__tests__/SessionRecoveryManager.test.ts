import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionRecoveryManager } from '@akemi-mio/intelligence/agent/SessionRecoveryManager'
import { RunContext } from '@akemi-mio/intelligence/agent/runstate'
import { ConversationContext } from '@akemi-mio/intelligence/agent/context'

describe('SessionRecoveryManager execution goal recovery', () => {
  let baseDir: string
  let manager: SessionRecoveryManager

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'mio-srm-'))
    manager = new SessionRecoveryManager(baseDir)
  })

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true })
  })

  function makeContext(): ConversationContext {
    const ctx = new ConversationContext()
    ctx.addUser('fix MCP binding')
    ctx.addAssistant('working')
    return ctx
  }

  function checkpointParams(overrides: Record<string, unknown> = {}) {
    return {
      trigger: 'interrupt' as const,
      runContext: null,
      context: makeContext(),
      runId: 'run-test',
      planState: {
        activePlanId: null,
        activePlanTitle: null,
        sessionPlanIds: [],
        pendingStepDescriptions: [],
      },
      ...overrides,
    }
  }

  it('persists activeGoalId from RunContext when no explicit executionGoalId is supplied', async () => {
    const ctx = new RunContext('run-test')
    ctx.activeGoalId = 'goal-from-context'

    await manager.createCheckpoint(checkpointParams({ runContext: ctx }))

    const restored = manager.restoreLatestCheckpoint()
    expect(restored?.executionGoalId).toBe('goal-from-context')
  })

  it('prefers explicit executionGoalId over RunContext.activeGoalId', async () => {
    const ctx = new RunContext('run-test')
    ctx.activeGoalId = 'goal-from-context'

    await manager.createCheckpoint(checkpointParams({ runContext: ctx, executionGoalId: 'goal-explicit' }))

    const restored = manager.restoreLatestCheckpoint()
    expect(restored?.executionGoalId).toBe('goal-explicit')
  })

  it('restores legacy checkpoints without executionGoalId as undefined', () => {
    const legacy = {
      meta: { version: 1, runId: 'legacy-run', timestamp: Date.now(), trigger: 'interrupt' },
      runContext: {
        step: 0,
        state: 'ready',
        consecutiveTimeouts: 0,
        consecutiveToolErrors: 0,
        forceContinueCount: 0,
        forceContinueStagnation: 0,
        interruptFlag: false,
        interruptReason: '',
      },
      conversationSummary: '',
      conversationStats: {
        totalMessages: 0,
        totalTurns: 0,
        lastUserMessage: '',
        lastAssistantMessage: '',
      },
      shortTermMemory: [],
      planState: {
        activePlanId: null,
        activePlanTitle: null,
        sessionPlanIds: [],
        pendingStepDescriptions: [],
      },
      resourceState: {},
      circuitBreakerState: {},
      timestamps: { sessionStartedAt: Date.now(), lastCheckpointAt: Date.now() },
    }

    const latestPath = join(baseDir, 'checkpoints', 'latest.json')
    writeFileSync(latestPath, JSON.stringify(legacy), 'utf-8')

    const restored = manager.restoreLatestCheckpoint()
    expect(restored?.meta.runId).toBe('legacy-run')
    expect(restored?.executionGoalId).toBeUndefined()
  })
})
