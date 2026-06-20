import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InsightService } from '../InsightService'
import { PresenceService } from '../PresenceService'
import type { InsightStoreLike, Insight } from '../types'

vi.mock('../../core/EventBus', () => ({
  eventBus: { on: vi.fn(), emit: vi.fn() },
  EventBus: class MockEventBus { on = vi.fn(); emit = vi.fn() },
}))

function createMockStore(): InsightStoreLike & { _insights: Insight[]; _reportedIds: string[] } {
  const insights: Insight[] = []
  const reportedIds: string[] = []
  return {
    _insights: insights,
    _reportedIds: reportedIds,
    addMany: vi.fn((arr: Insight[]) => insights.push(...arr)),
    getUnreported: vi.fn(() => insights.filter(i => !reportedIds.includes(i.id))),
    getHighValueUnreported: vi.fn((threshold = 50, confidenceThreshold = 0.7) =>
      insights.filter(i => !reportedIds.includes(i.id) && i.score >= threshold && i.confidence >= confidenceThreshold),
    ),
    markReported: vi.fn((id: string) => { if (!reportedIds.includes(id)) reportedIds.push(id) }),
    markAllReported: vi.fn(() => { insights.forEach(i => { if (!reportedIds.includes(i.id)) reportedIds.push(i.id) }) }),
    getAll: vi.fn(() => [...insights]),
    prune: vi.fn(() => 0),
    count: vi.fn(() => insights.length),
  }
}

