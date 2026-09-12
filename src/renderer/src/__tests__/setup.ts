import { vi } from 'vitest'
import { createMockIPC } from './mockIPC'

// Mock window.electronAPI for all renderer tests
beforeEach(() => {
  window.electronAPI = createMockIPC() as any
})

// jsdom doesn't implement matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

// Stub AudioContext for tests that transitively import audioShared
class MockAudioContext {
  sampleRate = 48000
  state = 'running' as AudioContextState
  currentTime = 0

  createMediaStreamSource() {
    return { connect: vi.fn() } as any
  }
  createScriptProcessor() {
    return {
      connect: vi.fn(),
      disconnect: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as any
  }
  createAnalyser() {
    return {
      fftSize: 2048,
      frequencyBinCount: 1024,
      getByteTimeDomainData: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as any
  }
  createGain() {
    return { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() } } as any
  }
  createBuffer(channels: number, length: number, sampleRate: number) {
    return { getChannelData: () => new Float32Array(length), duration: length / sampleRate, numberOfChannels: channels, sampleRate } as any
  }
  createBufferSource() {
    return {
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      disconnect: vi.fn(),
      buffer: null,
    } as any
  }
  resume() {
    return Promise.resolve()
  }
  close() {
    return Promise.resolve()
  }
}

Object.defineProperty(window, 'AudioContext', {
  writable: true,
  value: MockAudioContext,
})

// Stub scrollIntoView for ChatSlot auto-scroll
Element.prototype.scrollIntoView = vi.fn()

// Stub requestAnimationFrame / cancelAnimationFrame for VoiceInput
let rafId = 0
Object.defineProperty(window, 'requestAnimationFrame', {
  writable: true,
  value: vi.fn((cb: FrameRequestCallback) => {
    rafId++
    return rafId
  }),
})
Object.defineProperty(window, 'cancelAnimationFrame', {
  writable: true,
  value: vi.fn((id: number) => {}),
})

// Stub navigator.mediaDevices for VoiceInput
Object.defineProperty(navigator, 'mediaDevices', {
  writable: true,
  value: {
    getUserMedia: vi.fn().mockResolvedValue({
      getTracks: () => [{ stop: vi.fn() }],
      getAudioTracks: () => [{ stop: vi.fn() }],
    }),
  },
})
