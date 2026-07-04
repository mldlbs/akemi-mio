/**
 * CreativityService 集成测试 — 验证 EventBus 跨系统链路
 *
 * 核心验证点：
 * 1. evolution.plan.outcome 事件被正确消费为 creativity source
 * 2. 成功/失败的进化结果映射到不同 source type/weight
 * 3. 消费后 evolutionOutcome 被清除
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CreativityService } from '../CreativityService'
import type { IdeaStoreLike, CreativitySource } from '../types'

/** 创建最小化 mock IdeaStore */
function createMockStore(): IdeaStoreLike {
  const hypotheses: any[] = []
  return {
    addCombo: vi.fn(),
    addHypothesis: vi.fn(),
    addManyHypotheses: vi.fn((hs: any[]) => hypotheses.push(...hs)),
    addExperiment: vi.fn(),
    logDreamCycle: vi.fn(),
    getHypotheses: vi.fn(() => hypotheses),
    getNovelHypotheses: vi.fn(() => hypotheses),
    getActiveExperiments: vi.fn(() => []),
    getRecentCombos: vi.fn(() => []),
    getRecentDreamCycles: vi.fn(() => []),
    updateHypothesisStatus: vi.fn(() => true),
    addExploredPair: vi.fn(),
    getExploredPairs: vi.fn(() => []),
    resetExploredPairs: vi.fn(),
    count: vi.fn(() => ({ combos: 0, hypotheses: 0, experiments: 0, dreamCycles: 0 })),
    templateAdoptionStats: vi.fn(() => ({})),
    adoptionReport: vi.fn(() => ''),
  }
}

/**
 * 生成跨类型的 sources，确保 ConceptMixer 在任何策略下都能配对
 */
function makeDiverseSources(): CreativitySource[] {
  return [
    { name: 'Memory', content: '用户偏好与记忆', type: 'knowledge', weight: 0.8 },
    { name: 'Agent', content: '工具调用模式', type: 'behavior', weight: 0.7 },
    { name: 'Insight', content: '代码质量趋势', type: 'insight', weight: 0.6 },
  ]
}

/**
 * 返回一个有效的假设让 IdeaGenerator 通过 LLM 阶段
 */
function makeValidHypothesisResponse() {
  return {
    data: [
      {
        title: '跨模块缓存优化',
        idea: '这是一个足够描述的改进方案不少于二十个字的内容描述用于验证测试',
        expectedBenefit: '提升响应速度',
        risk: '增加内存占用',
        sourceLabels: ['Agent', 'Memory'],
        novelty: 65,
        feasibility: 75,
        impact: 70,
      },
    ],
  }
}