describe('InsightService', () => {
  let store: InsightStoreLike & { _insights: Insight[]; _reportedIds: string[] }
  let presence: PresenceService
  let chatJson: ReturnType<typeof vi.fn>
  let mockBus: { on: ReturnType<typeof vi.fn>; emit: ReturnType<typeof vi.fn> }
  let service: InsightService

  beforeEach(() => {
    vi.useFakeTimers()
    store = createMockStore()
    mockBus = { on: vi.fn(), emit: vi.fn() }
    chatJson = vi.fn()
    presence = new PresenceService(0.1, mockBus as any) // 6秒 idle timeout

    service = new InsightService(
      store,
      presence,
      {
        getMemoryEntries: () => [{ type: 'chat', content: 'test', createdAt: Date.now() }],
        getSummaries: () => ['summary'],
        getInteractionCount: () => 10,
        getPlans: () => [],
      },
      { chatJson: chatJson as any },
      { minIdleMinutes: 0.1, minNewMessages: 0, minNewEvents: 0 },
      mockBus as any,
    )
  })

  afterEach(() => {
    service.stop()
    vi.useRealTimers()
  })

  describe('构造函数', () => {
    it('应监听 EventBus 事件', () => {
      expect(mockBus.on).toHaveBeenCalledWith('agent.input.received', expect.any(Function))
    })
  })

  describe('start / stop', () => {
    it('多次 start 不重复创建 timer', () => {
      service.start()
      const timer1 = (service as any).checkTimer
      service.start()
      const timer2 = (service as any).checkTimer
      expect(timer1).toBe(timer2)
    })

    it('stop 后 timer 置空', () => {
      service.start()
      service.stop()
      expect((service as any).checkTimer).toBeNull()
    })
  })

  describe('forceAnalysis', () => {
    it('LLM 返回洞察时存入 store', async () => {
      chatJson.mockResolvedValue({
        data: [{
          title: '新洞察', description: 'desc', detector: 'conflict', severity: 'medium',
          evidence: ['e1'], novelty: 70, impact: 60, actionability: 50,
        }],
      })

      await service.forceAnalysis()

      expect(store.addMany).toHaveBeenCalled()
      const addedInsights = (store.addMany as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(addedInsights[0].title).toBe('新洞察')
    })

    it('LLM 返回空时 store.addMany 不被调用', async () => {
      chatJson.mockResolvedValue({ data: [] })
      await service.forceAnalysis()
      expect(store.addMany).not.toHaveBeenCalled()
    })

    it('LLM 报错时优雅处理', async () => {
      chatJson.mockResolvedValue({ error: 'timeout' })
      await service.forceAnalysis()
      expect(store.addMany).not.toHaveBeenCalled()
    })

    it('高价值洞察触发 insight.found 事件', async () => {
      // 用 8 条超过 50 字符的证据确保 confidence >= 0.7
      const longEvidence = '这是一段足够长的文本用于测试证据质量评分确保每条证据都超过五十个字符的限制标准并达标。'
      chatJson.mockResolvedValue({
        data: [{
          title: '高价值洞察标题', description: '这是一条高价值洞察的描述文本',
          detector: 'conflict', severity: 'high',
          evidence: [
            longEvidence, longEvidence, longEvidence, longEvidence,
            longEvidence, longEvidence, longEvidence, longEvidence,
          ],
          novelty: 90, impact: 90, actionability: 80,
        }],
      })
      await service.forceAnalysis()
      expect(mockBus.emit).toHaveBeenCalledWith('insight.found', expect.objectContaining({ count: 1 }))
    })

    it('触发 insight.analysis.completed 事件', async () => {
      chatJson.mockResolvedValue({ data: [] })
      await service.forceAnalysis()
      expect(mockBus.emit).toHaveBeenCalledWith('insight.analysis.completed', expect.objectContaining({ count: 0, hasValue: false }))
    })

    it('generator 抛异常时仍触发 completed 事件', async () => {
      chatJson.mockRejectedValue(new Error('崩溃'))
      await service.forceAnalysis()
      expect(mockBus.emit).toHaveBeenCalledWith('insight.analysis.completed', { count: 0, hasValue: false })
    })
  })

  describe('getReturnReport', () => {
    it('无高价值洞察时返回 hasValue=false', () => {
      const report = service.getReturnReport()
      expect(report.hasValue).toBe(false)
    })

    it('有高价值洞察时返回带消息的报告', () => {
      const insight: Insight = {
        id: 'insight_1', detector: 'test', title: '重要发现',
        description: '用户表现出对 X 的强烈兴趣',
        evidence: ['对话记录1', '对话记录2'],
        score: 85, confidence: 0.9, createdAt: Date.now(),
      }
      store._insights.push(insight)

      const report = service.getReturnReport()
      expect(report.hasValue).toBe(true)
      expect(report.message).toContain('重要发现')
      expect(report.insights.length).toBeGreaterThan(0)
    })

    it('已上报的洞察不再出现在报告中', () => {
      const insight: Insight = {
        id: 'insight_1', detector: 'test', title: '已上报',
        description: 'desc', evidence: ['e'], score: 90, confidence: 0.95, createdAt: Date.now(),
      }
      store._insights.push(insight)
      store._reportedIds.push('insight_1')

      const report = service.getReturnReport()
      expect(report.hasValue).toBe(false)
    })
  })

  describe('getStore', () => {
    it('返回构造时传入的 store 实例', () => {
      expect(service.getStore()).toBe(store)
    })
  })

  describe('tryAnalyze 门控条件', () => {
    it('away 状态不满足时跳过分析', async () => {
      // presence 初始是 active，不在 away 状态
      const runAnalysisSpy = vi.spyOn(service as any, 'runAnalysis')
      ;(service as any).tryAnalyze()
      expect(runAnalysisSpy).not.toHaveBeenCalled()
    })

    it('minIdleMinutes 不满足时跳过', () => {
      const longIdleService = new InsightService(
        store, presence,
        { getMemoryEntries: () => [], getSummaries: () => [], getInteractionCount: () => 0, getPlans: () => [] },
        { chatJson: vi.fn() as any },
        { minIdleMinutes: 9999, minNewMessages: 0, minNewEvents: 0 },
        mockBus as any,
      )
      ;(longIdleService as any).messagesAtLastAnalysis = 0
      ;(longIdleService as any).eventsAtLastAnalysis = 0
      // 让 presence 进入 away
      vi.advanceTimersByTime(10000)
      presence.tick()
      expect(presence.isAway()).toBe(true)
      const spy = vi.spyOn(longIdleService as any, 'runAnalysis')
      ;(longIdleService as any).tryAnalyze()
      expect(spy).not.toHaveBeenCalled()
      longIdleService.stop()
    })
  })
})
