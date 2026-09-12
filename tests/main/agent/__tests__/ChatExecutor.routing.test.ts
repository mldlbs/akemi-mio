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
import { RunContext } from '@akemi-mio/intelligence/agent/runstate'
import type { Message } from '@akemi-mio/intelligence/agent/context'
import { userBehaviorAnalyzer } from '@akemi-mio/intelligence/agent/UserBehaviorAnalyzer'
import { taskOrchestrationModeManager } from '@akemi-mio/evolution/behavior/TaskOrchestrationModeManager'
import { executionGoalStore } from '@akemi-mio/evolution/goals'

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

  vi.spyOn(executor as any, 'handlePlanForceContinue').mockResolvedValue(null)

  return { executor, llmService }
}

describe('ChatExecutor semantic routing', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
    userBehaviorAnalyzer.reset()
    taskOrchestrationModeManager.reset()
  })

  it('routes the user turn before entering the tool loop', async () => {
    const { executor } = createExecutor()
    const route = vi.fn().mockResolvedValue({ route: 'observe_first', confidence: 0.8, reason: 'vague project ask' })
    ;(executor as any).setIntentRouter({ route })
    vi.spyOn(executor as any, 'toolLoop').mockResolvedValue('ok')

    await executor.run('help me inspect this repo', 'req-observe', 'electron', undefined, 'sess-observe', true)

    expect(route).toHaveBeenCalledWith(
      expect.objectContaining({
        userText: 'help me inspect this repo',
        scene: expect.any(String),
        hasProjectContext: expect.any(Boolean),
        recentToolNames: [],
      }),
      'req-observe',
    )
    expect((executor as any).currentRouteDecision).toMatchObject({ route: 'observe_first' })
  })

  it('clears prior session tool history before routing a new session', async () => {
    const { executor } = createExecutor()
    userBehaviorAnalyzer.reset()
    userBehaviorAnalyzer.recordToolCall('read_file')
    const route = vi.fn().mockResolvedValue({ route: 'observe_first', confidence: 0.8, reason: 'vague project ask' })
    ;(executor as any).setIntentRouter({ route })
    vi.spyOn(executor as any, 'toolLoop').mockResolvedValue('ok')

    await executor.run('help me inspect this repo', 'req-session-reset', 'electron', undefined, 'sess-new', true)

    expect(route).toHaveBeenCalledWith(
      expect.objectContaining({
        recentToolNames: [],
      }),
      'req-session-reset',
    )
  })

  it('feeds current session tool history into later turns', async () => {
    const { executor, llmService } = createExecutor()
    const route = vi
      .fn()
      .mockResolvedValue({ route: 'observe_first', confidence: 0.8, reason: 'vague project ask' })
      .mockResolvedValue({ route: 'observe_first', confidence: 0.8, reason: 'vague project ask' })
    ;(executor as any).setIntentRouter({ route })
    ;(executor as any).toolScheduler = {
      executeAll: vi.fn().mockResolvedValue([{ id: 'call-1', name: 'read_file', success: true, content: 'ok' }]),
    }
    ;(executor as any).goalGuardrail = {
      checkBatch: vi.fn().mockResolvedValue({ status: 'approved' }),
      onToolSuccess: vi.fn(),
    }
    llmService.chatWithTools
      .mockResolvedValueOnce({
        reply: '',
        toolCalls: [{ id: 'call-1', name: 'read_file', arguments: '{}' }],
      })
      .mockResolvedValueOnce({ reply: 'done' })
      .mockResolvedValue({ reply: 'done' })

    await executor.run('help me inspect this repo', 'req-session-1', 'electron', undefined, 'sess-shared', true)
    await executor.run('inspect the same session again', 'req-session-2', 'electron', undefined, 'sess-shared', true)

    expect(route).toHaveBeenNthCalledWith(1, expect.objectContaining({ recentToolNames: [] }), 'req-session-1')
    expect(route).toHaveBeenNthCalledWith(2, expect.objectContaining({ recentToolNames: ['read_file'] }), 'req-session-2')
  })

  it('does not carry current-session tool history across session switches', async () => {
    const { executor, llmService } = createExecutor()
    const route = vi.fn().mockResolvedValue({ route: 'observe_first', confidence: 0.8, reason: 'vague project ask' })
    ;(executor as any).setIntentRouter({ route })
    ;(executor as any).toolScheduler = {
      executeAll: vi.fn().mockResolvedValue([{ id: 'call-1', name: 'read_file', success: true, content: 'ok' }]),
    }
    ;(executor as any).goalGuardrail = {
      checkBatch: vi.fn().mockResolvedValue({ status: 'approved' }),
      onToolSuccess: vi.fn(),
    }
    llmService.chatWithTools
      .mockResolvedValueOnce({
        reply: '',
        toolCalls: [{ id: 'call-1', name: 'read_file', arguments: '{}' }],
      })
      .mockResolvedValue({ reply: 'done' })

    await executor.run('help me inspect this repo', 'req-session-a', 'electron', undefined, 'sess-a', true)
    await executor.run('fresh session should not inherit tools', 'req-session-b', 'electron', undefined, 'sess-b', true)

    expect(route).toHaveBeenNthCalledWith(2, expect.objectContaining({ recentToolNames: [] }), 'req-session-b')
  })

  it('falls back to observe_first when the semantic router rejects', async () => {
    const { executor } = createExecutor()
    const route = vi.fn().mockRejectedValue(new Error('router unavailable'))
    ;(executor as any).setIntentRouter({ route })
    vi.spyOn(executor as any, 'toolLoop').mockResolvedValue('ok')

    await executor.run('帮我看看这个项目哪里有问题', 'req-router-fail', 'electron', undefined, 'sess-router-fail', true)

    expect((executor as any).currentRouteDecision).toMatchObject({
      route: 'observe_first',
      reason: expect.stringContaining('router failed'),
    })
  })

  it('uses observe_first to force read-only tools on the first round', async () => {
    const { executor, llmService } = createExecutor()
    ;(executor as any).currentRouteDecision = { route: 'observe_first', confidence: 0.8, reason: 'vague project ask' }
    const messages: Message[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'help me inspect this repo' },
    ]

    await (executor as any).toolLoop(messages, new RunContext('req-observe'), 'req-observe', 'electron')

    expect(llmService.chatWithTools).toHaveBeenCalledWith(
      messages,
      'req-observe',
      120000,
      expect.any(Function),
      undefined,
      ['list_files', 'read_file', 'grep', 'analyze_codebase'],
      expect.objectContaining({ toolChoiceMode: 'required' }),
    )
  })

  it('preserves forbidden scene filters over observe_first route tools', async () => {
    const { executor, llmService } = createExecutor()
    ;(executor as any).currentRouteDecision = { route: 'observe_first', confidence: 0.8, reason: 'vague project ask' }
    ;(executor as any).sceneAllowedTools = []
    const messages: Message[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'help me inspect this repo' },
    ]

    await (executor as any).toolLoop(messages, new RunContext('req-forbidden'), 'req-forbidden', 'electron')

    expect(llmService.chatWithTools).toHaveBeenCalledWith(
      messages,
      'req-forbidden',
      120000,
      expect.any(Function),
      undefined,
      [],
      expect.objectContaining({ toolChoiceMode: 'auto' }),
    )
  })

  it('applies route policy to the first actual model call after a probing continue', async () => {
    const { executor, llmService } = createExecutor()
    ;(executor as any).currentRouteDecision = { route: 'observe_first', confidence: 0.8, reason: 'vague project ask' }
    const messages: Message[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'help me inspect this repo' },
    ]
    vi.spyOn((executor as any).resourceBudget, 'checkLlmCall')
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
    vi.spyOn((executor as any).resourceBudget, 'consumeLlmCall').mockImplementation(vi.fn())
    vi.spyOn((executor as any).toolPolicyPlanner, 'toToolFilter').mockReturnValue(undefined)
    vi.spyOn((executor as any).toolPolicyPlanner, 'decide').mockReturnValue({ preference: 'auto', confidence: 0.5, reason: 'DEFAULT' })
    vi.spyOn((executor as any).toolPromptAssembler, 'assemble').mockReturnValue(null)
    vi.spyOn(taskOrchestrationModeManager, 'getModeRecommendations')
      .mockReturnValueOnce({
        reduceToolChain: false,
        extraPromptModules: [],
        insertProbingQuestion: true,
        probingQuestionText: 'probe first',
      })
      .mockReturnValueOnce({
        reduceToolChain: false,
        extraPromptModules: [],
        insertProbingQuestion: false,
        probingQuestionText: '',
      })

    await (executor as any).toolLoop(messages, new RunContext('req-probe'), 'req-probe', 'electron')

    expect(llmService.chatWithTools).toHaveBeenCalledWith(
      messages,
      'req-probe',
      120000,
      expect.any(Function),
      undefined,
      ['list_files', 'read_file', 'grep', 'analyze_codebase'],
      expect.objectContaining({ toolChoiceMode: 'required' }),
    )
  })

  it('degrades required tool routing to auto when no tools are available', async () => {
    const { executor, llmService } = createExecutor()
    ;(executor as any).currentRouteDecision = { route: 'tool_required', confidence: 0.9, reason: 'must act' }
    llmService.chatWithTools.mockResolvedValueOnce({ error: 'NO_TOOLS_AVAILABLE' }).mockResolvedValueOnce({ reply: 'ok after downgrade' })
    const messages: Message[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: '帮我处理这个项目' },
    ]

    const reply = await (executor as any).toolLoop(messages, new RunContext('req-no-tools'), 'req-no-tools', 'electron')

    expect(reply).toBe('ok after downgrade')
    expect(llmService.chatWithTools).toHaveBeenCalledTimes(2)
    expect(llmService.chatWithTools).toHaveBeenNthCalledWith(
      1,
      messages,
      'req-no-tools',
      120000,
      expect.any(Function),
      undefined,
      undefined,
      expect.objectContaining({ toolChoiceMode: 'required' }),
    )
    expect(llmService.chatWithTools).toHaveBeenNthCalledWith(
      2,
      messages,
      'req-no-tools',
      120000,
      expect.any(Function),
      undefined,
      undefined,
      expect.objectContaining({ toolChoiceMode: 'auto' }),
    )
  })

  it('retries with a correction hint when a required route yields no tool calls', async () => {
    const { executor, llmService } = createExecutor()
    ;(executor as any).currentRouteDecision = { route: 'tool_required', confidence: 0.9, reason: 'must act' }
    llmService.chatWithTools.mockResolvedValue({ reply: 'just chatting' })
    const messages: Message[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: '把这个项目构建一下' },
    ]

    const reply = await (executor as any).toolLoop(messages, new RunContext('req-force'), 'req-force', 'electron')

    expect(reply).toBe('just chatting')
    // 初始调用 + 2 次纠正重试，均保持 required 策略
    expect(llmService.chatWithTools).toHaveBeenCalledTimes(3)
    for (const call of llmService.chatWithTools.mock.calls) {
      expect(call[6]).toEqual(expect.objectContaining({ toolChoiceMode: 'required' }))
    }
    // 第二次调用前已注入“必须调用工具”的纠正提示
    const secondMessages = llmService.chatWithTools.mock.calls[1][0] as Message[]
    expect(secondMessages.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('必须调用工具'))).toBe(true)
  })
  it('forwards route-required signal to behavior adaptation so it cannot intervene', async () => {
    const { executor, llmService } = createExecutor()
    ;(executor as any).currentRouteDecision = { route: 'tool_required', confidence: 0.9, reason: 'must act' }
    ;(executor as any).sceneAllowedTools = ['web_search', 'web_fetch', 'list_files', 'read_file', 'grep', 'analyze_codebase']
    const getRecs = vi.spyOn(taskOrchestrationModeManager, 'getModeRecommendations').mockImplementation((forceExecute?: boolean) =>
      forceExecute
        ? {
            reduceToolChain: false,
            addExplanation: false,
            simplifyPrompt: false,
            insertProbingQuestion: false,
            probingQuestionText: '',
            extraPromptModules: [],
          }
        : {
            reduceToolChain: true,
            addExplanation: false,
            simplifyPrompt: true,
            insertProbingQuestion: true,
            probingQuestionText: 'probe first',
            extraPromptModules: ['【简化模式】请使用最简短的步骤完成任务'],
          },
    )
    llmService.chatWithTools.mockResolvedValue({ reply: 'just chatting' })
    const messages: Message[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: '有什么新闻吗' },
    ]

    const reply = await (executor as any).toolLoop(messages, new RunContext('req-no-adapt'), 'req-no-adapt', 'electron')

    expect(reply).toBe('just chatting')
    // 强制工具路由下行为适应系统收到 forceExecute=true，不产生干预建议
    expect(getRecs).toHaveBeenCalledWith(true)
    // 不得插入探测性问题（不会先 continue 跳过 LLM）
    expect(messages.some((m) => m.role === 'user' && m.content === 'probe first')).toBe(false)
    // 不得注入简化/引导提示
    expect(messages.some((m) => typeof m.content === 'string' && m.content.includes('简化模式'))).toBe(false)
    // 工具链不被缩减，首次调用仍携带完整工具列表
    expect(llmService.chatWithTools).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'req-no-adapt',
      120000,
      expect.any(Function),
      undefined,
      ['web_search', 'web_fetch', 'list_files', 'read_file', 'grep', 'analyze_codebase'],
      expect.objectContaining({ toolChoiceMode: 'required' }),
    )
  })
})