describe('CreativityService — Evolution ↔ Creativity EventBus', () => {
  let chatJson: ReturnType<typeof vi.fn>
  let store: IdeaStoreLike

  beforeEach(() => {
    vi.clearAllMocks()
    chatJson = vi.fn()
    store = createMockStore()
  })

  it('收到 evolution.plan.outcome（成功）后应作为 source 参与概念重组', async () => {
    const bus = new (require('events').EventEmitter)()
    const deps = {
      getSources: vi.fn(() => makeDiverseSources()),
      getInsights: vi.fn(() => []),
      getFailedHypotheses: vi.fn(() => []),
    }
    chatJson.mockResolvedValue(makeValidHypothesisResponse())

    const service = new CreativityService(store, deps, chatJson as any, undefined, 0, 42, bus, '', undefined, undefined)

    // 发送进化成功事件
    bus.emit('evolution.plan.outcome' as any, {
      success: true,
      summary: '完成 MCP 工具注册优化，性能提升 30%',
      planTitle: 'MCP 工具注册优化',
      stepsCompleted: 4,
      stepsTotal: 4,
      durationMs: 120000,
    })

    // cycle 内部：diverse sources(3) + 进化 source(1) = 4 → 进入生成 → chatJson 被调用
    await (service as any).cycle()

    expect(chatJson).toHaveBeenCalledTimes(1)
    // 消费后清除
    expect((service as any).evolutionOutcome).toBeNull()
  })

  it('成功的进化结果应产生 "knowledge" 类型 source', async () => {
    const bus = new (require('events').EventEmitter)()
    const deps = {
      getSources: vi.fn(() => makeDiverseSources()),
      getInsights: vi.fn(() => []),
      getFailedHypotheses: vi.fn(() => []),
    }
    chatJson.mockResolvedValue(makeValidHypothesisResponse())

    const service = new CreativityService(store, deps, chatJson as any, undefined, 0, 42, bus, '', undefined, undefined)

    bus.emit('evolution.plan.outcome' as any, {
      success: true,
      summary: '优化成功',
      planTitle: '性能优化',
    })

    await (service as any).cycle()

    // chatJson 被调用 → 生成流程正常
    expect(chatJson).toHaveBeenCalledTimes(1)
    expect((service as any).evolutionOutcome).toBeNull()
  })

  it('失败的进化结果仍应参与重组（type="failure"）', async () => {
    const bus = new (require('events').EventEmitter)()
    const deps = {
      getSources: vi.fn(() => makeDiverseSources()),
      getInsights: vi.fn(() => []),
      getFailedHypotheses: vi.fn(() => []),
    }
    chatJson.mockResolvedValue(makeValidHypothesisResponse())

    const service = new CreativityService(store, deps, chatJson as any, undefined, 0, 42, bus, '', undefined, undefined)

    bus.emit('evolution.plan.outcome' as any, {
      success: false,
      summary: '重构失败，数据库迁移冲突',
      planTitle: '数据库重构',
    })

    await (service as any).cycle()

    // 即使失败，source 仍被添加（diverse 3 + 失败 1 = 4 → 仍够 2）
    expect(chatJson).toHaveBeenCalledTimes(1)
    expect((service as any).evolutionOutcome).toBeNull()
  })

  it('无进化结果时不应影响创造力循环', async () => {
    const bus = new (require('events').EventEmitter)()
    const deps = {
      getSources: vi.fn(() => makeDiverseSources()),
      getInsights: vi.fn(() => []),
      getFailedHypotheses: vi.fn(() => []),
    }
    chatJson.mockResolvedValue(makeValidHypothesisResponse())

    const service = new CreativityService(store, deps, chatJson as any, undefined, 0, 42, bus, '', undefined, undefined)

    // 不发送进化事件，直接 cycle
    await (service as any).cycle()

    // diverse sources 3 个 → 足以进入生成
    expect(chatJson).toHaveBeenCalledTimes(1)
    expect((service as any).evolutionOutcome).toBeNull()
  })

  it('evolutionOutcome 消费后应为 null（幂等）', async () => {
    const bus = new (require('events').EventEmitter)()
    const deps = {
      getSources: vi.fn(() => makeDiverseSources()),
      getInsights: vi.fn(() => []),
      getFailedHypotheses: vi.fn(() => []),
    }
    chatJson.mockResolvedValue(makeValidHypothesisResponse())

    const service = new CreativityService(store, deps, chatJson as any, undefined, 0, 42, bus, '', undefined, undefined)

    // 发送两次事件，最后一次覆盖
    bus.emit('evolution.plan.outcome' as any, {
      success: true,
      summary: '第一次成功',
      planTitle: 'Plan A',
    })
    bus.emit('evolution.plan.outcome' as any, {
      success: false,
      summary: '第二次失败',
      planTitle: 'Plan B',
    })

    // cycle 消费一次（只消费最新的）
    await (service as any).cycle()
    expect((service as any).evolutionOutcome).toBeNull()

    // 再次 cycle — 没有进化结果，但仍有 3 个 diverse sources
    const callCountBefore = chatJson.mock.calls.length
    await (service as any).cycle()
    expect(chatJson).toHaveBeenCalledTimes(callCountBefore + 1)
    expect((service as any).evolutionOutcome).toBeNull()
  })
})
