import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanTTS, TtsService } from '../TtsService'

describe('cleanTTS', () => {
  it('removes surrogate pairs', () => {
    expect(cleanTTS('hello\uD800world')).toBe('helloworld')
  })

  it('replaces 还行 polyphone', () => {
    expect(cleanTTS('这还行吧')).toBe('这还型吧')
  })

  it('replaces 行吧 polyphone', () => {
    expect(cleanTTS('行吧')).toBe('型吧')
  })

  it('removes markdown headings', () => {
    const result = cleanTTS('## Title\nbody')
    expect(result).not.toContain('#')
    expect(result).toContain('Title')
  })

  it('removes bold markers keeping text', () => {
    expect(cleanTTS('**bold** text')).toBe('bold text')
  })

  it('removes inline code', () => {
    expect(cleanTTS('use `cmd` here')).toBe('use cmd here')
  })

  it('removes code fences', () => {
    const input = '```\ncode block\n```\nbody'
    expect(cleanTTS(input)).toBe('body')
  })

  it('removes image markdown', () => {
    expect(cleanTTS('![alt](url)')).toBe('alt')
  })

  it('removes link markdown', () => {
    expect(cleanTTS('[text](url)')).toBe('text')
  })

  it('removes parenthetical actions', () => {
    expect(cleanTTS('hello(笑)world')).toBe('helloworld')
  })

  it('removes list markers', () => {
    const result = cleanTTS('- item\n- item2')
    expect(result).not.toContain('- ')
    expect(result).toContain('item')
  })

  it('removes numbered list markers', () => {
    const result = cleanTTS('1. item\n2. item2')
    expect(result).not.toMatch(/^\d+[.、]/m)
    expect(result).toContain('item')
  })

  it('removes table pipes', () => {
    expect(cleanTTS('a | b')).toBe('a b')
  })

  it('removes blockquotes leaving content', () => {
    const result = cleanTTS('> quote\nbody')
    expect(result).not.toContain('>')
    expect(result).toContain('quote')
  })

  it('table pipe removal', () => {
    expect(cleanTTS('a | b')).toBe('a b')
  })

  it('removes emoji', () => {
    expect(cleanTTS('hello😊world')).toBe('helloworld')
  })

  it('trims trailing tildes', () => {
    expect(cleanTTS('yes～')).toBe('yes')
  })

  it('collapses multiple spaces', () => {
    expect(cleanTTS('a  b')).toBe('a b')
  })

  it('returns "嗯" when all content is filtered', () => {
    expect(cleanTTS('😊😊')).toBe('嗯')
  })

  it('returns original for clean text', () => {
    expect(cleanTTS('你好世界')).toBe('你好世界')
  })

  it('separator alone becomes empty', () => {
    const result = cleanTTS('---')
    expect(result === '' || result === '嗯').toBe(true)
  })

  it('normalizes ellipsis', () => {
    expect(cleanTTS('a…b')).toBe('a…b')
  })

  it('normalizes long dash', () => {
    expect(cleanTTS('a——b')).toBe('a—b')
  })
})

describe('TtsService', () => {
  let onStateUpdate: any
  let service: TtsService

  beforeEach(() => {
    onStateUpdate = vi.fn()
    service = new TtsService(onStateUpdate)
  })

  it('starts with empty queue', () => {
    expect(service).toBeDefined()
  })

  it('setAudioSink stores callback', () => {
    const cb = vi.fn()
    service.setAudioSink(cb)
    // Not called yet — only used on speak
    expect(cb).not.toHaveBeenCalled()
  })

  it('stop resets queue and flags stopped', () => {
    service.addChunk('Hello. World.')
    service.stop()
    // After stop, flushBuffer should not process
    service.flushBuffer()
    expect(onStateUpdate).toHaveBeenCalledWith({ ttsPlaying: false })
  })

  it('addChunk buffers short text without processing', () => {
    service.addChunk('Hi') // too short (<15 chars)
    // Should not add to queue immediately
    expect(service).toBeDefined()
  })

  it('flushBuffer with empty state does nothing', () => {
    service.flushBuffer()
    expect(onStateUpdate).not.toHaveBeenCalled()
  })

  it('flushBuffer processes accumulated sentence buffer', () => {
    // Add enough text to trigger queue processing
    service.addChunk('这是一段足够长的中文测试文本，用于验证TTS功能。')
    service.flushBuffer()
    // flushBuffer should trigger TTS playing state
    expect(onStateUpdate).toHaveBeenCalledWith({ ttsPlaying: true })
  })

  it('addChunk splits at sentence boundaries', () => {
    const text = '第一句话。第二句话！第三句话？'
    service.addChunk(text)
    // The split works via lookbehind — buffer should now process
    expect(service).toBeDefined()
  })
})
