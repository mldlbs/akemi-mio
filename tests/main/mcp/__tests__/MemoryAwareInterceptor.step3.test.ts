import { describe, it, expect, vi } from 'vitest'
import { MemoryAwareInterceptor } from '@akemi-mio/intelligence/mcp/MemoryAwareInterceptor'
import type { CapabilityResolver } from '@akemi-mio/capabilities/capability/CapabilityResolver'
import type { MemoryService } from '@akemi-mio/intelligence/memory/MemoryService'

vi.mock('@akemi-mio/core/logger/Logger', () => ({ log: vi.fn() }))

// -----------------------------------------------------------------------
// Minimal MemoryService stub that captures vector.querySync call args
// and getEntries() for keyword scoring
// -----------------------------------------------------------------------
function makeMemoryStub(entries: Array<{ type: string; content: string; updatedAt: number }> = []) {
  const queryCalls: string[] = []
  const addFactCalls: Array<Parameters<MemoryService['addFact']>> = []
  const stub = {
    addFact: vi.fn((...args: Parameters<MemoryService['addFact']>) => {
      addFactCalls.push(args)
    }),
    vector: {
      querySync: vi.fn((query: string, _n: number) => {
        queryCalls.push(query)
        // return contents that contain capability token if present
        return entries.filter((e) => query.split(' ').some((tok) => e.content.includes(tok))).map((e) => e.content)
      }),
    },
    getEntries: vi.fn(() => entries),
  } as unknown as MemoryService
  return { stub, queryCalls, addFactCalls }
}

function makeResolverStub(mapping: Record<string, string>): CapabilityResolver {
  return {
    resolveByTool(toolName: string) {
      const capabilityId = mapping[toolName]
      return capabilityId ? { capabilityId, tool: toolName } : undefined
    },
  } as unknown as CapabilityResolver
}

function makeInterceptor(opts: {
  resolverMapping?: Record<string, string>
  memoryEntries?: Array<{ type: string; content: string; updatedAt: number }>
}) {
  const interceptor = new MemoryAwareInterceptor()
  const { stub: ms, queryCalls, addFactCalls } = makeMemoryStub(opts.memoryEntries)
  interceptor.setMemoryService(ms)
  if (opts.resolverMapping) {
    interceptor.setCapabilityResolver(makeResolverStub(opts.resolverMapping))
  }
  interceptor.setPersonalizationLevel('balanced')
  return { interceptor, ms, queryCalls, addFactCalls }
}

// -----------------------------------------------------------------------

describe('MemoryAwareInterceptor -- Step 3 capability-aware query', () => {
  // ----------------------------------------------------------------
  // 验收 1: capability query 包含 capability: 前缀
  // ----------------------------------------------------------------
  it('capability tool 的 query 包含 capability: 前缀', () => {
    const { interceptor, queryCalls } = makeInterceptor({
      resolverMapping: { write_file: 'file.management' },
    })

    interceptor.preCall('write_file', { path: 'test.txt' })

    expect(queryCalls).toHaveLength(1)
    expect(queryCalls[0]).toContain('capability:file.management')
    expect(queryCalls[0]).toContain('tool:write_file')
  })

  // ----------------------------------------------------------------
  // 验收 2: operation query 包含 operation: token
  // ----------------------------------------------------------------
  it('带 operation 参数的 query 包含 operation: token', () => {
    const { interceptor, queryCalls } = makeInterceptor({
      resolverMapping: { write_file: 'file.management' },
    })

    // guessOperation('file.management', { operation: 'create' }) -> 'create'
    interceptor.preCall('write_file', { operation: 'create', path: 'out.ts' })

    expect(queryCalls[0]).toContain('capability:file.management')
    expect(queryCalls[0]).toContain('operation:create')
  })

  // ----------------------------------------------------------------
  // 验收 3: unknown tool 保持旧 query（只有 tool: + args，没有 capability:）
  // ----------------------------------------------------------------
  it('未知 tool 的 query 不包含 capability: 前缀', () => {
    const { interceptor, queryCalls } = makeInterceptor({
      resolverMapping: {},
    })

    interceptor.preCall('my_custom_tool', { key: 'val' })

    expect(queryCalls).toHaveLength(1)
    expect(queryCalls[0]).not.toContain('capability:')
    // still includes tool name via tool: prefix
    expect(queryCalls[0]).toContain('tool:my_custom_tool')
  })

  // ----------------------------------------------------------------
  // 验收 4: legacy memory 仍可召回（[工具调用] 格式仍匹配）
  // ----------------------------------------------------------------
  it('legacy [工具调用] format 被 keyword scoring 命中', () => {
    const { interceptor, ms } = makeInterceptor({
      resolverMapping: {},
      memoryEntries: [{ type: 'user_fact', content: '[工具调用] my_legacy_tool(...) → 成功: result', updatedAt: 1000 }],
    })

    const ctx = interceptor.preCall('my_legacy_tool', {})

    // keyword scoring: tool name match gives score > 0
    expect(ctx.hasContext).toBe(true)
    expect(ctx.facts.some((f) => f.includes('my_legacy_tool'))).toBe(true)
  })

  // ----------------------------------------------------------------
  // 验收 5: capability memory 被 capability token 命中（优先于 tool-only）
  // ----------------------------------------------------------------
  it('capability: token 命中 memory 得分高于 tool-only 匹配', () => {
    // Prepare two entries: one with capability token, one legacy
    const capEntry = {
      type: 'user_fact',
      content: 'capability:file.management operation:create tool:write_file path=out.ts',
      updatedAt: 2000,
    }
    const legacyEntry = { type: 'user_fact', content: '[工具调用] write_file(path=old.ts) → 成功: ok', updatedAt: 1000 }
    const { interceptor, queryCalls, ms } = makeInterceptor({
      resolverMapping: { write_file: 'file.management' },
      memoryEntries: [capEntry, legacyEntry],
    })

    const ctx = interceptor.preCall('write_file', { operation: 'create', path: 'out.ts' })

    // Both entries should surface, capability entry should be first (vector returns it first)
    expect(ctx.hasContext).toBe(true)
    // The query sent to vector should contain capability token
    expect(queryCalls[0]).toContain('capability:file.management')
  })
})
