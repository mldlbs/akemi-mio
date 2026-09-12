/**
 * CreativityExecutor — 独立工作区隔离测试
 *
 * 验证：
 * 1. 默认隔离开启：query 收到 cwd=worktree，执行后调用 deliver
 * 2. CREATIVITY_EXEC_ISOLATED=0：cwd 回退主仓库，不调用 deliver
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

describe('CreativityExecutor workspace isolation', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    delete process.env.CREATIVITY_EXEC_ISOLATED
    delete process.env.LLM_KEY
  })

  const problem = {
    id: 'problem-isolated-1',
    source: 'feature' as const,
    severity: 'info',
    title: '实现一个测试功能',
    description: '验证隔离执行',
    file: '',
    line: 0,
    estimatedCostChars: 10,
    lastSeen: Date.now(),
    occurrenceCount: 1,
    context: {
      raw: '',
      snippet: '',
      metadata: { hypothesisId: 'h1' },
    },
  }

  it('默认隔离：query 收到 cwd=worktree 并调用 deliver 落地', async () => {
    process.env.LLM_KEY = 'test-key'
    const queryMock = vi.fn(async function* () {
      yield { type: 'text', text: '<result>SUCCESS 完成</result>' }
    })
    const fakeWorkspace = {
      ensure: vi.fn(async () => 'D:/fake/worktree'),
      deliver: vi.fn(async () => ({ applied: true, changedFiles: ['src/foo.ts'] })),
    }

    vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }))
    vi.doMock('@akemi-mio/intelligence/llm/runtimeConfig', () => ({
      getRuntimeLlmConfig: vi.fn(() => ({
        chat: { apiKey: 'k', apiUrl: 'u', model: 'm' },
        code: { apiKey: 'k', apiUrl: 'u', model: 'm' },
        text: { apiKey: 'k', apiUrl: 'u', model: 'm' },
        vision: { apiKey: 'k', apiUrl: 'u', model: 'm' },
      })),
    }))
    vi.doMock('@akemi-mio/creativity', () => ({ ideaStore: null }))
    vi.doMock('@akemi-mio/core/credentials/CredentialsManager', () => ({ credentialsManager: { get: vi.fn(() => '') } }))

    const { CreativityExecutor } = await import('@akemi-mio/evolution/automation/CreativityExecutor')
    const executor = new CreativityExecutor(fakeWorkspace as any)

    const result = await executor.execute(problem as any)

    expect(result.success).toBe(true)
    expect(fakeWorkspace.ensure).toHaveBeenCalled()
    expect(queryMock.mock.calls[0]?.[0]).toMatchObject({
      options: expect.objectContaining({ cwd: 'D:/fake/worktree' }),
    })
    expect(fakeWorkspace.deliver).toHaveBeenCalledWith('problem-isolated-1', '实现一个测试功能')
  })

  it('CREATIVITY_EXEC_ISOLATED=0：cwd 回退主仓库且不 deliver', async () => {
    process.env.CREATIVITY_EXEC_ISOLATED = '0'
    process.env.LLM_KEY = 'test-key'
    const queryMock = vi.fn(async function* () {
      yield { type: 'text', text: '<result>SUCCESS 完成</result>' }
    })
    const fakeWorkspace = {
      ensure: vi.fn(async () => 'D:/fake/worktree'),
      deliver: vi.fn(async () => ({ applied: true, changedFiles: [] })),
    }

    vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }))
    vi.doMock('@akemi-mio/intelligence/llm/runtimeConfig', () => ({
      getRuntimeLlmConfig: vi.fn(() => ({
        chat: { apiKey: 'k', apiUrl: 'u', model: 'm' },
        code: { apiKey: 'k', apiUrl: 'u', model: 'm' },
        text: { apiKey: 'k', apiUrl: 'u', model: 'm' },
        vision: { apiKey: 'k', apiUrl: 'u', model: 'm' },
      })),
    }))
    vi.doMock('@akemi-mio/creativity', () => ({ ideaStore: null }))
    vi.doMock('@akemi-mio/core/credentials/CredentialsManager', () => ({ credentialsManager: { get: vi.fn(() => '') } }))

    const { CreativityExecutor } = await import('@akemi-mio/evolution/automation/CreativityExecutor')
    const executor = new CreativityExecutor(fakeWorkspace as any)

    const result = await executor.execute(problem as any)

    expect(result.success).toBe(true)
    expect(fakeWorkspace.ensure).not.toHaveBeenCalled()
    expect(queryMock.mock.calls[0]?.[0]).toMatchObject({
      options: expect.objectContaining({ cwd: process.cwd() }),
    })
    expect(fakeWorkspace.deliver).not.toHaveBeenCalled()
  })
})
