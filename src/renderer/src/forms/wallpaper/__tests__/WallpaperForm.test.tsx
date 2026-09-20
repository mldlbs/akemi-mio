/**
 * WallpaperForm 的单元测试。
 *
 * 壁纸是三个形态里唯一"没人会主动打开看对不对"的：它铺在桌面最底层，
 * 鼠标穿透、不抢焦点，坏了也只表现为"背景好像少了点什么"。
 * 所以这里重点锁死三件容易静默失效的事：
 *
 * 1. 星图布局必须确定性。用 Math.random() 的话每次刷新星点会完全重排，
 *    视觉上像"闪了一下"，而且是那种截图对比才能发现的问题。
 * 2. 信息卡槽位的优先级：对话语境 > 记忆卡片，且**对话清空后要能回落到记忆**。
 *    两个源各自订阅、共享一个槽位，回落写错就会永久留一张空卡。
 * 3. 进度值必须夹到 0–100。数据源的进度是估算值，越界时宽度会撑破卡片，
 *    而 aria-valuenow 超过 valuemax 对读屏软件是非法值。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, act } from '@testing-library/react'
import type { ConversationContext, MemoryCard } from '../../runtime'

/**
 * 订阅者集合（而非单个变量）。
 *
 * 真实 preload 的 ipcRenderer.on 支持**多个**监听器，组件里也确实有
 * 多个 useEffect 各自订阅（广播 / 对话语境 / 记忆卡片）。用一个变量存 handler
 * 会让后订阅者覆盖前者，导致前一个订阅永远收不到事件 ——
 * 这是 mock 的失真，不是被测代码的问题。
 */
let broadcastHandlers: Set<(m: unknown) => void> = new Set()
let convHandlers: Set<(m: unknown) => void> = new Set()
let memHandlers: Set<(m: unknown) => void> = new Set()

/** 桥接可用性开关。壁纸依赖它决定要不要显示降级横幅。 */
let bridgeAvailable = true

function emitBroadcast(msg: { from: string; type: string; payload: unknown }) {
  for (const h of [...broadcastHandlers]) h(msg)
}
function emitConversation(ctx: ConversationContext) {
  for (const h of [...convHandlers]) h(ctx)
}
function emitMemory(cards: MemoryCard[]) {
  for (const h of [...memHandlers]) h(cards)
}

vi.mock('../../runtime', () => ({
  hasFormBridge: () => bridgeAvailable,
  onBroadcast: (handler: (m: unknown) => void) => {
    broadcastHandlers.add(handler)
    return () => {
      broadcastHandlers.delete(handler)
    }
  },
  onConversationContext: (handler: (m: unknown) => void) => {
    convHandlers.add(handler)
    return () => {
      convHandlers.delete(handler)
    }
  },
  onMemoryCards: (handler: (m: unknown) => void) => {
    memHandlers.add(handler)
    return () => {
      memHandlers.delete(handler)
    }
  },
}))

/** 每个用例都重新 import 一次：星图用模块级函数生成，重挂载才测得准确定性。 */
async function renderWallpaper() {
  vi.resetModules()
  const { WallpaperForm } = await import('../WallpaperForm')
  return render(<WallpaperForm />)
}

/** mood → 色相的期望值，与组件内 MOOD_HUE 一一对应。 */
const HUE = { idle: '55', happy: '75', thinking: '250', alert: '30', sleepy: '290' } as const

/** 读出根节点的 --wp-hue（情绪的唯一可视化出口）。 */
function stageHue(container: HTMLElement): string {
  const stage = container.querySelector('.wp-stage') as HTMLElement
  return stage.style.getPropertyValue('--wp-hue').trim()
}

function makeCtx(activeTasks: ConversationContext['activeTasks'], summary = ''): ConversationContext {
  return {
    summary,
    summaryConfidence: 0.8,
    activeTasks,
    completedTasks: 0,
    totalTasks: activeTasks.length,
    // 整体进度取活跃任务的均值；无任务时为 0，与后端的语义一致
    progressPercent: activeTasks.length ? Math.round(activeTasks.reduce((s, t) => s + t.progressPercent, 0) / activeTasks.length) : 0,
    hasData: activeTasks.length > 0 || summary.trim().length > 0,
  }
}