describe('ChatExecutor execution goal binding (M6.1)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
    userBehaviorAnalyzer.reset()
    taskOrchestrationModeManager.reset()
  })

  function setupGoalLoop(verdict: 'continue' | 'completed') {
    const { executor, llmService } = createExecutor()
    ;(executor as any).currentRouteDecision = { route: 'tool_required', confidence: 0.9, reason: 'must act' }
    ;(executor as any).thinkStageCount = 99
    ;(executor as any).toolScheduler = {
      executeAll: vi.fn().mockResolvedValue([{ id: 'call-1', name: 'edit_file', success: true, content: 'done' }]),
    }
    ;(executor as any).guardrail = {
      apply: vi.fn().mockReturnValue({ action: 'continue' }),
    }
    ;(executor as any).goalGuardrail = {
      checkBatch: vi.fn().mockResolvedValue({ status: 'approved' }),
      onToolSuccess: vi.fn(),
    }
    llmService.chatWithTools
      .mockResolvedValueOnce({
        reply: '',
        toolCalls: [{ id: 'call-1', name: 'edit_file', arguments: '{}' }],
      })
      .mockResolvedValue({ reply: 'done' })

    const evidence = [{ type: 'file_changed', value: 'changed', tool: 'edit_file', step: 0, success: true, createdAt: 0 }]
    const evaluation =
      verdict === 'completed'
        ? {
            verdict: 'completed' as const,
            matchedCriteria: ['??????'],
            failedCriteria: [],
            reason: 'all success criteria matched',
          }
        : {
            verdict: 'continue' as const,
            matchedCriteria: [],
            failedCriteria: ['??????'],
            reason: 'criteria not yet satisfied',
          }
    vi.spyOn((executor as any).goalPipeline, 'recordRound').mockReturnValue({ evidence, evaluation })
    if (verdict === 'completed') {
      vi.spyOn((executor as any).goalPipeline, 'verifyCompletion').mockResolvedValue({ verdict: 'confirmed', reason: 'ok' })
    }
    return { executor }
  }

  it('records evidence for an active execution goal after each tool batch', async () => {
    const { executor } = setupGoalLoop('continue')
    const ctx = new RunContext('req-goal-record')
    ctx.activeGoalId = 'goal-1'
    const messages: Message[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'help me fix the file' },
    ]

    await (executor as any).toolLoop(messages, ctx, 'req-goal-record', 'electron')

    const recordRound = (executor as any).goalPipeline.recordRound as ReturnType<typeof vi.fn>
    expect(recordRound).toHaveBeenCalledTimes(1)
    expect(recordRound).toHaveBeenCalledWith('goal-1', expect.any(Array), expect.any(Array), 0)
    expect(ctx.evidence).toHaveLength(1)
    expect(ctx.evidence[0]).toMatchObject({ type: 'file_changed', value: 'changed' })
  })

  it('injects a completion hint and schedules verification when the goal completes', async () => {
    const { executor } = setupGoalLoop('completed')
    const ctx = new RunContext('req-goal-completed')
    ctx.activeGoalId = 'goal-1'
    const messages: Message[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'help me fix the file' },
    ]

    await (executor as any).toolLoop(messages, ctx, 'req-goal-completed', 'electron')

    const verifyCompletion = (executor as any).goalPipeline.verifyCompletion as ReturnType<typeof vi.fn>
    expect(verifyCompletion).toHaveBeenCalledWith('goal-1', expect.anything(), 'req-goal-completed')
    expect(messages.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('??????'))).toBe(true)
  })

  it('re-injects the methodology hint on later tool rounds', async () => {
    const { executor, llmService } = createExecutor()
    ;(executor as any).currentRouteDecision = { route: 'tool_required', confidence: 0.9, reason: 'must act' }
    ;(executor as any).thinkStageCount = 99
    ;(executor as any).currentMethodologyId = 'executing_plan'
    ;(executor as any).toolScheduler = {
      executeAll: vi.fn().mockResolvedValue([{ id: 'call-1', name: 'edit_file', success: true, content: 'done' }]),
    }
    ;(executor as any).guardrail = {
      apply: vi.fn().mockReturnValue({ action: 'continue' }),
    }
    ;(executor as any).goalGuardrail = {
      checkBatch: vi.fn().mockResolvedValue({ status: 'approved' }),
      onToolSuccess: vi.fn(),
    }
    vi.spyOn((executor as any).goalPipeline, 'recordRound').mockReturnValue(null)
    llmService.chatWithTools
      .mockResolvedValueOnce({ reply: '', toolCalls: [{ id: 'call-1', name: 'edit_file', arguments: '{}' }] })
      .mockResolvedValueOnce({ reply: '', toolCalls: [{ id: 'call-2', name: 'edit_file', arguments: '{}' }] })
      .mockResolvedValue({ reply: 'done' })
    const ctx = new RunContext('req-method-persist')
    ctx.activeGoalId = 'goal-method'
    const messages: Message[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'help me fix the file' },
    ]

    await (executor as any).toolLoop(messages, ctx, 'req-method-persist', 'electron')

    expect(llmService.chatWithTools).toHaveBeenCalledTimes(3)
    const secondMessages = llmService.chatWithTools.mock.calls[1][0] as Message[]
    expect(secondMessages.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('方法论：分步执行'))).toBe(
      true,
    )
  })

  describe('ChatExecutor execution goal lifecycle (M6.1)', () => {
    it('abandons the active goal on external stop', () => {
      const { executor } = createExecutor()
      ;(executor as any).currentGoalId = 'goal-stopped'
      ;(executor as any).currentMethodologyId = 'systematic_debugging'
      const abandonSpy = vi.spyOn((executor as any).goalPipeline, 'abandonGoal').mockReturnValue(true)

      ;(executor as any).abandonActiveGoal('user_stopped')

      expect(abandonSpy).toHaveBeenCalledWith('goal-stopped', 'user_stopped')
      expect((executor as any).currentGoalId).toBeNull()
      expect((executor as any).currentMethodologyId).toBeNull()
    })

    it('does not abandon a previous goal from another session on supersede', () => {
      const { executor } = createExecutor()
      ;(executor as any).currentGoalId = 'goal-other-session'
      vi.spyOn(executionGoalStore, 'get').mockReturnValue({
        id: 'goal-other-session',
        sessionId: 'session-b',
        objective: 'x',
        successCriteria: [],
        status: 'executing',
        planId: null,
        methodology: null,
        currentStep: 0,
        evidence: [],
        createdAt: 1,
        updatedAt: 1,
        completedAt: null,
      } as any)
      const abandonSpy = vi.spyOn((executor as any).goalPipeline, 'abandonGoal')

      ;(executor as any).abandonSupersededGoal('session-a')

      expect(abandonSpy).not.toHaveBeenCalled()
    })

    it('abandons the previous same-session goal when a new request supersedes it', () => {
      const { executor } = createExecutor()
      ;(executor as any).currentGoalId = 'goal-superseded'
      vi.spyOn(executionGoalStore, 'get').mockReturnValue({
        id: 'goal-superseded',
        sessionId: 'session-a',
        objective: 'x',
        successCriteria: [],
        status: 'executing',
        planId: null,
        methodology: null,
        currentStep: 0,
        evidence: [],
        createdAt: 1,
        updatedAt: 1,
        completedAt: null,
      } as any)
      const abandonSpy = vi.spyOn((executor as any).goalPipeline, 'abandonGoal').mockReturnValue(true)

      ;(executor as any).abandonSupersededGoal('session-a')

      expect(abandonSpy).toHaveBeenCalledWith('goal-superseded', 'superseded_by_new_request')
    })
  })
})
