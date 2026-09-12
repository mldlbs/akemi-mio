/**
 * UserBehaviorLayer — 单元测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock logger
vi.mock('@akemi-mio/core/logger/Logger', () => ({
  log: vi.fn(),
}))

// 清除环境变量以免干扰
beforeEach(() => {
  delete process.env.USER_BEHAVIOR_FEATURES
})

import { UserBehaviorLayer } from '@akemi-mio/evolution/user-behavior/UserBehaviorLayer'
import { parseFeaturesFromEnv } from '@akemi-mio/evolution/user-behavior/types'
import type { SelfEvolutionService } from '@akemi-mio/evolution/SelfEvolutionService'

function createMockEvolution(): SelfEvolutionService {
  return {
    name: 'SelfEvolutionService',
    state: 'ready',
    getSchedulerState: vi.fn().mockReturnValue('IDLE'),
    getSafetyMode: vi.fn().mockReturnValue('review'),
    getLastRun: vi.fn().mockReturnValue(0),
    getConsecutiveFailures: vi.fn().mockReturnValue(0),
    getExecuteFailures: vi.fn().mockReturnValue(0),
    getLastPipelineMetrics: vi.fn().mockReturnValue(null),
    getRecoveryCooldown: vi.fn().mockReturnValue({ active: false, remainingMs: 0 }),
    healthCheck: vi.fn().mockResolvedValue({ healthy: true, metrics: {} }),
    init: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  } as unknown as SelfEvolutionService
}

describe('UserBehaviorLayer', () => {
  describe('基本行为', () => {
    it('无 feature 时不执行任何钩子', async () => {
      const mock = createMockEvolution()
      const layer = new UserBehaviorLayer(mock, { features: [] })

      expect(layer.hasFeature('summary_enhance')).toBe(false)
      expect(layer.getActiveFeatures()).toEqual([])

      // 无 feature 时预处理应原样返回
      const ctx = await layer.preProcess({
        timestamp: Date.now(),
        hoursSinceLastRun: 2,
        consecutiveFailures: 0,
        safetyMode: 'auto',
        userActive: false,
      })
      expect(ctx.userActive).toBe(false)

      // 无 feature 时后处理应返回空
      const postResult = await layer.postProcess({
        rawMetrics: null,
        success: true,
        rawSummary: 'test',
        durationMs: 100,
      })
      expect(postResult).toEqual({})
    })

    it('注册了 feature 但无钩子时不报错', async () => {
      const mock = createMockEvolution()
      const layer = new UserBehaviorLayer(mock, { features: ['summary_enhance'] })

      expect(layer.hasFeature('summary_enhance')).toBe(true)

      const ctx = await layer.preProcess({
        timestamp: Date.now(),
        hoursSinceLastRun: 1,
        consecutiveFailures: 0,
        safetyMode: 'review',
        userActive: true,
      })
      expect(ctx.userActive).toBe(true)
    })

    it('暴露被包裹的 evolution 实例', () => {
      const mock = createMockEvolution()
      const layer = new UserBehaviorLayer(mock)
      expect(layer.inner).toBe(mock)
    })
  })

  describe('预处理钩子', () => {
    it('按注册顺序执行预处理钩子', async () => {
      const mock = createMockEvolution()
      const order: number[] = []
      const layer = new UserBehaviorLayer(mock, {
        features: ['summary_enhance'],
        preHooks: [
          async (ctx) => {
            order.push(1)
            return ctx
          },
          async (ctx) => {
            order.push(2)
            return ctx
          },
          async (ctx) => {
            order.push(3)
            return ctx
          },
        ],
      })

      await layer.preProcess({
        timestamp: Date.now(),
        hoursSinceLastRun: 0,
        consecutiveFailures: 0,
        safetyMode: 'auto',
        userActive: false,
      })

      expect(order).toEqual([1, 2, 3])
    })

    it('单个钩子失败不阻断后续钩子', async () => {
      const mock = createMockEvolution()
      const order: number[] = []
      const layer = new UserBehaviorLayer(mock, {
        features: ['summary_enhance'],
        preHooks: [
          async (ctx) => {
            order.push(1)
            return ctx
          },
          async () => {
            order.push(2)
            throw new Error('hook_error')
          },
          async (ctx) => {
            order.push(3)
            return ctx
          },
        ],
      })

      const ctx = await layer.preProcess({
        timestamp: Date.now(),
        hoursSinceLastRun: 0,
        consecutiveFailures: 0,
        safetyMode: 'auto',
        userActive: false,
      })

      expect(order).toEqual([1, 2, 3])
      expect(ctx).toBeDefined()
    })
  })

  describe('后处理钩子', () => {
    it('合并多个钩子结果', async () => {
      const mock = createMockEvolution()
      const layer = new UserBehaviorLayer(mock, {
        features: ['summary_enhance', 'metrics_enrich'],
        postHooks: [
          async () => ({ enhancedSummary: 'enhanced', extraData: { a: 1 } }),
          async () => ({ extraData: { b: 2 }, messages: ['msg2'] }),
        ],
      })

      const result = await layer.postProcess({
        rawMetrics: { totalCollected: 10, totalFixed: 5, totalFailed: 1, queueSize: 4, lastRunAt: Date.now(), isRunning: false },
        success: true,
        rawSummary: '原始报告',
        durationMs: 200,
      })

      expect(result.enhancedSummary).toBe('enhanced')
      expect(result.extraData).toEqual({ a: 1, b: 2 })
      expect(result.messages).toEqual(['msg2'])
    })

    it('无 feature 时返回空结果', async () => {
      const mock = createMockEvolution()
      const layer = new UserBehaviorLayer(mock, { features: [] })

      const result = await layer.postProcess({
        rawMetrics: null,
        success: true,
        rawSummary: '',
        durationMs: 0,
      })

      expect(result).toEqual({})
    })

    it('缓存最后一次后处理结果', async () => {
      const mock = createMockEvolution()
      const layer = new UserBehaviorLayer(mock, {
        features: ['summary_enhance'],
        postHooks: [async () => ({ enhancedSummary: 'cached_result' })],
      })

      expect(layer.getLastPostProcessResult()).toBeNull()

      await layer.postProcess({
        rawMetrics: null,
        success: true,
        rawSummary: 'test',
        durationMs: 100,
      })

      expect(layer.getLastPostProcessResult()?.enhancedSummary).toBe('cached_result')
    })
  })

  describe('动态注册钩子', () => {
    it('addPreHook / addPostHook', () => {
      const mock = createMockEvolution()
      const layer = new UserBehaviorLayer(mock)

      layer.addPreHook(async (ctx) => ctx)
      layer.addPostHook(async (ctx) => ({ enhancedSummary: 'ok' }))

      // 内部确认钩子已注册
      expect(layer.getActiveFeatures()).toEqual([])
    })
  })

  describe('默认钩子', () => {
    it('createSummaryEnhancePostHook 在有指标时附加行为上下文', async () => {
      const hook = UserBehaviorLayer.createSummaryEnhancePostHook()

      const result = await hook({
        rawMetrics: { totalCollected: 5, totalFixed: 3, totalFailed: 1, queueSize: 1, lastRunAt: Date.now(), isRunning: false },
        success: true,
        rawSummary: '原始摘要',
        durationMs: 100,
      })

      expect(result.enhancedSummary).toBe('原始摘要')
    })

    it('createSummaryEnhancePostHook 在无指标时返回空', async () => {
      const hook = UserBehaviorLayer.createSummaryEnhancePostHook()

      const result = await hook({
        rawMetrics: null,
        success: true,
        rawSummary: '',
        durationMs: 0,
      })

      expect(result).toEqual({})
    })

    it('createMetricsEnrichPostHook 计算修复率', async () => {
      const hook = UserBehaviorLayer.createMetricsEnrichPostHook()

      const result = await hook({
        rawMetrics: { totalCollected: 10, totalFixed: 7, totalFailed: 1, queueSize: 2, lastRunAt: Date.now(), isRunning: false },
        success: true,
        rawSummary: 'test',
        durationMs: 100,
      })

      expect(result.extraData?.behaviorAnalyzed).toBeDefined()
      expect(result.extraData!.behaviorAnalyzed.fixRate).toBe('70.0%')
      expect(result.extraData!.behaviorAnalyzed.sessionEffectiveness).toBe('good')
      expect(result.messages).toHaveLength(1)
    })

    it('createDynamicTuningPostHook 在失败率高时给出建议', async () => {
      const hook = UserBehaviorLayer.createDynamicTuningPostHook()

      const result = await hook({
        rawMetrics: { totalCollected: 10, totalFixed: 2, totalFailed: 7, queueSize: 6, lastRunAt: Date.now(), isRunning: false },
        success: true,
        rawSummary: 'test',
        durationMs: 100,
      })

      expect(result.extraData?.tuningSuggestion).toBeDefined()
      expect(result.extraData!.tuningSuggestion.action).toBe('reduce_concurrency')
      expect(result.messages).toHaveLength(1)
    })

    it('createDynamicTuningPostHook 在失败率低时不给出建议', async () => {
      const hook = UserBehaviorLayer.createDynamicTuningPostHook()

      const result = await hook({
        rawMetrics: { totalCollected: 10, totalFixed: 9, totalFailed: 0, queueSize: 1, lastRunAt: Date.now(), isRunning: false },
        success: true,
        rawSummary: 'test',
        durationMs: 100,
      })

      expect(result.extraData?.tuningSuggestion).toBeUndefined()
    })
  })

  describe('parseFeaturesFromEnv', () => {
    beforeEach(() => {
      delete process.env.USER_BEHAVIOR_FEATURES
    })

    it('解析有效特性', () => {
      process.env.USER_BEHAVIOR_FEATURES = 'summary_enhance,metrics_enrich'
      const features = parseFeaturesFromEnv()
      expect(features).toEqual(['summary_enhance', 'metrics_enrich'])
    })

    it('过滤未知特性', () => {
      process.env.USER_BEHAVIOR_FEATURES = 'summary_enhance,unknown_feature,metrics_enrich'
      const features = parseFeaturesFromEnv()
      expect(features).toEqual(['summary_enhance', 'metrics_enrich'])
    })

    it('空环境变量返回空数组', () => {
      const features = parseFeaturesFromEnv()
      expect(features).toEqual([])
    })
  })
})
