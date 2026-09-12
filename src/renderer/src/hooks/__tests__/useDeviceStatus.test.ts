import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDeviceStatus } from '../useDeviceStatus'
import { createMockIPC } from '../../__tests__/mockIPC'

beforeEach(() => {
  window.electronAPI = createMockIPC() as any
})

describe('useDeviceStatus', () => {
  it('returns default initial state', () => {
    const { result } = renderHook(() => useDeviceStatus())
    expect(result.current.active).toBe(false)
    expect(result.current.ttsPlaying).toBe(false)
    expect(result.current.error).toBeUndefined()
    expect(result.current.sessionHealth).toBe('100:HEALTHY:RUNNING')
    expect(result.current.personaLevel).toBe('core')
    expect(result.current.settingsOpen).toBe(false)
  })

  it('updates state from onStateUpdate event', () => {
    let onStateHandler: Function = () => {}
    window.electronAPI.onStateUpdate = vi.fn().mockImplementation((cb: Function) => {
      onStateHandler = cb
      return vi.fn()
    }) as any

    const { result } = renderHook(() => useDeviceStatus())
    act(() => {
      onStateHandler({ error: 'Something broke', ttsPlaying: true, sessionHealth: '80:DEGRADED:memory' })
    })
    expect(result.current.error).toBe('Something broke')
    expect(result.current.ttsPlaying).toBe(true)
    expect(result.current.sessionHealth).toBe('80:DEGRADED:memory')
  })

  it('updates personaLevel from onPersonaUpdated event', () => {
    let onPersonaHandler: Function = () => {}
    window.electronAPI.onPersonaUpdated = vi.fn().mockImplementation((cb: Function) => {
      onPersonaHandler = cb
      return vi.fn()
    }) as any

    const { result } = renderHook(() => useDeviceStatus())
    act(() => {
      onPersonaHandler({ level: 'expert' })
    })
    expect(result.current.personaLevel).toBe('expert')
  })

  it('setters update state correctly', () => {
    const { result } = renderHook(() => useDeviceStatus())
    act(() => {
      result.current.setActive(true)
    })
    expect(result.current.active).toBe(true)
    act(() => {
      result.current.setError('new error')
    })
    expect(result.current.error).toBe('new error')
    act(() => {
      result.current.setSettingsOpen(true)
    })
    expect(result.current.settingsOpen).toBe(true)
  })
})
