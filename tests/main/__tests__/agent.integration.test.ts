import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => process.cwd() },
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
    ASR_HOTWORD_WINDOW_SIZE: 16,
    ASR_HOTWORD_FREQ_THRESHOLD: 3,
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
import { LlmService } from '@akemi-mio/intelligence/llm/LlmService'
import { AsrService } from '@akemi-mio/audio/AsrService'
import { TtsService } from '@akemi-mio/audio/TtsService'
import { WhisperGpuEngine } from '@akemi-mio/audio/WhisperGpuEngine'
import { BaiduEngine } from '@akemi-mio/audio/BaiduEngine'
import { initDatabase, closeDatabase } from '@akemi-mio/core/db/connection'
import { useIsolatedTestDatabase } from '../db/__tests__/testDatabase'

describe('AgentService integration', () => {
  let agent: AgentService
  let ttsService: TtsService
  let llmService: LlmService
  let ttsState: Record<string, unknown>
  let restoreTestDatabase: () => void

  beforeEach(async () => {
    restoreTestDatabase = useIsolatedTestDatabase()
    await initDatabase()
    ttsState = {}
    ttsService = new TtsService((s) => Object.assign(ttsState, s))
    vi.spyOn(ttsService as any, 'speakInternal').mockResolvedValue(undefined)
    vi.spyOn(ttsService, 'flushBuffer')

    llmService = new LlmService()
    llmService.setConfig('test-key')

    const gpuEngine = new WhisperGpuEngine()
    const baiduEngine = new BaiduEngine()
    const asrService = new AsrService(gpuEngine, baiduEngine)
    agent = new AgentService(llmService, asrService, ttsService)
  })

  afterEach(() => {
    closeDatabase()
    restoreTestDatabase()
  })

  it('full pipeline: tool loop → TTS flush', async () => {
    vi.spyOn(llmService, 'chatWithTools').mockResolvedValue({
      reply: '你好，今天过得怎么样？',
    })

    const result = await agent.processTextInput('测试')

    expect(result.reply).toBe('你好，今天过得怎么样？')
    expect(llmService.chatWithTools).toHaveBeenCalledTimes(3)
    expect(ttsService.flushBuffer).toHaveBeenCalledTimes(1)
  })

  it('LLM error via tool loop', async () => {
    vi.spyOn(llmService, 'chatWithTools').mockResolvedValue({ error: 'NETWORK' })

    const result = await agent.processTextInput('测试')

    // toolLoop returns immediately on LLM error (retry is inside chatWithTools)
    expect(result.error || result.reply).toBeTruthy()
    expect(llmService.chatWithTools).toHaveBeenCalledTimes(1)
  })

  it('handles tool call loop', async () => {
    let calls = 0
    vi.spyOn(llmService, 'chatWithTools').mockImplementation(async () => {
      calls++
      if (calls === 1) {
        return {
          toolCalls: [
            {
              id: 'call_1',
              name: 'list_files' as const,
              arguments: { path: '.' },
            },
          ],
        }
      }
      return { reply: '文件已列出' }
    })

    const result = await agent.processTextInput('列出文件')

    expect(result.reply).toBe('文件已列出')
    expect(llmService.chatWithTools).toHaveBeenCalledTimes(2)
  })

  it('context management: add and trim', () => {
    const ctx = agent.getContext()
    ctx.addUser('消息1')
    ctx.addAssistant('回复1')
    ctx.addUser('消息2')
    ctx.addAssistant('回复2')
    const msgs = ctx.getMessages()
    expect(msgs.length).toBeGreaterThan(2)
    expect(msgs[0].role).toBe('system')
  })
})
