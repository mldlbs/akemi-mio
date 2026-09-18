import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const electronAppMock = vi.hoisted(() => ({
  isPackaged: false,
  getAppPath: () => process.cwd(),
  getPath: () => process.cwd(),
}))

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
  app: electronAppMock,
}))

vi.mock('@akemi-mio/core/logger/Logger', () => ({
  log: vi.fn(),
  createRequestId: vi.fn(() => 'test-req-id'),
}))

vi.mock('@akemi-mio/updater/UpdaterService', () => ({
  checkForUpdates: vi.fn().mockResolvedValue({ available: false, version: '' }),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
}))

vi.mock('@akemi-mio/core/credentials/CredentialsManager', () => ({
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
  ASR_HOTWORDS: [],
  WINDOW_WIDTH: 420,
  WINDOW_HEIGHT: 640,
  GGML_MODELS_DIR: '/dev/null',
  ASR_SAMPLE_RATE: 16000,
  ASR_MAX_AUDIO_SECONDS: 25,
  ASR_HOTWORD_WINDOW_SIZE: 16,
  BEHAVIOR_MEMORY_ANALYZER_WINDOW: 70,
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
  ASR_HOTWORD_FREQ_THRESHOLD: 2,
  BLOG_MEMORY_ENABLED: true,
  BLOG_MEMORY_MAX_ENTRIES: 200,
  BLOG_MEMORY_MAX_CONTENT_LENGTH: 5000,
  BLOG_MEMORY_DEFAULT_TIER: 'ephemeral' as const,
  BLOG_MEMORY_DEFAULT_CONFIDENCE: 0.8,
}))

// configMock 只列本测试关心的键，其余从真实 config 继承。
// 原先是完全替换，config 每加一个常量这里就漏一个（已连续漏过
// BEHAVIOR_MEMORY_ANALYZER_WINDOW / BEHAVIOR_MEMORY_TFIDF_TOP_K…），
// 症状是 `No "X" export is defined on the mock`，与被测代码无关，
// 却让整个测试文件在加载阶段就死掉。
vi.mock('@akemi-mio/core/config', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  ...configMock,
}))
vi.mock('@akemi-mio/audio/MemoryAsrHybridPipeline', () => ({
  memoryAsrHybridPipeline: {
    run: vi.fn().mockResolvedValue({ text: '识别文本', requestId: 'req-1', arbitrationTriggered: false }),
    setEnabled: vi.fn(),
    isReady: vi.fn().mockReturnValue(true),
    getConfig: vi.fn().mockReturnValue({ enabled: true }),
    updateConfig: vi.fn(),
    setAsrService: vi.fn(),
    setMemoryService: vi.fn(),
    setLlmProvider: vi.fn(),
  },
}))

vi.mock('@akemi-mio/audio/AsrHotwordManager', () => ({
  asrHotwordManager: {
    isEnabled: vi.fn().mockReturnValue(true),
    setEnabled: vi.fn(),
    feedUserText: vi.fn(),
    getLongTermVocabSize: vi.fn().mockReturnValue(0),
    deleteWord: vi.fn().mockReturnValue(false),
    clearAllVocabulary: vi.fn(),
  },
}))

