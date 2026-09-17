import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
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

vi.mock('@akemi-mio/core/db/messages', () => ({
  createMessageId: vi.fn(() => 'msg-test'),
  createSessionId: vi.fn(() => 'generated-session'),
  insertMessage: vi.fn(),
  getLastSessionId: vi.fn(() => null),
  getLastMessageTime: vi.fn(() => null),
  getMessagesBySession: vi.fn(() => []),
}))

import { ChatExecutor } from '@akemi-mio/intelligence/agent/ChatExecutor'
import { CircuitBreaker } from '@akemi-mio/core/core/CircuitBreaker'
import { userBehaviorAnalyzer } from '@akemi-mio/intelligence/agent/UserBehaviorAnalyzer'
import { taskOrchestrationModeManager } from '@akemi-mio/evolution/behavior/TaskOrchestrationModeManager'

function createExecutor() {
  const llmService = {
    classifyRouteIntent: vi.fn(),
    chatWithTools: vi.fn().mockResolvedValue({ reply: 'ok' }),
  }
  const executor = new ChatExecutor(
    llmService as any,
    { stop: vi.fn(), flushBuffer: vi.fn(), speakNarrative: vi.fn(), addChunk: vi.fn() } as any,
    null,
    {} as any,
    {} as any,
    {} as any,
    { getPlan: vi.fn() } as any,
    {
      getSnapshot: vi.fn(() => ({ chatLlmCalls: 0 })),
      getConfig: vi.fn(() => ({ maxChatLlmCalls: 10 })),
      checkLlmCall: vi.fn(() => null),
      consumeLlmCall: vi.fn(),
    } as any,
    null,
    null,
    null,
    null,
    { collectCompleted: vi.fn(() => []) } as any,
    null,
    {
      getFormattedContext: vi.fn(() => ''),
      trigger: vi.fn(),
    } as any,
  )

  Object.assign(executor as any, {
    behaviorEmotionEnabled: false,
    userContextClassifierEnabled: false,
    emotionTtsEnabled: false,
    contextualTtsEnabled: false,
    toneProfileEnabled: false,
    implicitFeedbackEnabled: false,
    memoryEmotionEnabled: false,
    noTts: true,
  })

  return { executor, llmService }
}

/** handleLlmError 只用到 ctx.consecutiveTimeouts / ctx.terminalLlmError，其余字段无关 */
function makeCtx() {
  return { consecutiveTimeouts: 0, terminalLlmError: '' } as any
}

function callHandleLlmErrorWithCtx(executor: ChatExecutor, error: string | undefined) {
  const ctx = makeCtx()
  const verdict = (executor as any).handleLlmError(error, 0, [], ctx)
  return { verdict, ctx }
}

function callHandleLlmError(executor: ChatExecutor, error: string | undefined) {
  return callHandleLlmErrorWithCtx(executor, error).verdict
}

