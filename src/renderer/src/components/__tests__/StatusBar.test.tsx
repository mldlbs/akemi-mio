import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatusBar } from '../StatusBar'
import { resetAllStores } from '../../store/reset'
import { useDeviceStore } from '../../store/deviceStore'
import { useAgentStore } from '../../store/agentStore'

beforeEach(() => {
  resetAllStores()
})

describe('StatusBar', () => {
  it('shows "待命" when idle', () => {
    render(<StatusBar />)
    expect(screen.getByText('待命')).toBeTruthy()
  })

  it('shows "正在聆听" when conversation is active', () => {
    useDeviceStore.getState().setActive(true)
    render(<StatusBar />)
    expect(screen.getByText('正在聆听')).toBeTruthy()
  })

  it('shows "思考中" when agentState is thinking', () => {
    useAgentStore.getState().setAgentState('thinking')
    render(<StatusBar />)
    expect(screen.getByText('思考中')).toBeTruthy()
  })

  it('shows "执行工具" when agentState is tool_executing', () => {
    useAgentStore.getState().setAgentState('tool_executing')
    render(<StatusBar />)
    expect(screen.getByText('执行工具')).toBeTruthy()
  })

  it('shows "回复中" when ttsPlaying', () => {
    useDeviceStore.getState().setTtsPlaying(true)
    render(<StatusBar />)
    expect(screen.getByText('回复中')).toBeTruthy()
  })

  it('shows health display', () => {
    useDeviceStore.getState().setSessionHealth('85:HEALTHY:memory')
    render(<StatusBar />)
    expect(screen.getByText('85 HEALTHY')).toBeTruthy()
  })

  it('shows persona badge for non-core levels', () => {
    useDeviceStore.getState().setPersonaLevel('writer')
    render(<StatusBar />)
    expect(screen.getByText('写作')).toBeTruthy()
  })

  it('does NOT show persona badge for core level', () => {
    const { container } = render(<StatusBar />)
    expect(container.querySelector('.persona-badge')).toBeNull()
  })

  it('shows error text when provided', () => {
    useDeviceStore.getState().setError('Something went wrong')
    render(<StatusBar />)
    expect(screen.getByText('Something went wrong')).toBeTruthy()
  })
})
