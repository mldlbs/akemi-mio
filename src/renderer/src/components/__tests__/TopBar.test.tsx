import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TopBar } from '../TopBar'
import { renderWithProviders } from '../../__tests__/renderWithProviders'
import { resetAllStores } from '../../store/reset'

beforeEach(() => {
  resetAllStores()
})

describe('TopBar', () => {
  /** 当前激活槽位：以 aria-current="page" 为准（可访问性契约），而非样式类。 */
  function activeSlot(): string | null {
    return document.querySelector('[data-slot][aria-current="page"]')?.getAttribute('data-slot') ?? null
  }

  it('renders logo', () => {
    renderWithProviders(<TopBar />)
    expect(screen.getByText('秋山澪')).toBeTruthy()
  })

  it('keeps window chrome focused on essential controls', () => {
    renderWithProviders(<TopBar />)
    expect(document.querySelector('.ri-checkbox-line')).toBeNull()
    expect(document.querySelector('.topbar-window-btn')).toBeTruthy()
    expect(document.querySelector('.topbar-close')).toBeTruthy()
  })

  it('renders all slot tabs in the nav bar', () => {
    renderWithProviders(<TopBar />)
    // TopBar 已从「下拉菜单」重构为常驻标签栏：槽位不再需要展开动作，
    // 每个 tab 以 data-slot 标识、以 aria-label 承载可读名称。
    for (const [slot, label] of [
      ['chat', '会话'],
      ['tool', '工具'],
      ['preview', '预览'],
      ['workflow', '工作流'],
      ['devplan', '开发计划'],
      ['otpar', 'OTPAR'],
    ] as const) {
      const tab = document.querySelector(`[data-slot="${slot}"]`)
      expect(tab).toBeTruthy()
      expect(tab!.getAttribute('aria-label')).toBe(label)
    }
  })

  it('toggles sidebar on menu button click', () => {
    renderWithProviders(<TopBar />)
    const menuBtn = screen.getByTitle('收起侧栏')
    fireEvent.click(menuBtn)
    expect(screen.getByTitle('展开侧栏')).toBeTruthy()
  })

  it('chat slot tab is active by default', () => {
    renderWithProviders(<TopBar />)
    // 激活态由 aria-current="page" 表达（可访问性契约），class 只是样式
    expect(activeSlot()).toBe('chat')
    expect(document.querySelector('[data-slot="chat"]')!.classList.contains('active')).toBe(true)
  })

  it('switches active slot on OTPAR tab click', () => {
    renderWithProviders(<TopBar />)
    fireEvent.click(document.querySelector('[data-slot="otpar"]')!)
    expect(activeSlot()).toBe('otpar')
  })

  it('switches active slot on devplan tab click', () => {
    renderWithProviders(<TopBar />)
    fireEvent.click(document.querySelector('[data-slot="devplan"]')!)
    expect(activeSlot()).toBe('devplan')
  })

  it('switches active slot on workflow tab click', () => {
    renderWithProviders(<TopBar />)
    fireEvent.click(document.querySelector('[data-slot="workflow"]')!)
    expect(activeSlot()).toBe('workflow')
  })

  it('renders settings button that calls onOpenSettings', () => {
    const onOpenSettings = vi.fn()
    renderWithProviders(<TopBar onOpenSettings={onOpenSettings} />)
    fireEvent.click(screen.getByTitle('设置'))
    expect(onOpenSettings).toHaveBeenCalled()
  })

  it('calls minimizeWindow on minimize button click', () => {
    renderWithProviders(<TopBar />)
    fireEvent.click(screen.getByTitle('最小化'))
    expect(window.electronAPI.minimizeWindow).toHaveBeenCalled()
  })

  it('calls closeWindow on close button click', () => {
    renderWithProviders(<TopBar />)
    fireEvent.click(screen.getByTitle('关闭'))
    expect(window.electronAPI.closeWindow).toHaveBeenCalled()
  })

  it('shows status from store via StatusBar', () => {
    renderWithProviders(<TopBar />)
    expect(screen.getByText('待命')).toBeTruthy()
  })

  it('shows sidebar as closed after toggle', () => {
    renderWithProviders(<TopBar />)
    expect(screen.getByTitle('收起侧栏')).toBeTruthy()
    fireEvent.click(screen.getByTitle('收起侧栏'))
    expect(screen.getByTitle('展开侧栏')).toBeTruthy()
  })
})