describe('ChatExecutor 熔断器接入', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
    userBehaviorAnalyzer.reset()
    taskOrchestrationModeManager.reset()
  })

  it('LLM 调用成功（无错误）→ 熔断器复位', () => {
    const { executor } = createExecutor()
    const cb = new CircuitBreaker(3, 1000)
    cb.onFailure('llm')
    cb.onFailure('llm')
    expect(cb.getSnapshot().llm.failures).toBe(2)

    executor.setCircuitBreaker(cb)
    callHandleLlmError(executor, undefined)

    expect(cb.getSnapshot()).toEqual({})
  })

  it('RETRYABLE 错误（NETWORK）累计到阈值后熔断', () => {
    const { executor } = createExecutor()
    const cb = new CircuitBreaker(3, 1000)
    executor.setCircuitBreaker(cb)

    callHandleLlmError(executor, 'NETWORK')
    callHandleLlmError(executor, 'NETWORK')
    expect(cb.allow('llm')).toBeNull() // 还没到阈值
    callHandleLlmError(executor, 'NETWORK')

    expect(cb.allow('llm')).toMatch(/熔断/)
  })

  it('RATE_LIMITED 也计入熔断（限流是瞬时故障）', () => {
    const { executor } = createExecutor()
    const cb = new CircuitBreaker(2, 1000)
    executor.setCircuitBreaker(cb)

    callHandleLlmError(executor, 'RATE_LIMITED')
    callHandleLlmError(executor, 'RATE_LIMITED')

    expect(cb.getSnapshot().llm.state).toBe('open')
  })

  it('超时计入熔断', () => {
    const { executor } = createExecutor()
    const cb = new CircuitBreaker(5, 1000)
    executor.setCircuitBreaker(cb)

    callHandleLlmError(executor, 'TIMEOUT')
    expect(cb.getSnapshot().llm.failures).toBe(1)
    callHandleLlmError(executor, 'TIMEOUT')
    expect(cb.getSnapshot().llm.failures).toBe(2)
  })

  it('业务/状态类错误不计入熔断（否则用户发个超长 prompt 就把 LLM 熔断）', () => {
    const { executor } = createExecutor()
    const cb = new CircuitBreaker(1, 1000)
    executor.setCircuitBreaker(cb)

    callHandleLlmError(executor, 'API_ERROR:400') // INVALID_REQUEST
    callHandleLlmError(executor, 'insufficient tool messages') // CORRUPTED_STATE
    callHandleLlmError(executor, 'context_length_exceeded') // CONTEXT_OVERFLOW

    expect(cb.getSnapshot()).toEqual({})
    expect(cb.allow('llm')).toBeNull()
  })

  it('NETWORK 计入熔断，但不在本层重试（避免与 LlmService 内部重试叠加成 3×3）', () => {
    const { executor } = createExecutor()
    const cb = new CircuitBreaker(5, 1000)
    executor.setCircuitBreaker(cb)

    const verdict = callHandleLlmError(executor, 'NETWORK')

    // ErrorClassifier 把裸错误码 NETWORK 判为 FATAL → 立即终止本轮，不重试。
    // 这是刻意的：LlmService.chatWithTools 内部已对 NETWORK 做过 3 次指数退避重试。
    expect(verdict).toBe('return')
    // 但它仍然是「服务不可用」信号，必须计入熔断
    expect(cb.getSnapshot().llm.failures).toBe(1)
  })

  it('未注入熔断器时 handleLlmError 不抛错（可选依赖）', () => {
    const { executor } = createExecutor()
    expect(() => callHandleLlmError(executor, 'NETWORK')).not.toThrow()
    expect(() => callHandleLlmError(executor, undefined)).not.toThrow()
  })
})

describe('ChatExecutor 失败原因上报（ctx.terminalLlmError）', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
    userBehaviorAnalyzer.reset()
    taskOrchestrationModeManager.reset()
  })

  it('放弃重试时把真实错误码写进 ctx —— 否则上层只能一律报 NO_REPLY', () => {
    const { executor } = createExecutor()

    const { verdict, ctx } = callHandleLlmErrorWithCtx(executor, 'NETWORK')

    expect(verdict).toBe('return')
    expect(ctx.terminalLlmError).toBe('NETWORK')
  })

  it('连续超时到第 3 次才放弃，并记录 TIMEOUT', () => {
    const { executor } = createExecutor()
    const ctx = makeCtx()
    const call = () => (executor as any).handleLlmError('TIMEOUT', 0, [], ctx)

    expect(call()).toBe('continue') // 第 1 次：注入提示后继续
    expect(call()).toBe('continue') // 第 2 次
    expect(ctx.terminalLlmError).toBe('') // 还在重试，不该记成终止原因

    expect(call()).toBe('return') // 第 3 次：放弃
    expect(ctx.terminalLlmError).toBe('TIMEOUT')
  })

  it('可自愈的错误不写 terminalLlmError（本轮还能救回来）', () => {
    const { executor } = createExecutor()

    const { verdict, ctx } = callHandleLlmErrorWithCtx(executor, 'context_length_exceeded')

    expect(verdict).toBe('continue')
    expect(ctx.terminalLlmError).toBe('')
  })

  it('成功（无错误）不写 terminalLlmError', () => {
    const { executor } = createExecutor()

    const { verdict, ctx } = callHandleLlmErrorWithCtx(executor, undefined)

    expect(verdict).toBeNull()
    expect(ctx.terminalLlmError).toBe('')
  })
})
