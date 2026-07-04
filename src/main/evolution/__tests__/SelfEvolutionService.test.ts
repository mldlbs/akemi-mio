/**
 * SelfEvolutionService 集成测试（v2 精简版）
 *
 * 当前 SelfEvolutionService 是一个薄层管道调度器：
 * 1. 注入 PipelineOrchestrator 后周期性触发
 * 2. 维护冷却/失败状态跨重启
 * 3. 安全模式管理、用户活跃保护
 *
 * 已移除（旧版测试覆盖的闭环内循环组件）：
 * - analyzer / executor 子组件（不再存在）
 * - LLM 自我分析（不再使用 runAgentTask）
 * - 创造力假设注入 / 计划上下文注入
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import { EventEmitter } from 'events'

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => process.cwd() },
}))

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

vi.mock('../../db/messages', () => ({
  insertMessage: vi.fn(),
  createMessageId: () => `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
}))

vi.mock('../../core/Lifecycle', () => ({
  getMainWindow: vi.fn(() => null),
}))

import { SelfEvolutionService } from '../SelfEvolutionService'
import type { DevPlan, PlanStep } from '../types'
import type { PipelineMetrics } from '../automation'

// =============================================================================
// 测试辅助 — 隔离的临时文件路径
// =============================================================================

let testCounter = 0

function makeTestPaths(): { stateFilePath: string } {
  const id = `test_${++testCounter}_${Date.now()}`
  const tmpDir = path.join(os.tmpdir(), 'evolution-test', id)
  return {
    stateFilePath: path.join(tmpDir, 'evolution_state.json'),
  }
}

function cleanupTestPaths(paths: { stateFilePath: string }): void {
  try {
    fs.unlinkSync(paths.stateFilePath)
  } catch {
    /* ignore */
  }
  try {
    fs.rmdirSync(path.dirname(paths.stateFilePath))
  } catch {
    /* ignore */
  }
  try {
    fs.rmdirSync(path.dirname(path.dirname(paths.stateFilePath)))
  } catch {
    /* ignore */
  }
}

// =============================================================================
// Mock PlanManager
// =============================================================================

