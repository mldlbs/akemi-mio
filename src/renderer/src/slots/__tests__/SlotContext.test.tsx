import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { SlotProvider, useSlots } from '../SlotContext'

describe('SlotContext', () => {
  it('throws when useSlots is used outside SlotProvider', () => {
    expect(() => {
      renderHook(() => useSlots())
    }).toThrow('useSlots must be used within SlotProvider')
  })

  it('returns default state when inside provider', () => {
    const { result } = renderHook(() => useSlots(), { wrapper: SlotProvider })
    expect(result.current.uiState.sidebarOpen).toBe(true)
    expect(result.current.uiState.activeSlot).toBe('chat')
  })

  it('setActiveSlot updates activeSlot', () => {
    const { result } = renderHook(() => useSlots(), { wrapper: SlotProvider })
    act(() => {
      result.current.setActiveSlot('otpar')
    })
    expect(result.current.uiState.activeSlot).toBe('otpar')
  })

  it('setActiveSlot preserves sidebarOpen', () => {
    const { result } = renderHook(() => useSlots(), { wrapper: SlotProvider })
    act(() => {
      result.current.setActiveSlot('otpar')
    })
    expect(result.current.uiState.sidebarOpen).toBe(true)
  })

  it('toggleSidebar flips sidebarOpen to false', () => {
    const { result } = renderHook(() => useSlots(), { wrapper: SlotProvider })
    act(() => {
      result.current.toggleSidebar()
    })
    expect(result.current.uiState.sidebarOpen).toBe(false)
  })

  it('toggleSidebar flips sidebarOpen back to true', () => {
    const { result } = renderHook(() => useSlots(), { wrapper: SlotProvider })
    act(() => {
      result.current.toggleSidebar()
    })
    act(() => {
      result.current.toggleSidebar()
    })
    expect(result.current.uiState.sidebarOpen).toBe(true)
  })

  it('setActiveSlot with devplan updates activeSlot', () => {
    const { result } = renderHook(() => useSlots(), { wrapper: SlotProvider })
    act(() => {
      result.current.setActiveSlot('devplan')
    })
    expect(result.current.uiState.activeSlot).toBe('devplan')
  })

  it('setActiveSlot with workflow updates activeSlot', () => {
    const { result } = renderHook(() => useSlots(), { wrapper: SlotProvider })
    act(() => {
      result.current.setActiveSlot('workflow')
    })
    expect(result.current.uiState.activeSlot).toBe('workflow')
  })

  it('setActiveSlot with tool updates activeSlot', () => {
    const { result } = renderHook(() => useSlots(), { wrapper: SlotProvider })
    act(() => {
      result.current.setActiveSlot('tool')
    })
    expect(result.current.uiState.activeSlot).toBe('tool')
  })

  it('setActiveSlot with preview updates activeSlot', () => {
    const { result } = renderHook(() => useSlots(), { wrapper: SlotProvider })
    act(() => {
      result.current.setActiveSlot('preview')
    })
    expect(result.current.uiState.activeSlot).toBe('preview')
  })

  it('multiple setActiveSlot calls keep last value', () => {
    const { result } = renderHook(() => useSlots(), { wrapper: SlotProvider })
    act(() => {
      result.current.setActiveSlot('otpar')
    })
    act(() => {
      result.current.setActiveSlot('devplan')
    })
    act(() => {
      result.current.setActiveSlot('chat')
    })
    expect(result.current.uiState.activeSlot).toBe('chat')
  })

  it('toggleSidebar preserves activeSlot', () => {
    const { result } = renderHook(() => useSlots(), { wrapper: SlotProvider })
    act(() => {
      result.current.setActiveSlot('otpar')
    })
    act(() => {
      result.current.toggleSidebar()
    })
    expect(result.current.uiState.activeSlot).toBe('otpar')
  })
})
