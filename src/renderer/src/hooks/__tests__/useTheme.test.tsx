import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useTheme, ThemeProvider } from '../useTheme'
import { createMockIPC } from '../../__tests__/mockIPC'

function renderThemeHook() {
  return renderHook(() => useTheme(), { wrapper: ThemeProvider })
}

beforeEach(() => {
  window.electronAPI = createMockIPC() as any
  document.documentElement.dataset.theme = ''
})

describe('useTheme', () => {
  it('loads stored theme on mount and sets dataset', async () => {
    window.electronAPI.getCredential = vi.fn().mockResolvedValue('ocean')
    const { result } = renderThemeHook()
    await waitFor(() => expect(result.current.theme).toBe('ocean'))
    expect(document.documentElement.dataset.theme).toBe('ocean')
  })

  it('falls back to mio when stored theme is invalid', async () => {
    window.electronAPI.getCredential = vi.fn().mockResolvedValue('invalid-theme')
    const { result } = renderThemeHook()
    await waitFor(() => expect(result.current.theme).toBe('mio'))
  })

  it('falls back to mio when no stored theme', async () => {
    window.electronAPI.getCredential = vi.fn().mockResolvedValue(null)
    const { result } = renderThemeHook()
    await waitFor(() => expect(result.current.theme).toBe('mio'))
  })

  it('setTheme updates state, dataset, and persists', async () => {
    window.electronAPI.getCredential = vi.fn().mockResolvedValue('mio')
    const { result } = renderThemeHook()
    await waitFor(() => expect(result.current.theme).toBe('mio'))

    act(() => {
      result.current.setTheme('arctic')
    })
    expect(result.current.theme).toBe('arctic')
    expect(document.documentElement.dataset.theme).toBe('arctic')
    expect(window.electronAPI.setCredential).toHaveBeenCalledWith('theme', 'arctic')
  })

  it('throws when used outside ThemeProvider', () => {
    expect(() => renderHook(() => useTheme())).toThrow('useTheme must be used within ThemeProvider')
  })
})
