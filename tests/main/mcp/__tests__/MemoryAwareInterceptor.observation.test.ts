import { describe, it, expect, vi } from 'vitest'
import { MemoryAwareInterceptor } from '@akemi-mio/intelligence/mcp/MemoryAwareInterceptor'
import { MemoryRetriever } from '@akemi-mio/intelligence/mcp/ToolMemoryDefaults'
import type { CapabilityResolver } from '@akemi-mio/capabilities/capability/CapabilityResolver'
import type { MemoryService } from '@akemi-mio/intelligence/memory/MemoryService'

vi.mock('@akemi-mio/core/logger/Logger', () => ({ log: vi.fn() }))

type MemoryEntryStub = {
  type: string
  content: string
  updatedAt: number
}

function makeResolverStub(mapping: Record<string, string>): CapabilityResolver {
  return {
    resolveByTool(toolName: string) {
      const capabilityId = mapping[toolName]
      return capabilityId ? { capabilityId, tool: toolName } : undefined
    },
  } as unknown as CapabilityResolver
}

function makeMemoryHarness(entries: MemoryEntryStub[] = []) {
  let now = 1_000
  const storedEntries = [...entries]
  const addFactCalls: Array<Parameters<MemoryService['addFact']>> = []

  const stub = {
    addFact: vi.fn((content: string, confidence?: number, options?: Parameters<MemoryService['addFact']>[2]) => {
      addFactCalls.push([content, confidence, options])
      storedEntries.push({
        type: 'user_fact',
        content,
        updatedAt: ++now,
      })
    }),
    vector: {
      querySync: vi.fn((query: string) => {
        const tokens = query.split(' ').filter(Boolean)
        return storedEntries
          .filter((entry) => tokens.some((token) => entry.content.includes(token)))
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((entry) => entry.content)
      }),
    },
    getEntries: vi.fn(() => storedEntries),
  } as unknown as MemoryService

  return { stub, storedEntries, addFactCalls }
}

describe('MemoryAwareInterceptor -- Step 4 observation metrics', () => {
  it('Identity Coverage: 已映射 tool 会稳定写入 capability identity', () => {
    const interceptor = new MemoryAwareInterceptor()
    const { stub, addFactCalls } = makeMemoryHarness()
    interceptor.setMemoryService(stub)
    interceptor.setCapabilityResolver(
      makeResolverStub({
        write_file: 'file.management',
        brave_search: 'search.retrieval',
      }),
    )

    interceptor.postCall('write_file', { operation: 'create', path: 'a.txt' }, 'ok', true)
    interceptor.postCall('brave_search', { q: 'memory bias' }, '2 results', true)
    interceptor.postCall('unknown_tool', { key: 'value' }, 'noop', true)

    const resolved = addFactCalls.filter(([, , options]) => options?.identity?.capability)
    expect(resolved).toHaveLength(2)
    expect(resolved.map(([, , options]) => options?.identity?.capability)).toEqual(['file.management', 'search.retrieval'])
  })

  it('Retrieval Alignment: postCall 写入的新记忆可被 capability query 直接召回', () => {
    const interceptor = new MemoryAwareInterceptor()
    const { stub } = makeMemoryHarness()
    interceptor.setMemoryService(stub)
    interceptor.setCapabilityResolver(makeResolverStub({ write_file: 'file.management' }))
    interceptor.setPersonalizationLevel('balanced')

    interceptor.postCall('write_file', { operation: 'create', path: 'docs/spec.md' }, 'created docs/spec.md', true)

    const context = interceptor.preCall('write_file', {
      operation: 'create',
      path: 'docs/spec.md',
    })

    expect(context.hasContext).toBe(true)
    expect(context.facts[0]).toContain('capability:file.management')
    expect(context.facts[0]).toContain('operation:create')
    expect(context.facts[0]).toContain('tool:write_file')
  })

  it('Bias Reduction: capability-tagged memory 在混合数据中优先于 legacy tool-only memory', () => {
    const interceptor = new MemoryAwareInterceptor()
    const { stub } = makeMemoryHarness([
      {
        type: 'user_fact',
        content: '[工具调用] write_file(path=old.ts) → 成功: ok',
        updatedAt: 1,
      },
    ])
    interceptor.setMemoryService(stub)
    interceptor.setCapabilityResolver(makeResolverStub({ write_file: 'file.management' }))
    interceptor.setPersonalizationLevel('balanced')

    interceptor.postCall('write_file', { operation: 'create', path: 'new.ts' }, 'created new.ts', true)

    const context = interceptor.preCall('write_file', {
      operation: 'create',
      path: 'new.ts',
    })

    expect(context.hasContext).toBe(true)
    expect(context.facts[0]).toContain('capability:file.management')
    expect(context.facts[0]).not.toContain('[工具调用] write_file(path=old.ts)')
  })

  it('新格式仍可被 ToolMemoryDefaults.getRecentToolCalls 按 tool 召回', () => {
    const interceptor = new MemoryAwareInterceptor()
    const { stub } = makeMemoryHarness()
    interceptor.setMemoryService(stub)
    interceptor.setCapabilityResolver(makeResolverStub({ write_file: 'file.management' }))

    interceptor.postCall('write_file', { operation: 'create', path: 'draft.md' }, 'created draft.md', true)

    const retriever = new MemoryRetriever()
    retriever.setMemoryService(stub)

    const recent = retriever.getRecentToolCalls('write_file', 5)
    expect(recent).toHaveLength(1)
    expect(recent[0]).toContain('tool:write_file')
  })

  it('新格式仍可被 ToolMemoryDefaults.getFrequentTools 统计到', () => {
    const interceptor = new MemoryAwareInterceptor()
    const { stub } = makeMemoryHarness()
    interceptor.setMemoryService(stub)
    interceptor.setCapabilityResolver(makeResolverStub({ write_file: 'file.management' }))

    interceptor.postCall('write_file', { operation: 'create', path: 'one.md' }, 'created one.md', true)
    interceptor.postCall('write_file', { operation: 'create', path: 'two.md' }, 'created two.md', true)

    const retriever = new MemoryRetriever()
    retriever.setMemoryService(stub)

    expect(retriever.getFrequentTools(5)).toEqual([{ toolName: 'write_file', count: 2 }])
  })
})
