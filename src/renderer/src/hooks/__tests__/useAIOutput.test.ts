import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useAIOutput } from '../useAIOutput'
import { createMockIPC } from '../../__tests__/mockIPC'

// Mock audioShared since it uses Web Audio API module-level state
vi.mock('../../components/audioShared', () => ({
  playTTS: vi.fn(),
  playTTSBuffer: vi.fn(),
  onTTSStart: vi.fn(),
  onTTSError: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  window.electronAPI = createMockIPC() as any
  // Ensure useTimerControl's setInterval uses real setInterval for the test env
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useAIOutput', () => {
  function captureCallbacks() {
    const cbs: Record<string, Function> = {}
    window.electronAPI.onAIChunk = vi.fn().mockImplementation((cb: Function) => {
      cbs.onAIChunk = cb
      return vi.fn()
    }) as any
    window.electronAPI.onTTSAudio = vi.fn().mockImplementation((cb: Function) => {
      cbs.onTTSAudio = cb
      return vi.fn()
    }) as any
    window.electronAPI.onTTSBuffer = vi.fn().mockImplementation((cb: Function) => {
      cbs.onTTSBuffer = cb
      return vi.fn()
    }) as any
    window.electronAPI.onMessageNew = vi.fn().mockImplementation((cb: Function) => {
      cbs.onMessageNew = cb
      return vi.fn()
    }) as any
    window.electronAPI.onToolStatus = vi.fn().mockImplementation((cb: Function) => {
      cbs.onToolStatus = cb
      return vi.fn()
    }) as any
    return cbs
  }

  it('returns initial state', () => {
    const { result } = renderHook(() => useAIOutput('sess-1', false, vi.fn()))
    expect(result.current.agentState).toBe('idle')
    expect(result.current.pendingText).toBe('')
    expect(result.current.displayText).toBe('')
    expect(result.current.transcribed).toBe('')
    expect(result.current.toolStatus).toBeNull()
    expect(result.current.voiceIntentPrompt).toBeNull()
  })

  it('handleTextSubmit calls chat and sets agentState to thinking', async () => {
    const { result } = renderHook(() => useAIOutput('sess-1', false, vi.fn()))
    await act(async () => {
      await result.current.handleTextSubmit('hello')
    })
    expect(result.current.transcribed).toBe('')
    expect(result.current.agentState).toBe('thinking')
    expect(window.electronAPI.chat).toHaveBeenCalledWith('hello', undefined, 'sess-1', !false)
  })

  it('handleTextSubmit does not attempt voice intent matching', async () => {
    const { result } = renderHook(() => useAIOutput('sess-1', false, vi.fn()))
    await act(async () => {
      await result.current.handleTextSubmit('打开 README.md')
    })
    expect(window.electronAPI.matchVoiceIntent).not.toHaveBeenCalled()
    expect(window.electronAPI.chat).toHaveBeenCalledWith('打开 README.md', undefined, 'sess-1', true)
  })

  it('handleVoiceResult passes noTts=true when voiceActive is false', async () => {
    const { result } = renderHook(() => useAIOutput('sess-1', false, vi.fn()))
    await act(async () => {
      await result.current.handleVoiceResult('hi')
    })
    expect(window.electronAPI.chat).toHaveBeenCalledWith('hi', undefined, 'sess-1', true)
  })

  it('handleVoiceResult passes noTts=false when voiceActive is true', async () => {
    const { result } = renderHook(() => useAIOutput('sess-1', true, vi.fn()))
    await act(async () => {
      await result.current.handleVoiceResult('hi')
    })
    expect(window.electronAPI.chat).toHaveBeenCalledWith('hi', undefined, 'sess-1', false)
  })

  it('stores a voice intent prompt instead of opening a blocking flow immediately', async () => {
    window.electronAPI.matchVoiceIntent = vi.fn().mockResolvedValue({
      matched: true,
      intent: {
        name: 'read_file',
        description: '读取文件内容',
        confirmMessage: '将读取文件 README.md',
        toolSequence: [{ tool: 'read_file', args: { path: 'README.md' } }],
        slots: { filename: 'README.md' },
      },
    })

    const { result } = renderHook(() => useAIOutput('sess-1', true, vi.fn()))
    await act(async () => {
      await result.current.handleVoiceResult('打开 README.md')
    })

    expect(result.current.voiceIntentPrompt?.intent.description).toBe('读取文件内容')
    expect(result.current.voiceIntentPrompt?.intent.toolSequence).toHaveLength(1)
    expect(window.electronAPI.chat).not.toHaveBeenCalled()
    expect(window.electronAPI.executeVoiceChain).not.toHaveBeenCalled()
  })

  it('can send a matched voice intent as normal chat', async () => {
    window.electronAPI.matchVoiceIntent = vi.fn().mockResolvedValue({
      matched: true,
      intent: {
        name: 'read_file',
        description: '读取文件内容',
        confirmMessage: '将读取文件 README.md',
        toolSequence: [{ tool: 'read_file', args: { path: 'README.md' } }],
        slots: { filename: 'README.md' },
      },
    })

    const { result } = renderHook(() => useAIOutput('sess-1', true, vi.fn()))
    await act(async () => {
      await result.current.handleVoiceResult('打开 README.md')
    })
    await act(async () => {
      await result.current.sendVoiceIntentAsChat()
    })

    expect(window.electronAPI.chat).toHaveBeenCalledWith('打开 README.md', undefined, 'sess-1', false)
    expect(result.current.voiceIntentPrompt).toBeNull()
  })

  it('executes the queued voice intent after confirmation', async () => {
    window.electronAPI.matchVoiceIntent = vi.fn().mockResolvedValue({
      matched: true,
      intent: {
        name: 'read_file',
        description: '读取文件内容',
        confirmMessage: '将读取文件 README.md',
        toolSequence: [{ tool: 'read_file', args: { path: 'README.md' } }],
        slots: { filename: 'README.md' },
      },
    })
    window.electronAPI.executeVoiceChain = vi.fn().mockResolvedValue({
      success: true,
      steps: [{ tool: 'read_file', success: true, output: 'README contents', durationMs: 25 }],
      summary: 'done',
    })

    const { result } = renderHook(() => useAIOutput('sess-1', true, vi.fn()))
    await act(async () => {
      await result.current.handleVoiceResult('打开 README.md')
    })
    await act(async () => {
      await result.current.confirmVoiceIntent()
    })

    expect(window.electronAPI.executeVoiceChain).toHaveBeenCalledWith('read_file', { filename: 'README.md' })
    expect(result.current.voiceIntentPrompt).toBeNull()
    expect(result.current.agentState).toBe('replying')
  })

  it('appends chunks from onAIChunk event', () => {
    const cbs = captureCallbacks()
    const { result } = renderHook(() => useAIOutput('sess-1', false, vi.fn()))
    act(() => {
      cbs.onAIChunk('Hello')
      vi.advanceTimersByTime(16)
    })
    act(() => {
      cbs.onAIChunk(' World')
      vi.advanceTimersByTime(16)
    })
    expect(result.current.pendingText).toBe('Hello World')
  })

  it('transitions to replying on first chunk when thinking', () => {
    const cbs = captureCallbacks()
    const { result } = renderHook(() => useAIOutput('sess-1', false, vi.fn()))
    // simulate thinking state from handleResult
    act(() => {
      result.current.handleTextSubmit('hi').catch(() => {})
    }) // fire-and-forget for state
    act(() => {
      cbs.onAIChunk('reply')
      vi.advanceTimersByTime(16)
    })
    expect(result.current.agentState).toBe('replying')
  })

  it('clears state on onMessageNew with assistant role and sessionId', () => {
    const cbs = captureCallbacks()
    const { result } = renderHook(() => useAIOutput('sess-1', false, vi.fn()))
    // Set some state first
    act(() => {
      cbs.onAIChunk('previous reply')
      vi.advanceTimersByTime(16)
    })
    expect(result.current.pendingText).toBe('previous reply')
    // Final message arrives
    act(() => {
      cbs.onMessageNew({ id: 'm1', role: 'assistant', sessionId: 'sess-1' })
    })
    expect(result.current.pendingText).toBe('')
    expect(result.current.agentState).toBe('idle')
  })

  it('does NOT clear state on onMessageNew without sessionId', () => {
    const cbs = captureCallbacks()
    const { result } = renderHook(() => useAIOutput('sess-1', false, vi.fn()))
    act(() => {
      cbs.onAIChunk('pending')
      vi.advanceTimersByTime(16)
    })
    act(() => {
      cbs.onMessageNew({ id: 'm1', role: 'assistant' })
    })
    expect(result.current.pendingText).toBe('pending')
  })

  it('sets tool_executing on tool:status start', () => {
    const cbs = captureCallbacks()
    const { result } = renderHook(() => useAIOutput('sess-1', false, vi.fn()))
    act(() => {
      cbs.onToolStatus({ type: 'start', tool: 'search', message: 'searching' })
    })
    expect(result.current.toolStatus?.tool).toBe('search')
    expect(result.current.agentState).toBe('tool_executing')
  })

  it('returns to replying on tool:status end', () => {
    const cbs = captureCallbacks()
    const { result } = renderHook(() => useAIOutput('sess-1', false, vi.fn()))
    act(() => {
      cbs.onToolStatus({ type: 'start', tool: 'search', message: '' })
    })
    expect(result.current.agentState).toBe('tool_executing')
    act(() => {
      cbs.onToolStatus({ type: 'end', tool: 'search', message: '' })
    })
    expect(result.current.agentState).toBe('replying')
  })

  it('triggers onError callback when chat fails', async () => {
    window.electronAPI.chat = vi.fn().mockRejectedValue(new Error('network error'))
    const onError = vi.fn()
    const { result } = renderHook(() => useAIOutput('sess-1', false, onError))
    await act(async () => {
      await result.current.handleTextSubmit('hi')
    })
    expect(onError).toHaveBeenCalledWith('Error: network error')
  })

  it('clears onError on successful handleTextSubmit start', async () => {
    const onError = vi.fn()
    const { result } = renderHook(() => useAIOutput('sess-1', false, onError))
    await act(async () => {
      await result.current.handleTextSubmit('hi')
    })
    expect(onError).toHaveBeenCalledWith(undefined)
  })

  it('clears state when session switches', () => {
    const cbs = captureCallbacks()
    const onError = vi.fn()
    const { result, rerender } = renderHook(({ sessionId, voiceActive, onError: onErr }) => useAIOutput(sessionId, voiceActive, onErr), {
      initialProps: { sessionId: 'sess-1', voiceActive: false, onError },
    })
    // Populate some state
    act(() => {
      cbs.onAIChunk('old data')
    })
    act(() => {
      result.current.handleTextSubmit('test').catch(() => {})
    })
    // Switch session
    rerender({ sessionId: 'sess-2', voiceActive: false, onError })
    expect(result.current.pendingText).toBe('')
    expect(result.current.displayText).toBe('')
    expect(result.current.transcribed).toBe('')
    expect(result.current.voiceIntentPrompt).toBeNull()
    expect(result.current.agentState).toBe('idle')
  })

  it('handles empty text in handleTextSubmit', async () => {
    const { result } = renderHook(() => useAIOutput('sess-1', false, vi.fn()))
    await act(async () => {
      await result.current.handleTextSubmit('')
    })
    expect(window.electronAPI.chat).not.toHaveBeenCalled()
  })
})
