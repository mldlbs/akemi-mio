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
import { RunState } from '@akemi-mio/intelligence/agent/runstate'
import { insertMessage } from '@akemi-mio/core/db/messages'
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

function getBoundaryEvents(executor: ChatExecutor) {
  const emitter = (executor as any).evaluationEmitter as EvaluationEmitter
  const repo = (emitter as any).store as InMemoryEvaluationRepository
  return repo.events.filter((event) =>
    ['user.message', 'task.started', 'agent.response', 'task.completed'].includes(event.type),
  )
}

/** 轮询等待条件成立（不依赖 fakeTimers / vi.waitFor） */
async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now()
  while (!predicate()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('until() 超时：条件始终未满足')
    await new Promise((r) => setTimeout(r, 5))
  }
}

/**
 * `ChatExecutor.run()` 的重入守卫。
 *
 * 背景：`run()` 会覆盖一批实例级状态 —— `runContext`（`interrupt` / `stop` / `isBusy` 都读它）、
 * `noTts`、换 session 时的 `currentSessionId` / `workingMemory`。两次 run 并行时后来者会把这些
 * 全部改写：先来那次失去可中断性（`stop()` 打到别人的 ctx），且先结束的一方在 finally 里把
 * `runContext` 置 null，把仍在跑的那次「变得不忙」（`isBusy()` 恒 false → SleepCycle 可能在
 * 对话进行中插进来）。所以守卫必须拒绝第二次，而不是让它并发跑。
 *
 * 并发是可达的：electron 的 InputBar 在忙碌时只把发送按钮换成停止按钮、**不禁用 textarea**，
 * 回车仍会触发第二次 `sendChat`；壁纸任务面板的「快捷提问」与 uumit 外部消息同理。
 */
describe('ChatExecutor 重入守卫（BUSY）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('上一轮还在跑时，第二次 run 立即返回 BUSY，且第一轮不受影响', async () => {
    const executor = createExecutor()
    const entered: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    vi.spyOn(executor as any, 'toolLoop').mockImplementation(async (_m: any, ctx: any) => {
      entered.push(ctx.runId)
      if (entered.length === 1) await gate // 第一轮挂住，模拟「上一轮还在跑」
      return '第一轮的回复'
    })

    const first = executor.run('第一条', 'trace-first', 'electron', undefined, 'session-1', true)
    await until(() => entered.length === 1)

    // ── 关键断言：第二次被拒绝，而不是并发执行 ──
    const second = await executor.run('第二条', 'trace-second', 'electron', undefined, 'session-1', true)
    expect(second).toEqual({ error: 'BUSY' })

    // 第二轮根本没进入 toolLoop
    expect(entered).toEqual(['trace-first'])

    // 守卫在副作用之前：第二条用户消息没有被写库
    expect(vi.mocked(insertMessage)).toHaveBeenCalledTimes(1)

    // 被拒绝的那次没有产生任何评估事件
    const events = getBoundaryEvents(executor)
    expect(events.every((event) => event.traceId === 'trace-first')).toBe(true)

    // runContext 仍是第一轮的 —— 这正是守卫要保护的不变量
    expect((executor as any).runContext?.runId).toBe('trace-first')

    // 第一轮照常跑完
    release()
    await expect(first).resolves.toEqual({ reply: '第一轮的回复' })
  })

  it('第一轮结束后守卫解除，新一轮可以正常开始', async () => {
    const executor = createExecutor()
    vi.spyOn(executor as any, 'toolLoop').mockResolvedValue('回复')

    await expect(executor.run('一', 'trace-1', 'electron', undefined, 'session-1', true)).resolves.toEqual({
      reply: '回复',
    })
    // runContext 在 finally 里清空 → 守卫不再拦截
    expect((executor as any).runContext).toBeNull()

    await expect(executor.run('二', 'trace-2', 'electron', undefined, 'session-1', true)).resolves.toEqual({
      reply: '回复',
    })
  })

  it('第一轮抛异常结束后守卫同样解除（不靠成功路径清理）', async () => {
    const executor = createExecutor()
    vi.spyOn(executor as any, 'toolLoop').mockRejectedValueOnce(new Error('boom'))
    vi.spyOn(executor as any, 'toolLoop').mockResolvedValue('回复')

    await expect(executor.run('一', 'trace-1', 'electron', undefined, 'session-1', true)).resolves.toEqual({
      error: 'INTERNAL',
    })
    expect((executor as any).runContext).toBeNull()

    await expect(executor.run('二', 'trace-2', 'electron', undefined, 'session-1', true)).resolves.toEqual({
      reply: '回复',
    })
  })
})

/**
 * `isBusy()` 必须与重入守卫用同一个判据。
 *
 * 它是后台系统的「对话中不要插进来」锁：`SleepCycle.run()`（每 2 小时）、
 * `SelfEvolutionService.schedulerTick()`、`TaskPanelService.getState()` 都读它。
 *
 * 旧实现读 `runContext.running`（= `state === RUNNING || WAIT_TOOL`），
 * 但真实 `toolLoop` 在转 `COMPLETED`（`ChatExecutor:1713`）之后还有一次
 * `await this.hybridPipeline.validateReplyQuality(...)`（`:1739`，一次仲裁 LLM 调用）
 * 才真正返回。那段窗口里本轮仍占用 `runContext`、重入守卫仍会拒绝，但 `running` 已是 false ——
 * 后台系统会在对话收尾期间插进来，任务面板也会显示「待机」。
 *
 * 下面的 mock 复刻的正是这个收尾形态：先 `RUNNING`（真实代码在 `toolLoop` 首行 `:1245` 转），
 * 再 `COMPLETED`，然后还有一次 await，最后才 return。
 */
describe('ChatExecutor.isBusy() 覆盖整个 run（含收尾窗口）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('状态已转 COMPLETED 但仍在收尾时，isBusy() 仍为 true', async () => {
    const executor = createExecutor()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    vi.spyOn(executor as any, 'toolLoop').mockImplementation(async (_m: any, ctx: any) => {
      ctx.transition(RunState.RUNNING)
      ctx.transition(RunState.COMPLETED)
      await gate
      return '回复'
    })

    const run = executor.run('一', 'trace-1', 'electron', undefined, 'session-1', true)
    await until(() => (executor as any).runContext?.state === RunState.COMPLETED)

    // 旧的判据（runContext.running）在这一刻是 false —— 这正是它漏掉的窗口
    expect((executor as any).runContext.running).toBe(false)

    // 后台系统据此跳过、重入守卫据此拒绝：同一个问题必须只有一个答案
    expect(executor.isBusy()).toBe(true)
    expect(await executor.run('二', 'trace-2', 'electron', undefined, 'session-1', true)).toEqual({ error: 'BUSY' })

    release()
    await expect(run).resolves.toEqual({ reply: '回复' })

    // 真正结束后锁要释放，否则后台系统永远不再运行
    expect(executor.isBusy()).toBe(false)
  })
})
