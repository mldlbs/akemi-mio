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
import { EvaluationEmitter } from '@akemi-mio/core/core/evaluation/EvaluationEmitter'
import { InMemoryEvaluationRepository } from '../../core/evaluation/__test_support__'

function createExecutor() {
  const executor = new ChatExecutor(
    {} as any,
    { stop: vi.fn(), flushBuffer: vi.fn(), speakNarrative: vi.fn() } as any,
    null,
    {} as any,
    {} as any,
    {} as any,
    {
      getPlan: vi.fn(),
    } as any,
    {
      getSnapshot: vi.fn(() => ({ chatLlmCalls: 0 })),
      getConfig: vi.fn(() => ({ maxChatLlmCalls: 0 })),
    } as any,
    null,
    null,
    null,
    null,
    {} as any,
    null,
    {
      getFormattedContext: vi.fn(() => ''),
      trigger: vi.fn(),
    } as any,
  )

  executor.setEvaluationEmitter(new EvaluationEmitter(new InMemoryEvaluationRepository(), 'chat-test'))

  Object.assign(executor as any, {
    behaviorEmotionEnabled: false,
    userContextClassifierEnabled: false,
    emotionTtsEnabled: false,
    contextualTtsEnabled: false,
    toneProfileEnabled: false,
    implicitFeedbackEnabled: false,
    memoryEmotionEnabled: false,
  })

  return executor
}

function getEvents(executor: ChatExecutor) {
  const emitter = (executor as any).evaluationEmitter as EvaluationEmitter
  const repo = (emitter as any).store as InMemoryEvaluationRepository
  return repo.events
}

function getBoundaryEvents(executor: ChatExecutor) {
  return getEvents(executor).filter((event) => ['user.message', 'task.started', 'agent.response', 'task.completed'].includes(event.type))
}

describe('ChatExecutor behavioral evidence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('emits closed chat boundary facts for a successful trace', async () => {
    const executor = createExecutor()
    const requestId = 'trace-success'
    const sessionId = 'session-success'
    const text = 'Please summarize this.'
    const reply = 'Here is the summary.'

    vi.spyOn(executor as any, 'toolLoop').mockResolvedValue(reply)

    const result = await executor.run(text, requestId, 'electron', undefined, sessionId, true)

    expect(result).toEqual({ reply })

    const events = getBoundaryEvents(executor)

    expect(events).toHaveLength(4)
    expect(events.map((event) => event.type)).toEqual(['user.message', 'task.started', 'agent.response', 'task.completed'])
    expect(events.every((event) => event.traceId === requestId)).toBe(true)
    expect(events.every((event) => event.sessionId === sessionId)).toBe(true)
    expect(events[0].payload).toMatchObject({ type: 'user.message', length: text.length })
    expect(events[1].payload).toMatchObject({ type: 'task.started', kind: 'chat', inputLength: text.length })
    expect(events[2].payload).toMatchObject({ type: 'agent.response', length: reply.length })
    expect(events[3].payload).toMatchObject({ type: 'task.completed', kind: 'chat', outcome: 'completed' })
  })

  it('emits failed task.completed with the internal error string', async () => {
    const executor = createExecutor()
    const requestId = 'trace-failed'
    const sessionId = 'session-failed'
    const error = new Error('boom')

    vi.spyOn(executor as any, 'toolLoop').mockRejectedValue(error)

    const result = await executor.run('Trigger failure', requestId, 'electron', undefined, sessionId, true)

    expect(result).toEqual({ error: 'INTERNAL' })

    const events = getBoundaryEvents(executor)

    expect(events.map((event) => event.type)).toEqual(['user.message', 'task.started', 'task.completed'])
    expect(events.every((event) => event.traceId === requestId)).toBe(true)
    expect(events.every((event) => event.sessionId === sessionId)).toBe(true)
    expect(events[2].payload).toMatchObject({
      type: 'task.completed',
      kind: 'chat',
      outcome: 'failed',
      error: String(error),
    })
  })

  it('emits abandoned task.completed with NO_REPLY when the chat path has no reply', async () => {
    const executor = createExecutor()
    const requestId = 'trace-no-reply'
    const sessionId = 'session-no-reply'

    vi.spyOn(executor as any, 'toolLoop').mockResolvedValue('')

    const result = await executor.run('Say something', requestId, 'electron', undefined, sessionId, true)

    expect(result).toEqual({ error: 'NO_REPLY' })

    const events = getBoundaryEvents(executor)

    expect(events.map((event) => event.type)).toEqual(['user.message', 'task.started', 'task.completed'])
    expect(events.every((event) => event.traceId === requestId)).toBe(true)
    expect(events.every((event) => event.sessionId === sessionId)).toBe(true)
    expect(events[2].payload).toMatchObject({
      type: 'task.completed',
      kind: 'chat',
      outcome: 'abandoned',
      error: 'NO_REPLY',
    })
  })
})
