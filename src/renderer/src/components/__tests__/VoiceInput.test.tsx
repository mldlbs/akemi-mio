import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { VoiceInput } from '../VoiceInput'
import { resetAllStores } from '../../store/reset'
import { useDeviceStore } from '../../store/deviceStore'
import { createMockIPC } from '../../__tests__/mockIPC'

vi.mock('../audioShared', () => ({
  updateMicEnergy: vi.fn(),
  stopTTS: vi.fn(),
}))

let capturedProcessor: { onaudioprocess: ((e: any) => void) | null } | null = null

class TestAudioContext {
  sampleRate = 48000
  state: AudioContextState = 'running'
  destination = 'mock-destination' as any
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }))
  createBiquadFilter = vi.fn(() => ({ connect: vi.fn(), frequency: { value: 80 }, Q: { value: 0.7 } }))
  createScriptProcessor = vi.fn(() => {
    const proc = { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null }
    capturedProcessor = proc as any
    return proc
  })
  close = vi.fn(() => Promise.resolve())
  resume = vi.fn(() => Promise.resolve())
  createGain = vi.fn(() => ({ connect: vi.fn(), gain: { value: 1 } }))
}

beforeEach(() => {
  resetAllStores()
  capturedProcessor = null
  window.electronAPI = createMockIPC() as any
  Object.defineProperty(window, 'AudioContext', { writable: true, value: TestAudioContext })
})

describe('VoiceInput', () => {
  it('renders mic and stop TTS buttons', () => {
    const { container } = render(<VoiceInput onResult={vi.fn()} />)
    expect(container.querySelector('.btn-voice')).toBeTruthy()
    expect(container.querySelector('.btn-danger')).toBeTruthy()
  })

  it('shows mic icon when inactive', () => {
    const { container } = render(<VoiceInput onResult={vi.fn()} />)
    expect(container.querySelector('.btn-voice i')?.classList.contains('ri-mic-fill')).toBe(true)
  })

  it('shows stop icon when activated', async () => {
    const { container } = render(<VoiceInput onResult={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button')[0])
    })
    expect(container.querySelector('.btn-voice i')?.classList.contains('ri-stop-fill')).toBe(true)
  })

  it('adds active class when activated', async () => {
    const { container } = render(<VoiceInput onResult={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button')[0])
    })
    expect(container.querySelector('.btn-voice')?.classList.contains('active')).toBe(true)
  })

  it('disables mic button when disabled', () => {
    render(<VoiceInput onResult={vi.fn()} disabled />)
    expect(screen.getAllByRole('button')[0].disabled).toBe(true)
  })

  it('enables stop TTS button when ttsPlaying from store', () => {
    useDeviceStore.getState().setTtsPlaying(true)
    render(<VoiceInput onResult={vi.fn()} />)
    expect(screen.getAllByRole('button')[1].disabled).toBe(false)
  })

  it('disables stop TTS button when not ttsPlaying', () => {
    render(<VoiceInput onResult={vi.fn()} />)
    expect(screen.getAllByRole('button')[1].disabled).toBe(true)
  })

  it('stop TTS button calls stopSpeaking', () => {
    useDeviceStore.getState().setTtsPlaying(true)
    render(<VoiceInput onResult={vi.fn()} />)
    fireEvent.click(screen.getAllByRole('button')[1])
    expect(window.electronAPI.stopSpeaking).toHaveBeenCalled()
  })

  it('loads wake words on mount', async () => {
    render(<VoiceInput onResult={vi.fn()} />)
    await waitFor(() => {
      expect(window.electronAPI.getWakeWords).toHaveBeenCalled()
    })
  })

  it('sets device store active=true on activation', async () => {
    render(<VoiceInput onResult={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button')[0])
    })
    expect(useDeviceStore.getState().active).toBe(true)
  })

  it('sets device store active=false on deactivation', async () => {
    render(<VoiceInput onResult={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button')[0])
    })
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button')[0])
    })
    expect(useDeviceStore.getState().active).toBe(false)
  })

  it('calls stopConversation on deactivation', async () => {
    render(<VoiceInput onResult={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button')[0])
    })
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button')[0])
    })
    expect(window.electronAPI.stopConversation).toHaveBeenCalled()
  })

  it('creates AudioContext when mic is activated', async () => {
    const spy = vi.fn(() => new TestAudioContext())
    Object.defineProperty(window, 'AudioContext', { writable: true, value: spy })
    render(<VoiceInput onResult={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button')[0])
    })
    await waitFor(() => {
      expect(spy).toHaveBeenCalled()
    })
  })

  it('sets up audio processor after mic activation', async () => {
    render(<VoiceInput onResult={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button')[0])
    })
    await waitFor(() => {
      expect(capturedProcessor).not.toBeNull()
    })
  })

  describe('VAD pipeline', () => {
    it('sets up audio processor after mic activation', async () => {
      render(<VoiceInput onResult={vi.fn()} />)
      await act(async () => {
        fireEvent.click(screen.getAllByRole('button')[0])
      })
      await waitFor(() => {
        expect(capturedProcessor).not.toBeNull()
      })
    })

    it('onaudioprocess callback is callable without errors', async () => {
      render(<VoiceInput onResult={vi.fn()} />)
      await act(async () => {
        fireEvent.click(screen.getAllByRole('button')[0])
      })
      await waitFor(() => {
        expect(capturedProcessor).not.toBeNull()
      })

      expect(() => {
        const frame = new Float32Array(2048).fill(0.1)
        capturedProcessor!.onaudioprocess!({ inputBuffer: { getChannelData: () => frame } })
      }).not.toThrow()
    })

    it('onaudioprocess handles speech frames without error', async () => {
      render(<VoiceInput onResult={vi.fn()} />)
      await act(async () => {
        fireEvent.click(screen.getAllByRole('button')[0])
      })
      await waitFor(() => {
        expect(capturedProcessor).not.toBeNull()
      })

      expect(() => {
        for (let i = 0; i < 10; i++) {
          capturedProcessor!.onaudioprocess!({
            inputBuffer: { getChannelData: () => new Float32Array(2048).fill(0.1) },
          })
        }
      }).not.toThrow()
    })

    it('onaudioprocess handles silent frames without error', async () => {
      render(<VoiceInput onResult={vi.fn()} />)
      await act(async () => {
        fireEvent.click(screen.getAllByRole('button')[0])
      })
      await waitFor(() => {
        expect(capturedProcessor).not.toBeNull()
      })

      expect(() => {
        for (let i = 0; i < 10; i++) {
          capturedProcessor!.onaudioprocess!({
            inputBuffer: { getChannelData: () => new Float32Array(2048).fill(0.001) },
          })
        }
      }).not.toThrow()
    })
  })
})
