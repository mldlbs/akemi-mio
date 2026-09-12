import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EvolutionHistoryManager } from '@akemi-mio/evolution/EvolutionHistory'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, rmSync } from 'fs'

vi.mock('@akemi-mio/core/logger/Logger', () => ({ log: vi.fn() }))

function makeTempPath(): string {
  const d = join(tmpdir(), `evolution-history-test-${Date.now()}`)
  mkdirSync(d, { recursive: true })
  return join(d, 'history.json')
}

describe('EvolutionHistoryManager', () => {
  let historyPath: string
  let manager: EvolutionHistoryManager

  beforeEach(() => {
    historyPath = makeTempPath()
    manager = new EvolutionHistoryManager(historyPath)
  })

  afterEach(() => {
    try {
      rmSync(historyPath.replace(/\/[^/]+$/, ''), { recursive: true })
    } catch {
      /* ignore */
    }
  })

  it('load 返回空历史', () => {
    expect(manager.load().cycles).toEqual([])
  })

  it('recordCycle 保存后 load 可读取', () => {
    manager.recordCycle({
      timestamp: Date.now(),
      perspective: '分析',
      summary: '测试摘要',
      planCreated: false,
      stepsCompleted: 0,
      stepsTotal: 0,
      success: true,
    })
    expect(manager.load().cycles).toHaveLength(1)
  })

  it('getHistorySummary 空历史返回首次运行提示', () => {
    expect(manager.getHistorySummary(5)).toContain('首次运行')
  })

  it('getHistorySummary 包含成功记录', () => {
    manager.recordCycle({
      timestamp: Date.now(),
      perspective: '分析',
      summary: '某次分析结果',
      planCreated: true,
      planTitle: '优化计划',
      stepsCompleted: 1,
      stepsTotal: 3,
      success: true,
    })
    const summary = manager.getHistorySummary(5)
    expect(summary).toContain('成功')
    expect(summary).toContain('优化计划')
  })

  it('loadRecentFailures 只返回失败', () => {
    manager.recordCycle({
      timestamp: Date.now(),
      perspective: '分析',
      summary: 'OK',
      planCreated: false,
      stepsCompleted: 0,
      stepsTotal: 0,
      success: true,
    })
    manager.recordCycle({
      timestamp: Date.now(),
      perspective: '执行',
      summary: '超时失败',
      planCreated: false,
      stepsCompleted: 0,
      stepsTotal: 0,
      success: false,
    })
    expect(manager.loadRecentFailures()).toHaveLength(1)
  })

  it('max 20 entries enforced', () => {
    for (let i = 0; i < 25; i++) {
      manager.recordCycle({
        timestamp: Date.now(),
        perspective: '循环',
        summary: `条目 ${i}`,
        planCreated: false,
        stepsCompleted: 0,
        stepsTotal: 0,
        success: true,
      })
    }
    expect(manager.load().cycles.length).toBeLessThanOrEqual(20)
  })
})
