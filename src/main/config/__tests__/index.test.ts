import { describe, it, expect } from 'vitest'
import * as config from '../index'

describe('config', () => {
  it('exports WORKSPACE_ROOT with defaults', () => {
    expect(config.WORKSPACE_ROOT).toBeDefined()
    expect(config.WORKSPACE.memory).toContain('memory')
  })

  it('exports ASR_SAMPLE_RATE constant', () => {
    expect(config.ASR_SAMPLE_RATE).toBe(16000)
  })

  it('defaults LLM_API_URL', () => {
    expect(config.LLM_API_URL).toBeTruthy()
  })

  it('exports WAKE_WORDS with defaults', () => {
    expect(config.WAKE_WORDS).toContain('澪')
    expect(config.WAKE_WORDS).toContain('mio')
  })

  it('defaults WINDOW_WIDTH to 420', () => {
    expect(config.WINDOW_WIDTH).toBe(420)
  })

  it('defaults WINDOW_HEIGHT to 640', () => {
    expect(config.WINDOW_HEIGHT).toBe(640)
  })

  it('defaults EVOLUTION_SAFETY_MODE to review', () => {
    expect(config.EVOLUTION_SAFETY_MODE).toBe('review')
  })

  it('defaults USE_LOCAL_TTS to false', () => {
    expect(config.USE_LOCAL_TTS).toBe(false)
  })

  it('exports FFMPEG_PATHS with defaults', () => {
    expect(config.FFMPEG_PATHS).toContain('ffmpeg')
  })

  it('exports FFPLAY_PATHS with defaults', () => {
    expect(config.FFPLAY_PATHS).toContain('ffplay')
  })

  it('exports WORKSPACE subdirs', () => {
    expect(config.WORKSPACE.projects).toContain('projects')
    expect(config.WORKSPACE.memory).toContain('memory')
    expect(config.WORKSPACE.logs).toContain('logs')
    expect(config.WORKSPACE.evolution).toContain('evolution')
  })

  it('exports ASR_HOTWORDS with defaults', () => {
    expect(config.ASR_HOTWORDS).toContain('Agent')
    expect(config.ASR_HOTWORDS).toContain('MCP')
  })

  it('exports INITIAL_HOTWORDS with defaults', () => {
    expect(config.INITIAL_HOTWORDS).toContain('贝斯')
  })

  it('exports LLM_CODE_API_URL', () => {
    expect(config.LLM_CODE_API_URL).toBeTruthy()
  })

  it('exports LLM_CHAT_MODEL with default', () => {
    expect(config.LLM_CHAT_MODEL).toBeTruthy()
  })

  it('exports LLM_CODE_MODEL with default', () => {
    expect(config.LLM_CODE_MODEL).toBeTruthy()
  })

  it('exports PIPER_SCRIPT with default', () => {
    expect(config.PIPER_SCRIPT).toBeTruthy()
  })

  it('exports LLM_MODEL backward compat', () => {
    expect(config.LLM_MODEL).toBe(config.LLM_CHAT_MODEL)
  })

  it('exports ASR_INITIAL_PROMPT with default', () => {
    expect(config.ASR_INITIAL_PROMPT).toContain('泵站')
  })

  it('exports ASR_MAX_AUDIO_SECONDS', () => {
    expect(config.ASR_MAX_AUDIO_SECONDS).toBe(25)
  })
})
