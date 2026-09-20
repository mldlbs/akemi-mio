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

  it('上报「正常 resolve + error 字段」的失败，而不是静默丢弃', async () => {
    // 主进程用 resolve({error}) 表达熔断/内部错误/暂停，这类失败不进 catch。
    // 旧实现不接收返回值，用户只会看到「思考中」然后消失。
    window.electronAPI.chat = vi.fn().mockResolvedValue({ error: 'CIRCUIT_OPEN' })
    const onError = vi.fn()
    const { result } = renderHook(() => useAIOutput('sess-1', false, onError))
    await act(async () => {
      await result.current.handleTextSubmit('hi')
    })
    const shown = onError.mock.calls.map((c) => c[0]).find((v) => typeof v === 'string' && v.length > 0)
    expect(shown).toContain('自动恢复')
    expect(shown).not.toContain('CIRCUIT_OPEN')
  })

  it('正常回复时不产生任何错误文案', async () => {
    window.electronAPI.chat = vi.fn().mockResolvedValue({ reply: 'ok' })
    const onError = vi.fn()
    const { result } = renderHook(() => useAIOutput('sess-1', false, onError))
    await act(async () => {
      await result.current.handleTextSubmit('hi')
    })
    expect(onError.mock.calls.every((c) => c[0] === undefined)).toBe(true)
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

  // ── 提交被拒时不丢用户输入 ──
  // InputBar.handleSend 调用 onSend 之后立刻 setValue('')，输入框是组件内部 state，
  // 上层拿不到原文。所以「被拒的提交」必须由这里把原文还回去。
  describe('被拒绝的提交回填草稿', () => {
    it('BUSY：还回原文，并给出「正在处理上一条消息」的提示', async () => {
      window.electronAPI.chat = vi.fn().mockResolvedValue({ error: 'BUSY' })
      const onError = vi.fn()
      const { result } = renderHook(() => useAIOutput('sess-1', false, onError))
      await act(async () => {
        await result.current.handleTextSubmit('先发一条')
      })
      expect(result.current.restoreDraft?.text).toBe('先发一条')
      const shown = onError.mock.calls.map((c) => c[0]).find((v) => typeof v === 'string' && v.length > 0)
      expect(shown).toContain('正在处理上一条消息')
    })

    // CIRCUIT_OPEN 在 AgentService.processTextInput 的第一行返回、PAUSED 在 ai:chat handler 里
    // 直接返回，两者都早于 insertMessage —— 与 BUSY 同属「消息未落库」，同样可以安全回填。
    it.each(['CIRCUIT_OPEN', 'PAUSED'])('%s 也回填（同样在落库之前返回）', async (code) => {
      window.electronAPI.chat = vi.fn().mockResolvedValue({ error: code })
      const { result } = renderHook(() => useAIOutput('sess-1', false, vi.fn()))
      await act(async () => {
        await result.current.handleTextSubmit('草稿')
      })
      expect(result.current.restoreDraft?.text).toBe('草稿')
    })

    // TIMEOUT 等码产自 ChatExecutor.run() 内部，那时 insertMessage(userMsg) 已经执行 ——
    // 消息已在历史里，回填会让用户重发一遍，所以必须排除。
    it.each(['TIMEOUT', 'NETWORK', 'NO_KEY', 'EMPTY_RESPONSE', 'API_ERROR:503'])('%s 不回填（消息已落库）', async (code) => {
      window.electronAPI.chat = vi.fn().mockResolvedValue({ error: code })
      const { result } = renderHook(() => useAIOutput('sess-1', false, vi.fn()))
      await act(async () => {
        await result.current.handleTextSubmit('hi')
      })
      expect(result.current.restoreDraft).toBeNull()
    })

    it('正常回复不回填', async () => {
      window.electronAPI.chat = vi.fn().mockResolvedValue({ reply: 'ok' })
      const { result } = renderHook(() => useAIOutput('sess-1', false, vi.fn()))
      await act(async () => {
        await result.current.handleTextSubmit('hi')
      })
      expect(result.current.restoreDraft).toBeNull()
    })

    it('同一段文本被连拒两次 → token 递增（否则 InputBar 的 effect 不会重跑）', async () => {
      window.electronAPI.chat = vi.fn().mockResolvedValue({ error: 'BUSY' })
      const { result } = renderHook(() => useAIOutput('sess-1', false, vi.fn()))
      await act(async () => {
        await result.current.handleTextSubmit('同一段')
      })
      const first = result.current.restoreDraft
      await act(async () => {
        await result.current.handleTextSubmit('同一段')
      })
      const second = result.current.restoreDraft
      expect(second?.text).toBe('同一段')
      expect(second!.token).toBeGreaterThan(first!.token)
    })

    it('下一次提交会清掉上一次的草稿', async () => {
      window.electronAPI.chat = vi.fn().mockResolvedValueOnce({ error: 'BUSY' }).mockResolvedValueOnce({ reply: 'ok' })
      const { result } = renderHook(() => useAIOutput('sess-1', false, vi.fn()))
      await act(async () => {
        await result.current.handleTextSubmit('第一条')
      })
      expect(result.current.restoreDraft?.text).toBe('第一条')
      await act(async () => {
        await result.current.handleTextSubmit('第二条')
      })
      expect(result.current.restoreDraft).toBeNull()
    })

    it('语音提交被拒时不回填（语音原文不该塞回文本框）', async () => {
      window.electronAPI.chat = vi.fn().mockResolvedValue({ error: 'BUSY' })
      const { result } = renderHook(() => useAIOutput('sess-1', true, vi.fn()))
      await act(async () => {
        await result.current.handleVoiceResult('说出来的话')
      })
      expect(result.current.restoreDraft).toBeNull()
    })

    // chat() 抛异常时同样要回填：`processTextInput` 把 try 内部的一切异常都转成了
    // `{ error: 'INTERNAL' }`（不外抛），能抛到 renderer 的只有 try 之前那几句和 IPC 本身，
    // 全都在 insertMessage 之前 —— 消息一定没落库。
    it('chat 抛异常时也回填', async () => {
      window.electronAPI.chat = vi.fn().mockRejectedValue(new Error('ipc closed'))
      const { result } = renderHook(() => useAIOutput('sess-1', false, vi.fn()))
      await act(async () => {
        await result.current.handleTextSubmit('别丢了我')
      })
      expect(result.current.restoreDraft?.text).toBe('别丢了我')
    })

    it('语音提交抛异常时同样不回填（对照面）', async () => {
      window.electronAPI.chat = vi.fn().mockRejectedValue(new Error('ipc closed'))
      const { result } = renderHook(() => useAIOutput('sess-1', true, vi.fn()))
      await act(async () => {
        await result.current.handleVoiceResult('说出来的话')
      })
      expect(result.current.restoreDraft).toBeNull()
    })

    it('换会话时丢掉待回填的草稿', async () => {
      window.electronAPI.chat = vi.fn().mockResolvedValue({ error: 'BUSY' })
      const { result, rerender } = renderHook(({ s }: { s: string }) => useAIOutput(s, false, vi.fn()), {
        initialProps: { s: 'sess-1' },
      })
      await act(async () => {
        await result.current.handleTextSubmit('草稿')
      })
      expect(result.current.restoreDraft?.text).toBe('草稿')
      rerender({ s: 'sess-2' })
      expect(result.current.restoreDraft).toBeNull()
    })
  })

  // ── 语音指令编排的后续对话同样不看返回值就会静默 ──
  // 工具链已经跑完（有副作用），这条 chat 只负责「总结」；它被拒时用户会看到工具输出、
  // 却既没有总结也没有任何提示。
  describe('语音指令编排的后续对话上报失败', () => {
    async function runConfirmedIntent(chatResult: unknown, onError: (err: string | undefined) => void) {
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
      window.electronAPI.chat = vi.fn().mockResolvedValue(chatResult)

      const { result } = renderHook(() => useAIOutput('sess-1', true, onError))
      await act(async () => {
        await result.current.handleVoiceResult('打开 README.md')
      })
      await act(async () => {
        await result.current.confirmVoiceIntent()
      })
    }

    it('被熔断拒绝时给出可读文案', async () => {
      const onError = vi.fn()
      await runConfirmedIntent({ error: 'CIRCUIT_OPEN' }, onError)
      const shown = onError.mock.calls.map((c) => c[0]).find((v) => typeof v === 'string' && v.length > 0)
      expect(shown).toContain('自动恢复')
    })

    it('抛异常时也上报', async () => {
      const onError = vi.fn()
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
      window.electronAPI.executeVoiceChain = vi.fn().mockResolvedValue({ success: true, steps: [], summary: 'done' })
      window.electronAPI.chat = vi.fn().mockRejectedValue(new Error('socket hang up'))

      const { result } = renderHook(() => useAIOutput('sess-1', true, onError))
      await act(async () => {
        await result.current.handleVoiceResult('打开 README.md')
      })
      await act(async () => {
        await result.current.confirmVoiceIntent()
      })

      expect(onError).toHaveBeenCalledWith('Error: socket hang up')
    })

    it('成功时不产生错误文案（对照面）', async () => {
      const onError = vi.fn()
      await runConfirmedIntent({ reply: '已经读完了' }, onError)
      expect(onError.mock.calls.every((c) => c[0] === undefined)).toBe(true)
    })
  })
})
