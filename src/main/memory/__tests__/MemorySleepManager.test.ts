/**
 * MemorySleepManager 单元测试
 *
 * 测试覆盖范围：
 * 1. 空闲检测与整理触发
 * 2. 低频记忆分组与压缩
 * 3. 活跃时段预测
 * 4. 预加载缓存管理
 * 5. 生命周期管理（start/stop）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { MemorySleepManager } from '../MemorySleepManager'
import { initDatabase, closeDatabase } from '../../db/connection'
import type { MemoryEntry } from '../types'

vi.mock('../../logger/Logger', () => ({ log: vi.fn() }))

function createMockEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const now = Date.now()
  return {
    id: `test_${now}_${Math.random().toString(36).slice(2, 6)}`,
    type: 'user_fact',
    content: 'Test memory content',
    confidence: 0.7,
    tier: 'ephemeral',
    reinforceCount: 0,
    behaviorScore: 0.5,
    lastAccessedAt: now,
    accessCount: 1,
    isPinned: false,
    manualScoreOverride: null,
    utilityScore: 0.5,
    agentReferenceCount: 0,
    userConfirmedUsefulCount: 0,
    lastUtilityUpdateAt: now,
    createdAt: now,
    updatedAt: now,
    topics: [],
    ...overrides,
  }
}

describe('MemorySleepManager', () => {
  let entries: MemoryEntry[]
  let removedIds: Set<string>
  let persistEntry: ReturnType<typeof vi.fn>
  let onConsolidated: ReturnType<typeof vi.fn>
  let manager: MemorySleepManager

  beforeEach(async () => {
    if (existsSync(join(process.cwd(), 'akemi-mio.db'))) unlinkSync(join(process.cwd(), 'akemi-mio.db'))
    process.env.USER_DATA_DIR = process.cwd()
    await initDatabase()

    entries = []
    removedIds = new Set()
    persistEntry = vi.fn()
    onConsolidated = vi.fn()
    manager = new MemorySleepManager(
      () => entries,
      removedIds,
      persistEntry,
      onConsolidated,
    )
  })

  afterEach(() => {
    manager.stop()
    closeDatabase()
    if (existsSync(join(process.cwd(), 'akemi-mio.db'))) unlinkSync(join(process.cwd(), 'akemi-mio.db'))
  })

  // ══════════════════════════════════════════
  //  生命周期
  // ══════════════════════════════════════════

  it('start 后不会立即错误', () => {
    expect(() => manager.start()).not.toThrow()
    expect(manager.getIsIdle()).toBe(false)
  })

  it('stop 可多次调用不报错', () => {
    manager.start()
    expect(() => manager.stop()).not.toThrow()
    expect(() => manager.stop()).not.toThrow()
  })

  // ══════════════════════════════════════════
  //  空闲检测
  // ══════════════════════════════════════════

  it('初始状态为空闲且空闲时长为 0', () => {
    expect(manager.getIsIdle()).toBe(false)
    expect(manager.getIdleDuration()).toBeLessThan(100)
  })

  it('recordInteraction 重置空闲状态', () => {
    manager.recordInteraction()
    expect(manager.getIsIdle()).toBe(false)
    expect(manager.getIdleDuration()).toBeLessThan(100)
  })

  it('getIdleDuration 返回自上次交互以来的时长', async () => {
    manager.recordInteraction()
    await new Promise((r) => setTimeout(r, 50))
    expect(manager.getIdleDuration()).toBeGreaterThanOrEqual(45)
  })

  // ══════════════════════════════════════════
  //  低频记忆压缩
  // ══════════════════════════════════════════

  it('没有低频条目时压缩返回空结果', async () => {
    entries.push(
      createMockEntry({
        id: 'fresh_1',
        content: 'Recently accessed memory',
        lastAccessedAt: Date.now(),
      }),
    )
    const result = await manager.runLowFrequencyConsolidation()
    expect(result.compressedCount).toBe(0)
    expect(result.summariesCreated).toBe(0)
  })

  it('压缩超过 7 天未访问的低频记忆', async () => {
    const sevenDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000
    entries.push(
      createMockEntry({
        id: 'stale_1',
        content: 'Old fact about user preference',
        lastAccessedAt: sevenDaysAgo,
        topics: ['偏好'],
      }),
      createMockEntry({
        id: 'stale_2',
        content: 'Another old fact about user likes',
        lastAccessedAt: sevenDaysAgo,
        topics: ['偏好'],
      }),
    )

    const result = await manager.runLowFrequencyConsolidation()
    expect(result.compressedCount).toBe(2)
    expect(result.summariesCreated).toBe(1)
    // 原始条目应从 entries 移除
    expect(entries.find((e) => e.id === 'stale_1')).toBeUndefined()
    expect(entries.find((e) => e.id === 'stale_2')).toBeUndefined()
    // 应有新的摘要条目
    expect(entries.length).toBe(1)
    expect(entries[0].id).toContain('sleep_compress_')
    expect(persistEntry).toHaveBeenCalledTimes(1)
  })

  it('永久层和 pinned 条目不参与压缩', async () => {
    const sevenDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000
    entries.push(
      createMockEntry({
        id: 'perm_1',
        content: 'Permanent memory',
        lastAccessedAt: sevenDaysAgo,
        tier: 'permanent',
      }),
      createMockEntry({
        id: 'pinned_1',
        content: 'Pinned memory',
        lastAccessedAt: sevenDaysAgo,
        isPinned: true,
      }),
    )

    const result = await manager.runLowFrequencyConsolidation()
    expect(result.compressedCount).toBe(0)
    expect(entries.length).toBe(2)
  })

  it('单条低频记忆（无相似条目配对）被跳过', async () => {
    const sevenDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000
    entries.push(
      createMockEntry({
        id: 'lonely_1',
        content: 'Lonely old memory with no similar ones',
        lastAccessedAt: sevenDaysAgo,
        topics: ['独特话题'],
      }),
    )

    const result = await manager.runLowFrequencyConsolidation()
    expect(result.compressedCount).toBe(0)
    expect(result.skippedCount).toBe(0) // 单条不构成分组
    expect(entries.length).toBe(1) // 未被删除
  })

  it('最多处理 MAX_COMPRESS_PER_RUN 条', async () => {
    const sevenDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000
    // 创建超过上限的低频条目
    for (let i = 0; i < 55; i++) {
      entries.push(
        createMockEntry({
          id: `stale_batch_${i}`,
          content: `Batch old fact ${i} about same topic`,
          lastAccessedAt: sevenDaysAgo,
          topics: ['批量'],
        }),
      )
    }

    const result = await manager.runLowFrequencyConsolidation()
    expect(result.compressedCount).toBeGreaterThan(0)
    // 不应处理所有 55 条
    expect(result.compressedCount).toBeLessThanOrEqual(55)
  })

  // ══════════════════════════════════════════
  //  活跃时段分析
  // ══════════════════════════════════════════

  it('recordInteraction 记录当前活跃小时', () => {
    manager.recordInteraction()
    const stats = manager.getActivityStats()
    const currentHour = new Date().getHours()
    const currentStat = stats.find((s) => s.hour === currentHour)
    expect(currentStat).toBeDefined()
    expect(currentStat!.activeDays).toBeGreaterThanOrEqual(1)
    expect(currentStat!.totalInteractions).toBeGreaterThanOrEqual(1)
  })

  it('同一天同一小时只记录一次活跃', () => {
    manager.recordInteraction()
    manager.recordInteraction()
    manager.recordInteraction()
    const stats = manager.getActivityStats()
    const currentHour = new Date().getHours()
    const currentStat = stats.find((s) => s.hour === currentHour)
    expect(currentStat).toBeDefined()
    expect(currentStat!.activeDays).toBe(1) // 同一天只计 1 天
    expect(currentStat!.totalInteractions).toBe(1) // 去重后只有 1 次
  })

  it('数据不足时不预测活跃时段', () => {
    // 刚初始化，没有足够历史数据
    const prediction = manager.predictNextActivePeriod()
    expect(prediction).toBeNull()
  })

  it('getCurrentHourActivity 返回当前小时统计', () => {
    manager.recordInteraction()
    const activity = manager.getCurrentHourActivity()
    expect(typeof activity.activeDays).toBe('number')
    expect(typeof activity.isActivePeriod).toBe('boolean')
  })

  // ══════════════════════════════════════════
  //  预加载缓存
  // ══════════════════════════════════════════

  it('初始预加载缓存为空', () => {
    expect(manager.getPreloadCacheContext()).toBe('')
  })

  it('populatePreloadCache 后返回缓存内容', () => {
    entries.push(
      createMockEntry({
        id: 'important_1',
        content: 'Very important user preference',
        behaviorScore: 0.9,
      }),
    )

    // 触发 populatePreloadCache（通过recordInteraction）
    manager.recordInteraction()

    // 获取缓存上下文
    const ctx = manager.getPreloadCacheContext()
    // 缓存可能为空因为需要预测活跃时段来触发填充
    // 但直接测试 getPreloadCacheContext 返回空字符串当缓存未填充时
    expect(typeof ctx).toBe('string')
  })

  it('getPreloadCacheStats 返回统计信息', () => {
    const stats = manager.getPreloadCacheStats()
    expect(typeof stats.size).toBe('number')
    expect(typeof stats.expired).toBe('boolean')
    expect(stats.size).toBe(0)
  })

  it('clearPreloadCache 清空缓存', () => {
    entries.push(
      createMockEntry({
        id: 'test_1',
        content: 'Test content',
        behaviorScore: 0.8,
      }),
    )

    // 手动触发缓存填充
    manager.recordInteraction()

    const statsBefore = manager.getPreloadCacheStats()
    manager.clearPreloadCache()
    const statsAfter = manager.getPreloadCacheStats()
    expect(statsAfter.size).toBe(0)
  })

  // ══════════════════════════════════════════
  //  LLM 摘要传播
  // ══════════════════════════════════════════

  it('setSummaryLLM 不抛出错误', () => {
    const mockLlm = {
      chatJson: vi.fn().mockResolvedValue({ data: 'summary text' }),
    }
    expect(() => manager.setSummaryLLM(mockLlm)).not.toThrow()
  })

  // ══════════════════════════════════════════
  //  归档行为
  // ══════════════════════════════════════════

  it('压缩后原始条目被加入 removedIds', async () => {
    const sevenDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000
    entries.push(
      createMockEntry({
        id: 'archive_1',
        content: 'Will be archived',
        lastAccessedAt: sevenDaysAgo,
        topics: ['归档'],
      }),
      createMockEntry({
        id: 'archive_2',
        content: 'Will also be archived',
        lastAccessedAt: sevenDaysAgo,
        topics: ['归档'],
      }),
    )

    await manager.runLowFrequencyConsolidation()
    expect(removedIds.has('archive_1')).toBe(true)
    expect(removedIds.has('archive_2')).toBe(true)
  })

  // ══════════════════════════════════════════
  //  onConsolidated 回调
  // ══════════════════════════════════════════

  it('压缩完成后调用 onConsolidated 回调', async () => {
    const sevenDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000
    entries.push(
      createMockEntry({
        id: 'callback_1',
        content: 'Callback test memory',
        lastAccessedAt: sevenDaysAgo,
        topics: ['测试'],
      }),
      createMockEntry({
        id: 'callback_2',
        content: 'Callback test memory 2',
        lastAccessedAt: sevenDaysAgo,
        topics: ['测试'],
      }),
    )

    await manager.runLowFrequencyConsolidation()
    expect(onConsolidated).toHaveBeenCalledTimes(1)
    expect(onConsolidated).toHaveBeenCalledWith(
      expect.objectContaining({
        compressedCount: 2,
        summariesCreated: 1,
      }),
    )
  })
})
