import { describe, it, expect, vi, beforeEach } from 'vitest'

// 存储被注册的 handler 回调
const registeredHandlers = new Map<string, (...args: any[]) => any>()
const registeredOns = new Map<string, (...args: any[]) => any>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel, handler) => {
      registeredHandlers.set(channel, handler)
    }),
    on: vi.fn((channel, handler) => {
      registeredOns.set(channel, handler)
    }),
  },
  BrowserWindow: {
    fromWebContents: vi.fn(() => ({ close: vi.fn(), hide: vi.fn() })),
  },
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
  },
}))

vi.mock('../../logger/Logger', () => ({
  log: vi.fn(),
  createRequestId: vi.fn(() => 'test-req-id'),
}))

vi.mock('../../updater/UpdaterService', () => ({
  checkForUpdates: vi.fn().mockResolvedValue({ available: false, version: '' }),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
}))

vi.mock('../../credentials/CredentialsManager', () => ({
  credentialsManager: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(''),
    set: vi.fn().mockReturnValue(undefined),
  },
}))

const configMock = vi.hoisted(() => ({
  WAKE_WORDS: ['mio'],
  LLM_API_URL: 'https://api.example.com/chat',
  LLM_CODE_API_URL: 'https://api.example.com/code',
  LLM_TEXT_API_URL: 'https://api.example.com/text',
  LLM_VISION_API_URL: 'https://api.example.com/vision',
  WORKSPACE: { evolution: process.cwd(), cache: process.cwd() },
  RUNTIME_ROOT: process.cwd(),
  INITIAL_HOTWORDS: [],
  EVOLUTION_SAFETY_MODE: 'review',
  ASR_HOTWORDS: '',
  WINDOW_WIDTH: 420,
  WINDOW_HEIGHT: 640,
  GGML_MODELS_DIR: '/dev/null',
  ASR_SAMPLE_RATE: 16000,
  ASR_MAX_AUDIO_SECONDS: 25,
  ASR_INITIAL_PROMPT: '',
  FFPLAY_PATHS: ['ffplay'],
  PIPER_SCRIPT: '/dev/null',
  PIPER_MODEL: '/dev/null',
  USE_LOCAL_TTS: false,
  DEV_PROJECT_ROOT: '',
  LLM_MODEL: 'test-model',
  LLM_KEY: '',
  LLM_CHAT_MODEL: 'test-model',
  LLM_CODE_MODEL: 'test-model',
  LLM_VISION_MODEL: 'test-model',
  LLM_VISION_KEY: '',
  LLM_TEXT_MODEL: 'test-model',
  LLM_TEXT_KEY: '',
  LLM_IMAGE_API_URL: '',
  LLM_IMAGE_KEY: '',
  LLM_IMAGE_MODEL: '',
  FFMPEG_PATHS: ['ffmpeg'],
  WORKSPACE_ROOT: '/dev/null',
  BEHAVIOR_PREDICTOR_WINDOW_SIZE: 12,
  BEHAVIOR_PREDICTOR_MIN_SEQUENCE_LENGTH: 2,
  BEHAVIOR_PREDICTOR_MIN_PATTERN_FREQUENCY: 2,
  BEHAVIOR_PREDICTOR_PRELOAD_TTL_MS: 120000,
  BEHAVIOR_PREDICTOR_PRELOAD_CACHE_MAX: 50,
  BEHAVIOR_PREDICTOR_PRELOAD_TIMEOUT_MS: 10000,
  BEHAVIOR_PREDICTOR_PRELOAD_CONFIDENCE: 0.35,
  BEHAVIOR_PREDICTOR_MAX_CONCURRENT_PRELOADS: 3,
  ASR_HOTWORDS: [],
}))

vi.mock('../../config', () => configMock)