function task(id: string, title: string, status: string, progressPercent: number) {
  return { taskId: id, title, status, progressPercent, completedSteps: 1, totalSteps: 4 }
}

function card(id: string, content: string, isPinned = false): MemoryCard {
  return {
    id,
    content,
    type: 'note',
    confidence: 0.9,
    isPinned,
    topics: [],
    updatedAt: Date.now(),
  }
}

beforeEach(() => {
  broadcastHandlers = new Set()
  convHandlers = new Set()
  memHandlers = new Set()
  bridgeAvailable = true
  vi.useFakeTimers()
  // 固定系统时间，让时钟断言可复现（06:07 保证 padStart 生效）
  vi.setSystemTime(new Date(2026, 8, 13, 6, 7, 0))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('WallpaperForm 星图', () => {
  it('渲染固定数量的星点', async () => {
    const { container } = await renderWallpaper()
    expect(container.querySelectorAll('.wp-star')).toHaveLength(140)
  })

  it('星点不带 animationDelay（闪烁动画已移除，别再挂回去）', async () => {
    const { container } = await renderWallpaper()
    for (const star of container.querySelectorAll('.wp-star')) {
      expect((star as HTMLElement).style.animationDelay).toBe('')
      expect((star as HTMLElement).style.animationName).toBe('')
    }
  })

  it('壁纸样式里不存在任何无限动画（回归：曾因它空闲吃满一个 GPU 核）', async () => {
    const css = readFileSync(join(process.cwd(), 'src/renderer/src/forms/wallpaper/styles.css'), 'utf8')
    // 去掉注释再扫，避免把说明文字里的 "infinite" 当成真动画
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(stripped).not.toContain('infinite')
  })

  it('两次挂载星点布局完全一致（刷新不会"闪一下"）', async () => {
    const a = await renderWallpaper()
    const posA = [...a.container.querySelectorAll('.wp-star')].map((c) => `${c.getAttribute('cx')},${c.getAttribute('cy')}`)
    a.unmount()

    const b = await renderWallpaper()
    const posB = [...b.container.querySelectorAll('.wp-star')].map((c) => `${c.getAttribute('cx')},${c.getAttribute('cy')}`)

    expect(posB).toEqual(posA)
    // 顺带确认不是退化成"全部堆在原点"
    expect(new Set(posA).size).toBeGreaterThan(100)
  })

  it('星点对读屏隐藏（纯装饰）', async () => {
    const { container } = await renderWallpaper()
    expect(container.querySelector('.wp-stars')?.getAttribute('aria-hidden')).toBe('true')
  })
})

describe('WallpaperForm 色相跟随情绪', () => {
  it('默认 idle', async () => {
    const { container } = await renderWallpaper()
    expect(stageHue(container)).toBe(HUE.idle)
  })

  it('pet:mood 广播带动壁纸色相', async () => {
    const { container } = await renderWallpaper()
    act(() => {
      emitBroadcast({ from: 'pet', type: 'pet:mood', payload: { mood: 'thinking' } })
    })
    expect(stageHue(container)).toBe(HUE.thinking)
  })

  it('wallpaper:mood 也能改（允许外部直接指定）', async () => {
    const { container } = await renderWallpaper()
    act(() => {
      emitBroadcast({ from: 'shell', type: 'wallpaper:mood', payload: { mood: 'sleepy' } })
    })
    expect(stageHue(container)).toBe(HUE.sleepy)
  })

  it('忽略来自自身的广播（不回环）', async () => {
    const { container } = await renderWallpaper()
    act(() => {
      emitBroadcast({ from: 'wallpaper', type: 'pet:mood', payload: { mood: 'alert' } })
    })
    expect(stageHue(container)).toBe(HUE.idle)
  })

  it('payload 缺 mood 字段时不改色（不崩）', async () => {
    const { container } = await renderWallpaper()
    act(() => {
      emitBroadcast({ from: 'pet', type: 'pet:mood', payload: {} })
    })
    expect(stageHue(container)).toBe(HUE.idle)
  })
})

describe('WallpaperForm 信息卡：对话语境', () => {
  it('有进行中任务时展示任务与进度', async () => {
    const { container } = await renderWallpaper()
    act(() => {
      emitConversation(makeCtx([task('t1', '重构 Lifecycle', 'running', 42)]))
    })
    expect(container.querySelector('.wp-info-title')?.textContent).toBe('进行中')
    expect(container.querySelector('.wp-info-body')?.textContent).toBe('重构 Lifecycle')
    expect(container.querySelector('.wp-info-progress')?.getAttribute('aria-valuenow')).toBe('42')
  })

  it('多个任务时标注"另有 N 项"', async () => {
    const { container } = await renderWallpaper()
    act(() => {
      emitConversation(
        makeCtx([task('t1', '重构 Lifecycle', 'running', 10), task('t2', '补测试', 'running', 20), task('t3', '写文档', 'running', 30)]),
      )
    })
    expect(container.querySelector('.wp-info-body')?.textContent).toBe('重构 Lifecycle · 另有 2 项')
  })

  it('已完成任务不算进行中', async () => {
    const { container } = await renderWallpaper()
    act(() => {
      emitConversation(makeCtx([task('t1', '重构 Lifecycle', 'completed', 100)], '全部做完了'))
    })
    // 没有进行中任务 → 落到摘要分支
    expect(container.querySelector('.wp-info-title')?.textContent).toBe('最近')
    expect(container.querySelector('.wp-info-body')?.textContent).toBe('全部做完了')
    // 摘要没有进度概念，不应渲染进度条
    expect(container.querySelector('.wp-info-progress')).toBeNull()
  })

  it('摘要超过 120 字时截断', async () => {
    const { container } = await renderWallpaper()
    act(() => {
      emitConversation(makeCtx([], 'B'.repeat(200)))
    })
    expect(container.querySelector('.wp-info-body')?.textContent).toBe(`${'B'.repeat(120)}…`)
  })

  it('无任务且摘要为空时不显示卡片（不留空框）', async () => {
    const { container } = await renderWallpaper()
    act(() => {
      emitConversation(makeCtx([], '   '))
    })
    expect(container.querySelector('.wp-info')).toBeNull()
  })
})

describe('WallpaperForm 信息卡：记忆', () => {
  it('展示记忆内容', async () => {
    const { container } = await renderWallpaper()
    act(() => {
      emitMemory([card('m1', '用户偏好暗色')])
    })
    expect(container.querySelector('.wp-info-title')?.textContent).toBe('记忆')
    expect(container.querySelector('.wp-info-body')?.textContent).toBe('用户偏好暗色')
  })

  it('置顶记忆优先', async () => {
    const { container } = await renderWallpaper()
    act(() => {
      emitMemory([card('m1', '普通记忆'), card('m2', '重要记忆', true)])
    })
    expect(container.querySelector('.wp-info-title')?.textContent).toBe('置顶记忆')
    expect(container.querySelector('.wp-info-body')?.textContent).toBe('重要记忆')
  })

  it('无置顶时取第一条', async () => {
    const { container } = await renderWallpaper()
    act(() => {
      emitMemory([card('m1', '第一条'), card('m2', '第二条')])
    })
    expect(container.querySelector('.wp-info-body')?.textContent).toBe('第一条')
  })

  it('空数组不显示卡片', async () => {
    const { container } = await renderWallpaper()
    act(() => {
      emitMemory([])
    })
    expect(container.querySelector('.wp-info')).toBeNull()
  })

  it('内容全空白的记忆不占位', async () => {
    const { container } = await renderWallpaper()
    act(() => {
      emitMemory([card('m1', '   ')])
    })
    expect(container.querySelector('.wp-info')).toBeNull()
  })
})

describe('WallpaperForm 两个数据源的优先级', () => {
  it('对话优先于记忆', async () => {
    const { container } = await renderWallpaper()
    act(() => {
      emitMemory([card('m1', '来自记忆')])
      emitConversation(makeCtx([task('t1', '手上的活', 'running', 5)]))
    })
    expect(container.querySelector('.wp-info-body')?.textContent).toBe('手上的活')
  })

  it('对话清空后回落到记忆（不会永久留空）', async () => {
    const { container } = await renderWallpaper()
    act(() => {
      emitMemory([card('m1', '来自记忆')])
      emitConversation(makeCtx([task('t1', '手上的活', 'running', 5)]))
    })
    expect(container.querySelector('.wp-info-body')?.textContent).toBe('手上的活')

    // 任务做完、摘要清空 → 对话源不再产出，应回落到已缓存的记忆
    act(() => {
      emitConversation(makeCtx([task('t1', '手上的活', 'completed', 100)], ''))
    })
    expect(container.querySelector('.wp-info-body')?.textContent).toBe('来自记忆')
  })

  it('记忆先到、对话后到时也要切到对话', async () => {
    const { container } = await renderWallpaper()
    act(() => {
      emitMemory([card('m1', '来自记忆')])
    })
    act(() => {
      emitConversation(makeCtx([], '对话摘要'))
    })
    expect(container.querySelector('.wp-info-body')?.textContent).toBe('对话摘要')
  })
})

describe('WallpaperForm 进度值边界', () => {
  async function progressOf(raw: number) {
    const { container } = await renderWallpaper()
    act(() => {
      emitConversation(makeCtx([task('t1', '任务', 'running', raw)]))
    })
    const bar = container.querySelector('.wp-info-progress')!
    return {
      now: bar.getAttribute('aria-valuenow'),
      width: (container.querySelector('.wp-info-progress-fill') as HTMLElement).style.width,
    }
  }

  it('超过 100 夹到 100（aria 不越界）', async () => {
    const r = await progressOf(150)
    expect(r.now).toBe('100')
    expect(r.width).toBe('100%')
  })

  it('负数夹到 0', async () => {
    const r = await progressOf(-20)
    expect(r.now).toBe('0')
    expect(r.width).toBe('0%')
  })

  it('NaN 退化为 0（不产生 "NaN%"）', async () => {
    const r = await progressOf(NaN)
    expect(r.now).toBe('0')
    expect(r.width).toBe('0%')
    expect(r.width).not.toContain('NaN')
  })
})

describe('WallpaperForm 时钟与降级', () => {
  it('显示零填充的时分与月日', async () => {
    const { container } = await renderWallpaper()
    expect(container.querySelector('.wp-clock-time')?.textContent).toBe('06:07')
    expect(container.querySelector('.wp-clock-date')?.textContent).toBe('9月13日')
  })

  it('20 秒后时钟更新', async () => {
    const { container } = await renderWallpaper()
    act(() => {
      vi.advanceTimersByTime(20_000)
    })
    expect(container.querySelector('.wp-clock-time')?.textContent).toBe('06:07')
    // 再走 5 分钟，分钟数应变化
    act(() => {
      vi.setSystemTime(new Date(2026, 8, 13, 6, 12, 0))
      vi.advanceTimersByTime(20_000)
    })
    expect(container.querySelector('.wp-clock-time')?.textContent).toBe('06:12')
  })

  it('有桥接时不显示降级横幅', async () => {
    const { container } = await renderWallpaper()
    expect(container.querySelector('.form-degraded-banner')).toBeNull()
  })

  it('无桥接时显示降级横幅（浏览器里预览也能看懂）', async () => {
    bridgeAvailable = false
    const { container } = await renderWallpaper()
    expect(container.querySelector('.form-degraded-banner')?.textContent).toContain('预览模式')
  })
})

describe('WallpaperForm 订阅清理', () => {
  it('卸载后三个订阅都被取消（不会泄漏监听）', async () => {
    const r = await renderWallpaper()
    expect(broadcastHandlers.size).toBe(1)
    expect(convHandlers.size).toBe(1)
    expect(memHandlers.size).toBe(1)

    r.unmount()
    expect(broadcastHandlers.size).toBe(0)
    expect(convHandlers.size).toBe(0)
    expect(memHandlers.size).toBe(0)
  })

  it('卸载后收到广播不再 setState（不会告警）', async () => {
    const r = await renderWallpaper()
    r.unmount()
    expect(() => {
      emitBroadcast({ from: 'pet', type: 'pet:mood', payload: { mood: 'happy' } })
      emitConversation(makeCtx([task('t1', 'x', 'running', 1)]))
      emitMemory([card('m1', 'y')])
    }).not.toThrow()
  })
})