vi.mock('@akemi-mio/core/core/EventBus', () => ({
  eventBus: {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
  SubscriptionTracker: class {
    add = vi.fn()
    dispose = vi.fn()
  },
}))

import { registerHandlers } from '@akemi-mio/main/ipc/handlers'
import { voiceConfirmationSession } from '@akemi-mio/capabilities/tool/VoiceConfirmationSession'
import type { AgentService } from '@akemi-mio/intelligence/agent/AgentService'
import type { StateManager } from '@akemi-mio/core/core/StateManager'
import type { TtsService } from '@akemi-mio/audio/TtsService'

describe('IPC handlers', () => {
  let agentService: any
  let stateManager: any
  let ttsService: any
  let evolutionService: any
  let llmService: any
  let taskPanelService: any
  let wallpaperInteractiveService: any
  let voiceBookmarkService: any

  beforeEach(() => {
    registeredHandlers.clear()
    registeredOns.clear()
    electronAppMock.isPackaged = false
    // 确认会话是全局单例（和 voiceOdeSession 一样），状态会跨用例残留；
    // reset() 同时清掉 30s 超时定时器，否则测试进程会挂着一堆 pending timer。
    voiceConfirmationSession.reset()

    llmService = {
      refreshFromCredentials: vi.fn(),
      chatJson: vi.fn().mockResolvedValue({ data: null }),
    }

    agentService = {
      processTextInput: vi.fn().mockResolvedValue({ reply: 'test' }),
      getAsrService: vi.fn().mockReturnValue({
        transcribe: vi.fn().mockResolvedValue('test'),
        toggleHotwordManager: vi.fn(),
        getHotwordManagerState: vi.fn().mockReturnValue({ enabled: true, entryCount: 0, hotwords: [], totalInputs: 0 }),
        getLearnedVocabulary: vi.fn().mockReturnValue([]),
        getVocabularyDomainStats: vi.fn().mockReturnValue([]),
        deleteLearnedWord: vi.fn().mockReturnValue(false),
        clearAllLearnedVocabulary: vi.fn(),
        refreshContext: vi.fn(),
        setConversationContext: vi.fn(),
      }),
      getMcpManager: vi.fn().mockReturnValue({
        listServers: vi.fn().mockReturnValue([{ name: 'server1', initialized: true }]),
        callTool: vi.fn().mockResolvedValue('工具输出'),
      }),
      isBusy: vi.fn().mockReturnValue(false),
      isPaused: vi.fn().mockReturnValue(false),
      pause: vi.fn(),
      resume: vi.fn(),
      stopConversation: vi.fn().mockResolvedValue(undefined),
      saveRecoverySnapshot: vi.fn(),
      getMemoryService: vi.fn().mockReturnValue(null),
      getLlmService: vi.fn().mockReturnValue(llmService),
      getChatExecutor: vi.fn().mockReturnValue(null),
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
      setSubtitleCallback: vi.fn(),
      recordImplicitFeedback: vi.fn(),
      setEnginePreference: vi.fn(),
      getEnginePreference: vi.fn().mockReturnValue('auto'),
      getLastRoutingDecision: vi.fn().mockReturnValue(null),
      getRoutingWeights: vi.fn().mockReturnValue({}),
      getEmotionParams: vi.fn().mockReturnValue(null),
      getSceneAdaptorStatus: vi.fn().mockReturnValue({}),
      getSceneLearningData: vi.fn().mockReturnValue([]),
      getSceneOverride: vi.fn().mockReturnValue('auto'),
      setSceneOverride: vi.fn(),
      resetSceneLearningData: vi.fn(),
      replay: vi.fn().mockResolvedValue(false),
      hasReplayContent: vi.fn().mockReturnValue(false),
      setLoopMode: vi.fn(),
      isLoopMode: vi.fn().mockReturnValue(false),
    }

    evolutionService = {
      triggerNow: vi.fn().mockResolvedValue(undefined),
      getLastRun: vi.fn().mockReturnValue(0),
      getConsecutiveFailures: vi.fn().mockReturnValue(0),
    }

    taskPanelService = {
      getState: vi.fn().mockReturnValue({ visible: true, quickActions: [], recentActions: [], timestamp: Date.now() }),
      toggleVisibility: vi.fn().mockReturnValue(false),
      setVisible: vi.fn(),
      recordAction: vi.fn(),
    }

    wallpaperInteractiveService = {
      getConfig: vi.fn().mockReturnValue({ enabled: true, shortcut: 'CommandOrControl+Space' }),
      setConfig: vi.fn(),
    }

    voiceBookmarkService = {
      listBookmarks: vi.fn().mockReturnValue([{ id: 'b1', summary: '第一条' }]),
      searchBookmarks: vi.fn().mockReturnValue([{ id: 'b2', summary: '命中' }]),
      getAudioPath: vi.fn().mockReturnValue('/tmp/a.wav'),
    }

    registerHandlers(
      agentService,
      stateManager,
      ttsService,
      { current: evolutionService },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { current: voiceBookmarkService },
      { current: taskPanelService },
      { current: wallpaperInteractiveService },
    )
  })

  // 最后一个用例可能留下一个 awaiting_confirm 会话（30s 超时定时器），
  // 不在这里清掉会让 fork 一直挂到定时器触发。
  afterEach(() => {
    voiceConfirmationSession.reset()
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
        'credentials:get',
        'credentials:set',
        'config:getWakeWords',
        'health:check',
        'update:check',
        'update:download',
        'update:install',
        'window:close',
        'taskPanel:getState',
        'taskPanel:toggleVisibility',
        'taskPanel:setVisibility',
        'taskPanel:invokeQuickAction',
        'taskPanel:recordAction',
      ]
      const actual = [...registeredHandlers.keys()]
      for (const ch of expected) {
        expect(registeredHandlers.has(ch)).toBe(true)
      }
    })
  })

  describe('voice-bookmark:list / voice-bookmark:search', () => {
    // 回归：这两个通道曾长期缺失，而 preload 一直在调用它们。
    // invoke 无 handler 会 reject，渲染侧 catch{} 吞掉 → 书签面板永远空列表。
    it('list 走 service.listBookmarks 并回传 bookmarks', async () => {
      const handler = registeredHandlers.get('voice-bookmark:list')!
      expect(handler).toBeDefined()
      const result = await handler({}, 100, 0)
      expect(voiceBookmarkService.listBookmarks).toHaveBeenCalledWith(100, 0)
      expect(result).toEqual({ success: true, bookmarks: [{ id: 'b1', summary: '第一条' }] })
    })

    it('list 缺省 limit/offset 时回落到 50 / 0', async () => {
      const handler = registeredHandlers.get('voice-bookmark:list')!
      await handler({})
      expect(voiceBookmarkService.listBookmarks).toHaveBeenCalledWith(50, 0)
    })

    it('search 走 service.searchBookmarks', async () => {
      const handler = registeredHandlers.get('voice-bookmark:search')!
      expect(handler).toBeDefined()
      const result = await handler({}, '会议')
      expect(voiceBookmarkService.searchBookmarks).toHaveBeenCalledWith('会议')
      expect(result).toEqual({ success: true, bookmarks: [{ id: 'b2', summary: '命中' }] })
    })

    it('service 抛错时返回结构化失败，而不是把异常抛给渲染进程', async () => {
      voiceBookmarkService.listBookmarks = () => {
        throw new Error('boom')
      }
      const handler = registeredHandlers.get('voice-bookmark:list')!
      const result = await handler({})
      expect(result.success).toBe(false)
      expect(result.bookmarks).toEqual([])
      expect(result.error).toContain('boom')
    })
  })

  describe('ai:chat', () => {
    it('调用 agentService.processTextInput 并返回结果', async () => {
      const handler = registeredHandlers.get('ai:chat')!
      const result = await handler({}, '你好', 'req-1')
      expect(agentService.processTextInput).toHaveBeenCalledWith('你好', 'req-1', 'electron', undefined, undefined, undefined)
      expect(result).toEqual({ reply: 'test' })
    })
  })

  describe('asr:transcribe', () => {
    it('调用 asrService.transcribe', async () => {
      const handler = registeredHandlers.get('asr:transcribe')!
      const buffer = new ArrayBuffer(8)
      const result = await handler({}, buffer)
      expect(result).toHaveProperty('request_id')
      expect(result.text).toBe('识别文本')
    })

    it('ASR 未初始化时抛出错误', async () => {
      agentService.getAsrService.mockReturnValue(null)
      const handler = registeredHandlers.get('asr:transcribe')!
      await expect(handler({}, new ArrayBuffer(8))).rejects.toThrow('ASR service not initialized')
    })
  })

  describe('asr:toggle-hotwords', () => {
    it('切换热词管理', async () => {
      const handler = registeredHandlers.get('asr:toggle-hotwords')!
      const result = await handler({}, true)
      expect(result).toHaveProperty('enabled')
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

    it('does not refresh LLM runtime from DB in development mode', async () => {
      const handler = registeredHandlers.get('credentials:set')!

      await handler({}, 'llm_api_url', 'https://dev.example/v1')

      expect(llmService.refreshFromCredentials).not.toHaveBeenCalled()
    })

    it('refreshes LLM runtime from DB in packaged mode', async () => {
      electronAppMock.isPackaged = true
      const handler = registeredHandlers.get('credentials:set')!

      await handler({}, 'llm_api_url', 'https://packaged.example/v1')

      expect(llmService.refreshFromCredentials).toHaveBeenCalledTimes(1)
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

    it('不调用 agentService.pause()：关窗口不该永久禁用 agent', async () => {
      const handler = registeredHandlers.get('window:close')!
      await handler({ sender: {} })
      // pause() 会设持久标志 `_paused`，而唯一的清除路径 `agent:resume` 没有任何消费方
      // （preload 都没暴露）→ 点一次关闭按钮，之后每次 ai:chat 都返回 PAUSED 且无从恢复。
      expect(agentService.pause).not.toHaveBeenCalled()
      // 但「停止当前输出」必须保留
      expect(agentService.stopConversation).toHaveBeenCalled()
    })
  })

  describe('taskPanel handlers', () => {
    it('returns task panel state through IPC', async () => {
      const handler = registeredHandlers.get('taskPanel:getState')!
      const result = await handler()

      expect(taskPanelService.getState).toHaveBeenCalled()
      expect(result.success).toBe(true)
      expect(result.state.visible).toBe(true)
    })

    it('toggles task panel visibility through IPC', async () => {
      const handler = registeredHandlers.get('taskPanel:toggleVisibility')!
      const result = await handler()

      expect(taskPanelService.toggleVisibility).toHaveBeenCalled()
      expect(result).toEqual({ success: true, visible: false })
    })
  })

  describe('wallpaper interactive handlers', () => {
    it('returns service config when interactive service is ready', async () => {
      const handler = registeredHandlers.get('wallpaper:interactive:getConfig')!
      const result = await handler()

      expect(wallpaperInteractiveService.getConfig).toHaveBeenCalled()
      expect(result).toEqual({ enabled: true, shortcut: 'CommandOrControl+Space' })
    })

    it('falls back when the interactive ref is not a service instance', async () => {
      registeredHandlers.clear()
      registeredOns.clear()

      registerHandlers(
        agentService,
        stateManager,
        ttsService,
        { current: evolutionService },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { current: taskPanelService },
        { current: {} as any },
      )

      const handler = registeredHandlers.get('wallpaper:interactive:getConfig')!
      await expect(handler()).resolves.toEqual({ enabled: false, shortcut: 'CommandOrControl+Space' })
    })
  })

  // ══════════════════════════════════════════════════════════════════
  //  语音编排：LLM 意图解析 / 多轮语音确认 / 一站式编排
  //
  //  这 7 个通道的 preload API（llmParseIntent / voiceConfirm* / orchestrator*）
  //  与 capabilities 层实现都早已写好，唯独主进程从未注册 handler。
  //  invoke 无 handler 会 reject，调用方 catch{} 吞掉 → 「按钮没反应、控制台无错」。
  //  下面同时钉住「接上了」与「接对了」。
  // ══════════════════════════════════════════════════════════════════

  describe('voice:llmParseIntent', () => {
    it('把 LLM 返回的 JSON 解析成结构化意图', async () => {
      llmService.chatJson.mockResolvedValue({
        data: {
          matched: true,
          intent: 'analyze_code',
          description: '分析代码',
          slots: { path: 'a.ts' },
          tools: [{ tool: 'read_file', args: { path: '{{slot.path}}' } }],
          confirmMessage: '将分析 a.ts',
          requireConfirmation: false,
          confidence: 0.9,
        },
      })

      const handler = registeredHandlers.get('voice:llmParseIntent')!
      expect(handler).toBeDefined()
      const result = await handler({}, '帮我看看 a.ts')

      expect(result.success).toBe(true)
      expect(result.parsed.intent).toBe('analyze_code')
      expect(result.parsed.tools).toHaveLength(1)
      expect(result.parsed.requireConfirmation).toBe(false)
      // system prompt 必须真的传下去 —— 漏传会让 LLM 回自由文本而不是 JSON
      const [, opts] = llmService.chatJson.mock.calls[0]
      expect(opts.system).toContain('意图解析')
    })

    it('LLM 判定为闲聊时返回 success:false，而不是编造一个意图', async () => {
      llmService.chatJson.mockResolvedValue({ data: { matched: false } })
      const handler = registeredHandlers.get('voice:llmParseIntent')!
      const result = await handler({}, '随便聊聊')

      expect(result.success).toBe(false)
      expect(result.parsed).toBeNull()
      expect(result.fallbackText).toBe('随便聊聊')
    })
  })

  describe('voice:confirm:* 多轮语音确认会话', () => {
    const startParams = {
      intentName: 'read_file',
      confirmMessage: '将读取文件: a.ts',
      slots: { filename: 'a.ts' },
      tools: [{ tool: 'read_file', args: { path: '{{slot.filename}}' } }],
    }
    const start = () => registeredHandlers.get('voice:confirm:start')!
    const feed = () => registeredHandlers.get('voice:confirm:feed')!
    const state = () => registeredHandlers.get('voice:confirm:state')!

    it('start 后 state 反映 awaiting_confirm，说“确认”后 result=confirmed', async () => {
      const started = await start()({}, startParams)
      expect(started.success).toBe(true)
      expect(started.state).toBe('awaiting_confirm')
      expect(started.sessionId).toMatch(/^vconf_/)

      const s1 = await state()()
      expect(s1.active).toBe(true)
      expect(s1.intentName).toBe('read_file')
      expect(s1.confirmMessage).toBe('将读取文件: a.ts')
      expect(s1.slots).toEqual({ filename: 'a.ts' })

      const fed = await feed()({}, '确认')
      expect(fed.result).toBe('confirmed')
      expect((await state()()).active).toBe(false)
    })

    it('说“取消”后 result=rejected', async () => {
      await start()({}, startParams)
      const fed = await feed()({}, '取消')
      expect(fed.result).toBe('rejected')
      expect((await state()()).state).toBe('rejected')
    })

    it('没听清时不返回 result —— 否则调用方会把「还没确认」当成「已确认」直接执行', async () => {
      await start()({}, startParams)
      const fed = await feed()({}, '嗯嗯嗯')

      expect(fed.success).toBe(true)
      expect(fed.state).toBe('awaiting_confirm')
      expect(fed.result).toBeUndefined()
    })

    it('没有活动会话时 feed 返回结构化失败，而不是静默成功', async () => {
      const fed = await feed()({}, '确认')
      expect(fed.success).toBe(false)
      expect(fed.error).toContain('no active confirm session')
    })

    it('reset 把会话打回 idle', async () => {
      await start()({}, startParams)
      await registeredHandlers.get('voice:confirm:reset')!()
      expect((await state()()).state).toBe('idle')
      expect((await state()()).active).toBe(false)
    })
  })

  describe('voice:orchestrate:full', () => {
    const full = () => registeredHandlers.get('voice:orchestrate:full')!
    const callTool = () => agentService.getMcpManager().callTool

    it('关键词命中时开会话等待确认，不直接执行', async () => {
      const result = await full()({}, '打开 a.ts')

      expect(result.matched).toBe(true)
      expect(result.awaitingConfirm).toBe(true)
      expect(result.intent.name).toBe('read_file')
      expect(result.intent.toolSequence[0].tool).toBe('read_file')
      expect(result.state).toBe('awaiting_confirm')
      expect(callTool()).not.toHaveBeenCalled()
    })

    it('未命中且未开 LLM fallback 时返回 matched:false，且不打扰 LLM', async () => {
      const result = await full()({}, '随便聊聊')
      expect(result).toEqual({ matched: false, text: '随便聊聊' })
      expect(llmService.chatJson).not.toHaveBeenCalled()
    })

    it('尊重意图定义里的 requireConfirmation:false —— 只读意图不该被拦下来确认', async () => {
      const result = await full()({}, '进度如何')

      expect(result.matched).toBe(true)
      expect(result.intent.name).toBe('query_plan_status')
      expect(result.awaitingConfirm).toBe(false)
      expect(callTool()).toHaveBeenCalledWith('list_plans', {})
    })

    it('requireConfirm:false 时跳过确认直接执行，并接上 TTS 播报', async () => {
      const result = await full()({}, '打开 a.ts', { requireConfirm: false })

      expect(result.matched).toBe(true)
      expect(result.awaitingConfirm).toBe(false)
      expect(callTool()).toHaveBeenCalledWith('read_file', { path: 'a.ts' })
      expect(result.result.success).toBe(true)
      // VoiceToolOrchestrator 的 _autoTtsFeedback 默认开着，但不接 speaker 就永远不会播报
      expect(ttsService.speak).toHaveBeenCalled()
    })

    it('LLM fallback 命中时执行 LLM 给出的工具序列', async () => {
      llmService.chatJson.mockResolvedValue({
        data: {
          matched: true,
          intent: 'llm_read_config',
          description: '读取配置',
          slots: { file: 'config.json' },
          tools: [{ tool: 'read_file', args: { path: '{{slot.file}}' } }],
          confirmMessage: '将读取 config.json',
          requireConfirmation: false,
        },
      })

      const result = await full()({}, '随便聊聊', { useLlmFallback: true })

      expect(result.matched).toBe(true)
      expect(result.awaitingConfirm).toBe(false)
      expect(result.intent.name).toBe('llm_read_config')
      // LLM 意图名不在静态意图表里 —— 走 execute() 只会得到「未知意图」，
      // 必须走 executeSequence() 才能执行显式工具序列
      expect(callTool()).toHaveBeenCalledWith('read_file', { path: 'config.json' })
    })

    it('LLM fallback 命中高风险操作时先开会话等确认', async () => {
      llmService.chatJson.mockResolvedValue({
        data: {
          matched: true,
          intent: 'llm_write',
          description: '写文件',
          slots: {},
          tools: [{ tool: 'write_file', args: { path: 'x.ts' } }],
          confirmMessage: '将写入 x.ts',
          requireConfirmation: true,
        },
      })

      const result = await full()({}, '随便聊聊', { useLlmFallback: true })

      expect(result.awaitingConfirm).toBe(true)
      expect(result.state).toBe('awaiting_confirm')
      expect(callTool()).not.toHaveBeenCalled()
    })

    it('LLM fallback 也没命中时返回 matched:false', async () => {
      llmService.chatJson.mockResolvedValue({ data: { matched: false } })
      const result = await full()({}, '随便聊聊', { useLlmFallback: true })
      expect(result.matched).toBe(false)
    })
  })

  describe('voice:orchestrate:confirmAndExecute', () => {
    const start = () => registeredHandlers.get('voice:confirm:start')!
    const state = () => registeredHandlers.get('voice:confirm:state')!
    const exec = () => registeredHandlers.get('voice:orchestrate:confirmAndExecute')!
    const callTool = () => agentService.getMcpManager().callTool

    it('执行确认后的意图，并把会话标记为已确认', async () => {
      await start()({}, {
        intentName: 'read_file',
        confirmMessage: '将读取文件: a.ts',
        slots: { filename: 'a.ts' },
        tools: [{ tool: 'read_file', args: { path: '{{slot.filename}}' } }],
      })

      const result = await exec()({}, 'read_file', { filename: 'a.ts' })

      expect(result.success).toBe(true)
      expect(result.result.steps[0].tool).toBe('read_file')
      expect(callTool()).toHaveBeenCalledWith('read_file', { path: 'a.ts' })
      // 会话必须被同步结束 —— 否则它 30s 后超时，播报一句莫名其妙的
      // 「确认超时，操作已取消」，而操作其实已经执行完了
      expect((await state()()).state).toBe('confirmed')
    })

    it('不替「另一个意图」的会话盖章确认', async () => {
      await start()({}, {
        intentName: 'write_file',
        confirmMessage: '将写入 x.ts',
        slots: {},
        tools: [{ tool: 'write_file', args: { path: 'x.ts' } }],
      })

      await exec()({}, 'read_file', { filename: 'a.ts' })

      expect((await state()()).state).toBe('awaiting_confirm')
      expect((await state()()).intentName).toBe('write_file')
    })

    it('未知意图返回结构化失败，而不是把异常抛给渲染进程', async () => {
      const result = await exec()({}, 'definitely_not_an_intent', {})
      expect(result.success).toBe(false)
      expect(result.result.summary).toContain('未知意图')
    })
  })
})