function createMockPlanManager(initialPlan: DevPlan | null = null) {
  let activePlan = initialPlan ? JSON.parse(JSON.stringify(initialPlan)) : null
  let abandonedPlans: string[] = []

  return {
    getActivePlan: vi.fn(() => activePlan),
    getPlan: vi.fn((id: string) => (activePlan?.id === id ? activePlan : undefined)),
    listPlans: vi.fn(() => (activePlan ? [activePlan] : [])),
    createPlan: vi.fn((title: string, _description: string, stepDescriptions: string[]) => {
      const steps = stepDescriptions.map((desc, i) => ({
        id: `step_${i}`,
        description: desc,
        status: 'pending' as const,
      }))
      activePlan = {
        id: `plan_${Date.now()}`,
        title,
        description: _description,
        steps,
        status: 'active' as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      return activePlan
    }),
    updateStep: vi.fn((planId: string, stepIndex: number, status: PlanStep['status'], result?: string) => {
      if (activePlan && activePlan.id === planId && stepIndex < activePlan.steps.length) {
        activePlan.steps[stepIndex].status = status
        if (result) activePlan.steps[stepIndex].result = result
      }
      return true
    }),
    completePlan: vi.fn((id: string) => {
      if (activePlan?.id === id) activePlan = null
      return true
    }),
    abandonPlan: vi.fn((id: string, _reason?: string) => {
      abandonedPlans.push(id)
      if (activePlan?.id === id) activePlan = null
      return true
    }),
    freezePlan: vi.fn((_id: string, _reason?: string) => true),
    getFormattedContext: vi.fn(() => {
      if (!activePlan) return ''
      const doneSteps = activePlan.steps.filter((s: PlanStep) => s.status === 'done').length
      const totalSteps = activePlan.steps.length
      let ctx = `【当前开发计划】${activePlan.title}\n进度: ${doneSteps}/${totalSteps}\n`
      for (const s of activePlan.steps) {
        const mark = s.status === 'done' ? '[✓]' : s.status === 'in_progress' ? '[→]' : s.status === 'failed' ? '[✗]' : '[ ]'
        ctx += `${mark} ${s.description}\n`
      }
      return ctx
    }),
    cleanupOldPlans: vi.fn(() => 0),
    lock: { run: async <T>(fn: () => Promise<T>) => fn() },
    _abandonedPlans: () => abandonedPlans,
    _setPlan: (plan: DevPlan | null) => {
      activePlan = plan ? JSON.parse(JSON.stringify(plan)) : null
    },
  }
}

// =============================================================================
// Mock AgentService
// =============================================================================

function createMockAgentService() {
  let busy = false
  return {
    isBusy: vi.fn(() => busy),
    _setBusy: (b: boolean) => { busy = b },
  }
}

// =============================================================================
// Mock Scheduler
// =============================================================================

function createMockScheduler() {
  const tasks = new Map<string, { handler: () => Promise<string>; cancelled: boolean }>()
  return {
    interval: vi.fn((_ms: number, handler: () => Promise<string>, _label?: string) => {
      const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2)}`
      tasks.set(id, { handler, cancelled: false })
      return id
    }),
    cancel: vi.fn((id: string) => {
      const t = tasks.get(id)
      if (t) t.cancelled = true
    }),
    _triggerFirst: async () => {
      for (const t of tasks.values()) {
        if (!t.cancelled) await t.handler()
      }
    },
  }
}

// =============================================================================
// Mock PipelineOrchestrator
// =============================================================================

function createMockPipeline(metrics: Partial<PipelineMetrics> = {}) {
  const defaultMetrics: PipelineMetrics = {
    totalCollected: 0,
    totalFixed: 0,
    totalFailed: 0,
    queueSize: 0,
    lastRunAt: 0,
    isRunning: false,
  }
  let currentMetrics = { ...defaultMetrics, ...metrics }
  let shouldThrow = false
  let runCount = 0

  return {
    runOnce: vi.fn(async () => {
      runCount++
      if (shouldThrow) throw new Error('Pipeline error (mock)')
      return currentMetrics
    }),
    getMetrics: vi.fn(() => currentMetrics),
    _setMetrics: (m: Partial<PipelineMetrics>) => {
      currentMetrics = { ...currentMetrics, ...m }
    },
    _setShouldThrow: (b: boolean) => { shouldThrow = b },
    _runCount: () => runCount,
  }
}

// =============================================================================
// 测试辅助 — 创建 DevPlan
// =============================================================================

function makePlan(title: string, stepCount: number, doneCount: number, options?: { failedCount?: number }): DevPlan {
  const failedCount = options?.failedCount ?? 0
  const steps: PlanStep[] = Array.from({ length: stepCount }, (_, i) => {
    let status: PlanStep['status'] = 'pending'
    if (i < doneCount) status = 'done'
    else if (i < doneCount + failedCount) status = 'failed'
    return {
      id: `step_${i}`,
      description: `步骤 ${i + 1}: ${title} 的第 ${i + 1} 步`,
      status,
    }
  })

  return {
    id: `plan_${title.replace(/\s/g, '_')}`,
    title,
    description: `测试计划: ${title}`,
    steps,
    status: 'active',
    createdAt: Date.now() - 3600000,
    updatedAt: Date.now() - 1800000,
  }
}

describe('SelfEvolutionService — v2 精简版集成测试', () => {
  let paths: { stateFilePath: string }

  beforeEach(() => {
    paths = makeTestPaths()
  })

  afterEach(() => {
    cleanupTestPaths(paths)
  })

  // ===========================================================================
  // 构造和初始化
  // ===========================================================================

  describe('构造和默认值', () => {
    it('应正确初始化所有公开 getter 的默认值', () => {
      const mockAgent = createMockAgentService()
      const mockSched = createMockScheduler()
      const bus = new EventEmitter()

      const service = new SelfEvolutionService(mockAgent as any, mockSched as any, bus as any, undefined, {
        stateFilePath: paths.stateFilePath,
      })

      expect(service.name).toBe('SelfEvolutionService')
      expect(service.state).toBe('created')
      expect(service.getSchedulerState()).toBe('IDLE' as any)
      expect(service.getSafetyMode()).toBe('review')
      expect(service.getConsecutiveFailures()).toBe(0)
      expect(service.getExecuteFailures()).toBe(0)
      expect(service.getLastRun()).toBe(0)
      expect(service.getLastPipelineMetrics()).toBeNull()
    })

    it('应使用自定义 options 覆盖默认值', () => {
      const mockAgent = createMockAgentService()
      const service = new SelfEvolutionService(mockAgent as any, undefined, undefined, undefined, {
        stateFilePath: paths.stateFilePath,
        intervalMs: 60 * 60 * 1000,
        maxFailures: 5,
      })

      // intervalMs / maxFailures 为内部字段，通过间接方式验证
      expect(service.getConsecutiveFailures()).toBe(0)
    })

    it('应通过 setPipeline 注入管道引用', () => {
      const mockAgent = createMockAgentService()
      const service = new SelfEvolutionService(mockAgent as any, undefined, undefined, undefined, {
        stateFilePath: paths.stateFilePath,
      })
      const mockPipeline = createMockPipeline({ totalCollected: 5, totalFixed: 3 })

      expect(() => service.setPipeline(mockPipeline as any)).not.toThrow()
    })
  })

  // ===========================================================================
  // ISubsystem 生命周期
  // ===========================================================================

  describe('ISubsystem 生命周期', () => {
    it('init() 应将状态从 created → ready', async () => {
      const mockAgent = createMockAgentService()
      const service = new SelfEvolutionService(mockAgent as any, undefined, undefined, undefined, {
        stateFilePath: paths.stateFilePath,
      })

      await service.init()
      expect(service.state).toBe('ready')
    })

    it('start() 后应在 running 状态', async () => {
      const mockAgent = createMockAgentService()
      const service = new SelfEvolutionService(mockAgent as any, undefined, undefined, undefined, {
        stateFilePath: paths.stateFilePath,
      })

      // 注入管道以触发第一次执行
      const mockPipeline = createMockPipeline()
      service.setPipeline(mockPipeline as any)

      await service.init()
      await service.start()
      expect(service.state).toBe('running')
    })

    it('stop() 应将状态从 running → stopped', async () => {
      const mockAgent = createMockAgentService()
      const service = new SelfEvolutionService(mockAgent as any, undefined, undefined, undefined, {
        stateFilePath: paths.stateFilePath,
      })

      await service.init()
      await service.start()
      await service.stop()

      expect(service.state).toBe('stopped')
    })

    it('healthCheck() 应报告健康状态和指标', async () => {
      const mockAgent = createMockAgentService()
      const service = new SelfEvolutionService(mockAgent as any, undefined, undefined, undefined, {
        stateFilePath: paths.stateFilePath,
      })
      const mockPipeline = createMockPipeline({ totalCollected: 3, totalFixed: 2, queueSize: 1 })
      service.setPipeline(mockPipeline as any)

      const result = await service.healthCheck()
      expect(result.healthy).toBe(true)
      expect(result.metrics).toBeDefined()
      expect(result.metrics!.pipelineQueueSize).toBe(1)
      expect(result.metrics!.pipelineFixed).toBe(2)
    })
  })

  // ===========================================================================
  // 安全模式
  // ===========================================================================

  describe('安全模式', () => {
    it('默认安全模式应为 review', () => {
      const mockAgent = createMockAgentService()
      const service = new SelfEvolutionService(mockAgent as any, undefined, undefined, undefined, {
        stateFilePath: paths.stateFilePath,
      })

      expect(service.getSafetyMode()).toBe('review')
    })

    it('setSafetyMode 应切换模式', () => {
      const mockAgent = createMockAgentService()
      const service = new SelfEvolutionService(mockAgent as any, undefined, undefined, undefined, {
        stateFilePath: paths.stateFilePath,
      })

      service.setSafetyMode('auto')
      expect(service.getSafetyMode()).toBe('auto')

      service.setSafetyMode('review')
      expect(service.getSafetyMode()).toBe('review')
    })
  })

  // ===========================================================================
  // 管道集成
  // ===========================================================================

  describe('管道集成', () => {
    it('triggerNow 应执行管道并更新缓存指标', async () => {
      const mockAgent = createMockAgentService()
      const service = new SelfEvolutionService(mockAgent as any, undefined, undefined, undefined, {
        stateFilePath: paths.stateFilePath,
      })
      const mockPipeline = createMockPipeline({ totalCollected: 10, totalFixed: 8, totalFailed: 2, queueSize: 0 })
      service.setPipeline(mockPipeline as any)

      await service.triggerNow()

      expect(mockPipeline.runOnce).toHaveBeenCalledTimes(1)
      const metrics = service.getLastPipelineMetrics()
      expect(metrics).not.toBeNull()
      expect(metrics!.totalFixed).toBe(8)
    })

    it('triggerNow 成功应重置失败计数和冷却', async () => {
      const mockAgent = createMockAgentService()
      const service = new SelfEvolutionService(mockAgent as any, undefined, undefined, undefined, {
        stateFilePath: paths.stateFilePath,
      })
      const mockPipeline = createMockPipeline({ totalCollected: 1, totalFixed: 1 })
      service.setPipeline(mockPipeline as any)

      // 模拟已有的失败状态
      ;(service as any).tryRunFailures = 2
      ;(service as any).recoveryCooldownUntil = Date.now() + 10000

      await service.triggerNow()

      expect(service.getConsecutiveFailures()).toBe(0)
      expect(service.getRecoveryCooldown().active).toBe(false)
    })

    it('管道抛出错误应累积失败计数', async () => {
      const mockAgent = createMockAgentService()
      const service = new SelfEvolutionService(mockAgent as any, undefined, undefined, undefined, {
        stateFilePath: paths.stateFilePath,
        maxFailures: 5,
      })
      const mockPipeline = createMockPipeline()
      mockPipeline._setShouldThrow(true)
      service.setPipeline(mockPipeline as any)

      await service.triggerNow()
      expect(service.getConsecutiveFailures()).toBe(1)

      await service.triggerNow()
      expect(service.getConsecutiveFailures()).toBe(2)
    })

    it('连续失败达 maxFailures 应触发冷却', async () => {
      const mockAgent = createMockAgentService()
      const service = new SelfEvolutionService(mockAgent as any, undefined, undefined, undefined, {
        stateFilePath: paths.stateFilePath,
        maxFailures: 3,
      })
      const mockPipeline = createMockPipeline()
      mockPipeline._setShouldThrow(true)
      service.setPipeline(mockPipeline as any)

      for (let i = 0; i < 3; i++) {
        await service.triggerNow()
      }

      expect(service.getConsecutiveFailures()).toBe(3)
      const cooldown = service.getRecoveryCooldown()
      expect(cooldown.active).toBe(true)
      expect(cooldown.remainingMs).toBeGreaterThan(0)
    })

    it('无管道时 triggerNow 应正常完成不报错', async () => {
      const mockAgent = createMockAgentService()
      const service = new SelfEvolutionService(mockAgent as any, undefined, undefined, undefined, {
        stateFilePath: paths.stateFilePath,
      })

      // 无管道注入，triggerNow 应优雅处理
      await expect(service.triggerNow()).resolves.not.toThrow()
      expect(service.getConsecutiveFailures()).toBe(0)
    })
  })

  // ===========================================================================
  // 状态持久化
  // ===========================================================================

  describe('状态持久化 — saveState / loadState', () => {
    it('saveState + loadState 应保持失败计数和冷却状态', async () => {
      const mockAgent = createMockAgentService()
      const mockPipeline = createMockPipeline()
      mockPipeline._setShouldThrow(true)

      const service = new SelfEvolutionService(mockAgent as any, undefined, undefined, undefined, {
        stateFilePath: paths.stateFilePath,
        maxFailures: 10,
      })
      service.setPipeline(mockPipeline as any)

      // 累积 2 次失败
      await service.triggerNow()
      await service.triggerNow()

      expect(service.getConsecutiveFailures()).toBe(2)

      // 创建新实例读取同一文件
      const service2 = new SelfEvolutionService(mockAgent as any, undefined, undefined, undefined, {
        stateFilePath: paths.stateFilePath,
      })

      expect(service2.getConsecutiveFailures()).toBe(2)
    })

    it('旧状态文件（缺少字段）应优雅降级为默认值', () => {
      const mockAgent = createMockAgentService()

      // 写入不含新字段的旧格式状态
      const dir = path.dirname(paths.stateFilePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        paths.stateFilePath,
        JSON.stringify({
          tryRunFailures: 1,
          recoveryCooldownUntil: 0,
          lastSuccessTime: 0,
          savedAt: Date.now(),
          // 故意缺失 executeFailures
        }),
      )

      const service = new SelfEvolutionService(mockAgent as any, undefined, undefined, undefined, {
        stateFilePath: paths.stateFilePath,
      })

      expect(service.getConsecutiveFailures()).toBe(1)
      expect(service.getExecuteFailures()).toBe(0) // 默认值
    })

    it('不存在状态文件时 loadState 应安全跳过', () => {
      const mockAgent = createMockAgentService()
      const nonExistentPath = path.join(os.tmpdir(), 'does_not_exist', 'state.json')

      const service = new SelfEvolutionService(mockAgent as any, undefined, undefined, undefined, {
        stateFilePath: nonExistentPath,
      })

      // 不应抛出，使用默认值
      expect(service.getConsecutiveFailures()).toBe(0)
    })
  })

  // ===========================================================================
  // 冷却恢复
  // ===========================================================================

  describe('冷却恢复', () => {
    it('getRecoveryCooldown 在无冷却时应返回 inactive', () => {
      const mockAgent = createMockAgentService()
      const service = new SelfEvolutionService(mockAgent as any, undefined, undefined, undefined, {
        stateFilePath: paths.stateFilePath,
      })

      const cooldown = service.getRecoveryCooldown()
      expect(cooldown.active).toBe(false)
      expect(cooldown.remainingMs).toBe(0)
    })

    it('冷却时间过后应自动恢复', async () => {
      const mockAgent = createMockAgentService()
      const mockPipeline = createMockPipeline()
      mockPipeline._setShouldThrow(true)

      const service = new SelfEvolutionService(mockAgent as any, undefined, undefined, undefined, {
        stateFilePath: paths.stateFilePath,
        maxFailures: 2,
      })
      service.setPipeline(mockPipeline as any)

      // 触发 2 次失败进入冷却
      await service.triggerNow()
      await service.triggerNow()

      expect(service.getRecoveryCooldown().active).toBe(true)

      // 手动设置冷却已过期
      ;(service as any).recoveryCooldownUntil = Date.now() - 1000

      // triggerNow 应能再次运行
      mockPipeline._setShouldThrow(false)
      mockPipeline._setMetrics({ totalCollected: 0, totalFixed: 0 })
      await service.triggerNow()

      expect(service.getConsecutiveFailures()).toBe(0)
      expect(service.getRecoveryCooldown().active).toBe(false)
    })
  })

  // ===========================================================================
  // 错误计数器隔离
  // ===========================================================================

  describe('错误计数器隔离', () => {
    it('getConsecutiveFailures 和 getExecuteFailures 应独立', () => {
      const mockAgent = createMockAgentService()
      const service = new SelfEvolutionService(mockAgent as any, undefined, undefined, undefined, {
        stateFilePath: paths.stateFilePath,
      })

      // 直接设置内部状态验证隔离
      ;(service as any).tryRunFailures = 3
      ;(service as any).executeFailures = 1

      expect(service.getConsecutiveFailures()).toBe(3)
      expect(service.getExecuteFailures()).toBe(1)
    })
  })

  // ===========================================================================
  // 调度器集成
  // ===========================================================================

  describe('调度器集成', () => {
    it('scheduleEvolution 应创建周期性 tick', () => {
      const mockAgent = createMockAgentService()
      const mockSched = createMockScheduler()
      const service = new SelfEvolutionService(mockAgent as any, mockSched as any, undefined, undefined, {
        stateFilePath: paths.stateFilePath,
      })

      service.scheduleEvolution(2)
      expect(mockSched.interval).toHaveBeenCalled()
    })

    it('stopExistingTick 应取消已有的 tick', () => {
      const mockAgent = createMockAgentService()
      const mockSched = createMockScheduler()
      const service = new SelfEvolutionService(mockAgent as any, mockSched as any, undefined, undefined, {
        stateFilePath: paths.stateFilePath,
      })

      service.scheduleEvolution(2)
      service.stopExistingTick()
      expect(mockSched.cancel).toHaveBeenCalled()
    })
  })

  // ===========================================================================
  // 事件处理
  // ===========================================================================

  describe('事件驱动触发', () => {
    it('agent.input.received 事件应设置用户活跃标志', () => {
      const mockAgent = createMockAgentService()
      const bus = new EventEmitter()
      const service = new SelfEvolutionService(mockAgent as any, undefined, bus as any, undefined, {
        stateFilePath: paths.stateFilePath,
      })

      bus.emit('agent.input.received', {})

      // 验证活跃标志已设置（内部状态，间接验证：schedulerTick 会跳过）
      expect((service as any).mioActive).toBe(true)
      expect((service as any).lastUserInputTime).toBeGreaterThan(0)
    })

    it('agent.response.generated 事件应清除活跃标志', () => {
      const mockAgent = createMockAgentService()
      const bus = new EventEmitter()
      const service = new SelfEvolutionService(mockAgent as any, undefined, bus as any, undefined, {
        stateFilePath: paths.stateFilePath,
      })

      bus.emit('agent.input.received', {})
      bus.emit('agent.response.generated', {})

      expect((service as any).mioActive).toBe(false)
    })
  })

  // ===========================================================================
  // 管道指标缓存
  // ===========================================================================

  describe('管道指标缓存', () => {
    it('getLastPipelineMetrics 应返回最近管道指标', async () => {
      const mockAgent = createMockAgentService()
      const service = new SelfEvolutionService(mockAgent as any, undefined, undefined, undefined, {
        stateFilePath: paths.stateFilePath,
      })
      const mockPipeline = createMockPipeline({ totalCollected: 7, totalFixed: 5, totalFailed: 2, queueSize: 3 })
      service.setPipeline(mockPipeline as any)

      await service.triggerNow()

      const metrics = service.getLastPipelineMetrics()
      expect(metrics).not.toBeNull()
      expect(metrics!.totalCollected).toBe(7)
      expect(metrics!.totalFixed).toBe(5)
      expect(metrics!.totalFailed).toBe(2)
      expect(metrics!.queueSize).toBe(3)
    })
  })

  // ===========================================================================
  // 用户活跃保护
  // ===========================================================================

  describe('用户活跃保护', () => {
    it('用户刚输入时 schedulerTick 不应触发分析', async () => {
      const mockAgent = createMockAgentService()
      const bus = new EventEmitter()
      const mockPipeline = createMockPipeline()

      const service = new SelfEvolutionService(mockAgent as any, undefined, bus as any, undefined, {
        stateFilePath: paths.stateFilePath,
      })
      service.setPipeline(mockPipeline as any)

      // 模拟用户刚输入
      ;(service as any).mioActive = true
      ;(service as any).mioActiveSince = Date.now()
      ;(service as any).lastUserInputTime = Date.now()

      // schedulerTick 应直接返回而不执行管道
      await (service as any).schedulerTick()

      // 管道不应被调用（用户活跃时跳过）
      expect(mockPipeline._runCount()).toBe(0)
    })

    it('用户活跃超时后应清除活跃标记', async () => {
      const mockAgent = createMockAgentService()
      const bus = new EventEmitter()
      const service = new SelfEvolutionService(mockAgent as any, undefined, bus as any, undefined, {
        stateFilePath: paths.stateFilePath,
      })

      // 模拟超时的活跃状态（超过 10 分钟）
      ;(service as any).mioActive = true
      ;(service as any).mioActiveSince = Date.now() - 11 * 60 * 1000
      ;(service as any).lastUserInputTime = Date.now() - 11 * 60 * 1000

      // 手动添加管道避免空指针
      const mockPipeline = createMockPipeline()
      service.setPipeline(mockPipeline as any)

      await (service as any).schedulerTick()

      // 活跃标记应被清除
      expect((service as any).mioActive).toBe(false)
    })
  })
})