vi.mock('../../core/EventBus', () => ({
  eventBus: {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
}))

import { registerHandlers } from '../handlers'
import type { AgentService } from '../../agent/AgentService'
import type { StateManager } from '../../core/StateManager'
import type { TtsService } from '../../tts/TtsService'

describe('IPC handlers', () => {
  let agentService: any
  let stateManager: any
  let ttsService: any
  let evolutionService: any
  let decisionQueryService: any

  beforeEach(() => {
    registeredHandlers.clear()
    registeredOns.clear()

    agentService = {
      processTextInput: vi.fn().mockResolvedValue({ reply: 'test' }),
      getAsrService: vi.fn().mockReturnValue({
        transcribe: vi.fn().mockResolvedValue('test'),
      }),
      getMcpManager: vi.fn().mockReturnValue({
        listServers: vi.fn().mockReturnValue([{ name: 'server1', initialized: true }]),
      }),
      isBusy: vi.fn().mockReturnValue(false),
      isPaused: vi.fn().mockReturnValue(false),
      pause: vi.fn(),
      resume: vi.fn(),
      stopConversation: vi.fn().mockResolvedValue(undefined),
      saveRecoverySnapshot: vi.fn(),
    }

    stateManager = {
      get: vi.fn().mockReturnValue({
        asr: 'idle',
        audioLevel: 0,
      }),
    }

    ttsService = {
      speak: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
    }

    evolutionService = {
      triggerNow: vi.fn().mockResolvedValue(undefined),
      getLastRun: vi.fn().mockReturnValue(0),
      getConsecutiveFailures: vi.fn().mockReturnValue(0),
    }

    decisionQueryService = {
      getDecision: vi.fn().mockResolvedValue({ state: 'RECORDED', record: { decisionId: 'd1', traceId: 't1' } }),
      listByTrace: vi.fn().mockResolvedValue([]),
    }

    registerHandlers(agentService, stateManager, ttsService, { current: evolutionService }, undefined, undefined, undefined, {
      current: decisionQueryService,
    })
  })

  describe('handler 注册', () => {
    it('注册所有必需的 IPC handler', () => {
      const expected = [
        'ai:chat',
        'asr:transcribe',
        'tts:speak',
        'tts:stop',
        'state:get',
        'evolution:trigger',
        'evolution:status',
        'credentials:list',
        'credentials:get',
        'credentials:set',
        'config:getWakeWords',
        'health:check',
        'update:check',
        'update:download',
        'update:install',
        'window:close',
      ]
      const actual = [...registeredHandlers.keys()]
      for (const ch of expected) {
        expect(registeredHandlers.has(ch)).toBe(true)
      }
    })
  })

  describe('ai:chat', () => {
    it('调用 agentService.processTextInput 并返回结果', async () => {
      const handler = registeredHandlers.get('ai:chat')!
      const result = await handler({}, '你好', 'req-1')
      expect(agentService.processTextInput).toHaveBeenCalledWith('你好', 'req-1', 'electron', undefined, undefined, undefined)
      expect(result).toEqual({ reply: '你好' })
    })
  })

  describe('asr:transcribe', () => {
    it('调用 asrService.transcribe', async () => {
      const handler = registeredHandlers.get('asr:transcribe')!
      const buffer = new ArrayBuffer(8)
      const result = await handler({}, buffer)
      expect(agentService.getAsrService().transcribe).toHaveBeenCalledWith(buffer)
      expect(result).toBe('识别文本')
    })

    it('ASR 未初始化时抛出错误', async () => {
      agentService.getAsrService.mockReturnValue(null)
      const handler = registeredHandlers.get('asr:transcribe')!
      await expect(handler({}, new ArrayBuffer(8))).rejects.toThrow('ASR service not initialized')
    })
  })

  describe('tts:speak', () => {
    it('调用 ttsService.speak', async () => {
      const handler = registeredHandlers.get('tts:speak')!
      await handler({}, '你好啊')
      expect(ttsService.speak).toHaveBeenCalledWith('你好啊')
    })
  })

  describe('tts:stop', () => {
    it('调用 ttsService.stop', async () => {
      const handler = registeredHandlers.get('tts:stop')!
      await handler()
      expect(ttsService.stop).toHaveBeenCalled()
    })
  })

  describe('state:get', () => {
    it('返回 stateManager.get() 的结果', async () => {
      const handler = registeredHandlers.get('state:get')!
      const result = await handler()
      expect(stateManager.get).toHaveBeenCalled()
      expect(result).toEqual({ asr: 'idle', audioLevel: 0 })
    })

    it('异常时返回错误对象', async () => {
      stateManager.get.mockImplementation(() => {
        throw new Error('state error')
      })
      const handler = registeredHandlers.get('state:get')!
      const result = await handler()
      expect(result).toHaveProperty('error')
      expect(result.error).toContain('state error')
    })
  })

  describe('evolution:trigger', () => {
    it('触发进化任务', async () => {
      const handler = registeredHandlers.get('evolution:trigger')!
      const result = await handler()
      expect(evolutionService.triggerNow).toHaveBeenCalled()
      expect(result).toEqual({ success: true })
    })
  })

  describe('evolution:status', () => {
    it('返回进化服务状态', async () => {
      const handler = registeredHandlers.get('evolution:status')!
      const result = await handler()
      expect(result).toHaveProperty('lastRun')
      expect(result).toHaveProperty('consecutiveFailures')
      expect(result).toHaveProperty('isBusy')
    })
  })

  describe('credentials', () => {
    it('credentials:list', async () => {
      const handler = registeredHandlers.get('credentials:list')!
      const result = await handler()
      expect(result).toBeDefined()
    })

    it('credentials:get', async () => {
      const handler = registeredHandlers.get('credentials:get')!
      const result = await handler({}, 'test-key')
      expect(result).toBeDefined()
    })

    it('credentials:set', async () => {
      const handler = registeredHandlers.get('credentials:set')!
      const result = await handler({}, 'test-key', 'test-value')
      expect(result).toBe(true)
    })
  })

  describe('config:getWakeWords', () => {
    it('返回唤醒词列表', async () => {
      const handler = registeredHandlers.get('config:getWakeWords')!
      const result = await handler()
      expect(Array.isArray(result)).toBe(true)
    })
  })

  describe('health:check', () => {
    it('返回健康检查报告', async () => {
      const handler = registeredHandlers.get('health:check')!
      const result = await handler()
      expect(result).toHaveProperty('status', 'ok')
      expect(result).toHaveProperty('uptime')
      expect(result).toHaveProperty('memory')
      expect(result).toHaveProperty('asr')
      expect(result).toHaveProperty('llm')
      expect(result).toHaveProperty('mcp')
      expect(result.mcp).toHaveProperty('serverCount', 1)
      expect(result.mcp.servers[0]).toEqual({ name: 'server1', initialized: true })
      expect(result).toHaveProperty('eventLoopLagMs')
    })
  })

  describe('update handlers', () => {
    it('update:check 检查更新', async () => {
      const handler = registeredHandlers.get('update:check')!
      const result = await handler()
      expect(result).toHaveProperty('available')
    })

    it('update:download 触发下载', async () => {
      const handler = registeredHandlers.get('update:download')!
      const result = await handler()
      expect(result).toEqual({ success: true })
    })

    it('update:install 触发安装', async () => {
      const handler = registeredHandlers.get('update:install')!
      const result = await handler()
      expect(result).toEqual({ success: true })
    })
  })

  describe('无 evolutionService 时', () => {
    beforeEach(() => {
      registeredHandlers.clear()
      registeredOns.clear()
      registerHandlers(agentService, stateManager, ttsService, undefined)
    })

    it('不注册 evolution handler', () => {
      expect(registeredHandlers.has('evolution:trigger')).toBe(false)
      expect(registeredHandlers.has('evolution:status')).toBe(false)
    })

    it('其他 handler 仍正常注册', () => {
      expect(registeredHandlers.has('ai:chat')).toBe(true)
      expect(registeredHandlers.has('tts:speak')).toBe(true)
      expect(registeredHandlers.has('health:check')).toBe(true)
    })
  })

  describe('window:close', () => {
    it('关闭发送事件的窗口', async () => {
      const handler = registeredHandlers.get('window:close')!
      const mockEvent = { sender: {} }
      const result = await handler(mockEvent)
      expect(result).toEqual({ success: true })
    })
  })

  describe('evaluation:getDecision (M5.3)', () => {
    it('channel registered', () => {
      expect(registeredHandlers.has('evaluation:getDecision')).toBe(true)
    })

    it('delegates to DecisionQueryService.getDecision', async () => {
      const handler = registeredHandlers.get('evaluation:getDecision')!
      const result = await handler({}, 'd1')
      expect(decisionQueryService.getDecision).toHaveBeenCalledWith('d1')
      expect(result.state).toBe('RECORDED')
      expect(result.record.decisionId).toBe('d1')
    })

    it('no service returns UNAVAILABLE', async () => {
      registeredHandlers.clear()
      registeredOns.clear()
      registerHandlers(agentService, stateManager, ttsService, { current: evolutionService }, undefined, undefined, undefined, undefined)
      const handler = registeredHandlers.get('evaluation:getDecision')!
      const result = await handler({}, 'd1')
      expect(result.state).toBe('UNAVAILABLE')
    })
  })

  describe('evaluation:listByTrace (M5.3)', () => {
    it('channel registered', () => {
      expect(registeredHandlers.has('evaluation:listByTrace')).toBe(true)
    })

    it('delegates to DecisionQueryService.listByTrace', async () => {
      decisionQueryService.listByTrace.mockResolvedValue([{ decisionId: 'd1', traceId: 't1' }])
      const handler = registeredHandlers.get('evaluation:listByTrace')!
      const result = await handler({}, 't1')
      expect(decisionQueryService.listByTrace).toHaveBeenCalledWith('t1')
      expect(result.length).toBe(1)
    })
  })
})
