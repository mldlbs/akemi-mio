import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => process.cwd() },
  BrowserWindow: vi.fn(() => ({
    webContents: { send: vi.fn() },
    close: vi.fn(),
  })),
}))

vi.mock('@akemi-mio/core/db/connection', () => ({
  initDatabase: vi.fn(async () => {}),
  closeDatabase: vi.fn(() => {}),
}))

vi.mock('@akemi-mio/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@akemi-mio/core/config')>()
  return {
    ...actual,
    LLM_API_URL: 'https://api.example.com/chat',
    LLM_CHAT_MODEL: 'test-model',
    LLM_CODE_MODEL: 'test-model',
    LLM_CODE_API_URL: 'https://api.example.com/code',
    LLM_VISION_API_URL: 'https://api.example.com/vision',
    LLM_VISION_MODEL: 'test-vision-model',
    LLM_VISION_KEY: '',
    LLM_TEXT_API_URL: 'https://api.example.com/text',
    LLM_TEXT_MODEL: 'test-text-model',
    LLM_TEXT_KEY: '',
    LLM_IMAGE_API_URL: 'https://api.example.com/image',
    LLM_IMAGE_KEY: '',
    LLM_IMAGE_MODEL: 'test-image-model',
    FFPLAY_PATHS: ['ffplay'],
    PIPER_SCRIPT: '/dev/null/piper.py',
    PIPER_MODEL: '/dev/null/model.onnx',
    USE_LOCAL_TTS: false,
    EVOLUTION_SAFETY_MODE: 'review',
    FFMPEG_PATHS: ['ffmpeg'],
    ASR_HOTWORDS: [],
    ASR_SAMPLE_RATE: 16000,
    ASR_MAX_AUDIO_SECONDS: 25,
    WAKE_WORDS: ['mio'],
    WINDOW_WIDTH: 420,
    WINDOW_HEIGHT: 640,
    GGML_MODELS_DIR: '/dev/null/models',
    INITIAL_HOTWORDS: [],
    ASR_INITIAL_PROMPT: '',
    WORKSPACE: {
      projects: '/dev/null/projects',
      databases: '/dev/null/databases',
      memory: '/dev/null/memory',
      knowledge: '/dev/null/knowledge',
      skills: '/dev/null/skills',
      workflows: '/dev/null/workflows',
      proposals: '/dev/null/proposals',
      logs: '/dev/null/logs',
      cache: '/dev/null/cache',
      evolution: '/dev/null/evolution',
    },
    RUNTIME_ROOT: '/dev/null',
    WORKSPACE_ROOT: '/dev/null',
    DEV_PROJECT_ROOT: '',
    LLM_MODEL: 'test-model',
  }
})

import { AgentService } from '@akemi-mio/intelligence/agent/AgentService'
import { AsrService } from '@akemi-mio/audio/AsrService'
import { WhisperGpuEngine } from '@akemi-mio/audio/WhisperGpuEngine'
import { BaiduEngine } from '@akemi-mio/audio/BaiduEngine'
import { initDatabase, closeDatabase } from '@akemi-mio/core/db/connection'
import { LlmService } from '@akemi-mio/intelligence/llm/LlmService'
import { TtsService } from '@akemi-mio/audio/TtsService'
import { useIsolatedTestDatabase } from '../../db/__tests__/testDatabase'

describe('AgentService external message ingress', () => {
  let agent: AgentService
  let restoreTestDatabase: () => void

  beforeEach(async () => {
    restoreTestDatabase = useIsolatedTestDatabase()
    await initDatabase()

    const ttsState: Record<string, unknown> = {}
    const ttsService = new TtsService((s) => Object.assign(ttsState, s))
    vi.spyOn(ttsService as any, 'speakInternal').mockResolvedValue(undefined)
    vi.spyOn(ttsService, 'flushBuffer').mockReturnValue(undefined)
    vi.spyOn(ttsService, 'stop').mockReturnValue(undefined)

    const llmService = new LlmService()
    llmService.setConfig('test-key')

    const asrService = new AsrService(new WhisperGpuEngine(), new BaiduEngine())
    agent = new AgentService(llmService, asrService, ttsService)
  })

  afterEach(() => {
    closeDatabase()
    restoreTestDatabase()
  })

  it('processExternalMessage forwards a normalized context instead of telegram-specific keys', async () => {
    const processSpy = vi.spyOn(agent, 'processTextInput').mockResolvedValue({ reply: 'ok' })

    await agent.processExternalMessage({
      id: 'telegram:12:99',
      channel: 'telegram',
      userId: 'alice',
      timestamp: 99,
      content: { type: 'text', text: 'hello' },
      context: { chatId: '42', replyTo: '8', threadId: 'thread-1' },
      metadata: { telegramMessageId: 12, raw: { any: 'value' } },
    })

    expect(processSpy).toHaveBeenCalledWith(
      'hello',
      undefined,
      'telegram',
      expect.objectContaining({
        channel: 'telegram',
        chatId: '42',
        userId: 'alice',
        messageId: 12,
        replyTo: '8',
        threadId: 'thread-1',
        raw: { any: 'value' },
      }),
      undefined,
      undefined,
    )
  })
})
