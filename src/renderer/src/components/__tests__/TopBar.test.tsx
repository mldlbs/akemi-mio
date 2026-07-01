import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TopBar } from '../TopBar'
import { renderWithProviders } from '../../__tests__/renderWithProviders'
import { resetAllStores } from '../../store/reset'

beforeEach(() => {
  resetAllStores()
})

describe('TopBar', () => {
  it('renders logo', () => {
    renderWithProviders(<TopBar />)
    expect(screen.getByText('秋山澪')).toBeTruthy()
  })

  it('renders all slot toggle buttons', () => {
    renderWithProviders(<TopBar />)
    expect(screen.getByTitle('会话')).toBeTruthy()
    expect(screen.getByTitle('OTPAR 认知循环')).toBeTruthy()
    expect(screen.getByTitle('开发计划')).toBeTruthy()
    expect(screen.getByTitle('工作流')).toBeTruthy()
  })

  it('toggles sidebar on menu button click', () => {
    renderWithProviders(<TopBar />)
    const menuBtn = screen.getByTitle('收起侧栏')
    fireEvent.click(menuBtn)
    expect(screen.getByTitle('展开侧栏')).toBeTruthy()
  })

  it('chat slot button gets active class by default', () => {
    renderWithProviders(<TopBar />)
    const chatBtn = screen.getByTitle('会话')
    expect(chatBtn.classList.contains('active')).toBe(true)
  })

  it('switches active slot on OTPAR button click', () => {
    renderWithProviders(<TopBar />)
    const otparBtn = screen.getByTitle('OTPAR 认知循环')
    fireEvent.click(otparBtn)
    expect(otparBtn.classList.contains('active')).toBe(true)
    fireEvent.click(otparBtn)
    expect(screen.getByTitle('会话').classList.contains('active')).toBe(true)
  })

  it('switches active slot on devplan button click', () => {
    renderWithProviders(<TopBar />)
    const devplanBtn = screen.getByTitle('开发计划')
    fireEvent.click(devplanBtn)
    expect(devplanBtn.classList.contains('active')).toBe(true)
    fireEvent.click(devplanBtn)
    expect(screen.getByTitle('会话').classList.contains('active')).toBe(true)
  })

  it('switches active slot on workflow button click', () => {
    renderWithProviders(<TopBar />)
    const wfBtn = screen.getByTitle('工作流')
    fireEvent.click(wfBtn)
    expect(wfBtn.classList.contains('active')).toBe(true)
    fireEvent.click(wfBtn)
    expect(screen.getByTitle('会话').classList.contains('active')).toBe(true)
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
