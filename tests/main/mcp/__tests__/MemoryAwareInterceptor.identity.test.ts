import { describe, it, expect, vi } from 'vitest'
import { MemoryAwareInterceptor } from '@akemi-mio/intelligence/mcp/MemoryAwareInterceptor'
import type { CapabilityResolver } from '@akemi-mio/capabilities/capability/CapabilityResolver'
import type { MemoryService } from '@akemi-mio/intelligence/memory/MemoryService'

vi.mock('@akemi-mio/core/logger/Logger', () => ({ log: vi.fn() }))

function makeMemoryStub() {
  const calls: Array<Parameters<MemoryService['addFact']>> = []
  const stub = {
    addFact: vi.fn((...args: Parameters<MemoryService['addFact']>) => {
      calls.push(args)
    }),
  } as unknown as MemoryService
  return { stub, calls }
}

function makeResolverStub(mapping: Record<string, string>): CapabilityResolver {
  return {
    resolveByTool(toolName: string) {
      const capabilityId = mapping[toolName]
      return capabilityId ? { capabilityId, tool: toolName } : undefined
    },
  } as unknown as CapabilityResolver
}

function makeInterceptor(opts: { resolverMapping?: Record<string, string>; resolverThrows?: boolean }) {
  const interceptor = new MemoryAwareInterceptor()
  const { stub: ms, calls } = makeMemoryStub()
  interceptor.setMemoryService(ms)

  if (opts.resolverThrows) {
    const broken = {
      resolveByTool: vi.fn(() => {
        throw new Error('resolver boom')
      }),
    } as unknown as CapabilityResolver
    interceptor.setCapabilityResolver(broken)
  } else if (opts.resolverMapping) {
    interceptor.setCapabilityResolver(makeResolverStub(opts.resolverMapping))
  }

  return { interceptor, ms, calls }
}

describe('MemoryAwareInterceptor -- Step 2 identity contract', () => {
  it('已知 capability tool 写入带 identity 的 fact', () => {
    const { interceptor, calls } = makeInterceptor({
      resolverMapping: { write_file: 'file.management' },
    })

    interceptor.postCall('write_file', { operation: 'create', path: '/tmp/a.txt' }, 'ok', true)

    expect(calls).toHaveLength(1)
    const [, , options] = calls[0]
    expect(options?.identity).toMatchObject({
      capability: 'file.management',
      tool: 'write_file',
    })
    expect(options?.identity?.operation).toBe('create')
  })

  it('未知 tool 不附加 identity，content 包含工具名', () => {
    const { interceptor, calls } = makeInterceptor({
      resolverMapping: {},
    })

    interceptor.postCall('my_custom_tool', { key: 'val' }, 'result', true)

    expect(calls).toHaveLength(1)
    const [content, , options] = calls[0]
    expect(options?.identity).toBeUndefined()
    expect(content).toContain('my_custom_tool')
  })

  it('resolver 抛出异常时 postCall 不抛出，memory 正常写入', () => {
    const { interceptor, calls } = makeInterceptor({ resolverThrows: true })

    expect(() => interceptor.postCall('search', { q: 'test' }, 'results', true)).not.toThrow()

    expect(calls.length).toBeGreaterThanOrEqual(1)
  })

  it('identity 同时携带 capability 和 tool 字段', () => {
    const { interceptor, calls } = makeInterceptor({
      resolverMapping: { brave_search: 'search.retrieval' },
    })

    interceptor.postCall('brave_search', { q: 'TypeScript generics' }, '10 results', true)

    expect(calls).toHaveLength(1)
    const [, , options] = calls[0]
    expect(options?.identity?.capability).toBe('search.retrieval')
    expect(options?.identity?.tool).toBe('brave_search')
    expect(options?.identity?.operation).toBe('query')
  })

  it('未设置 resolver 时 identity 为 undefined（向后兼容）', () => {
    const { interceptor, calls } = makeInterceptor({})

    interceptor.postCall('run_shell', { cmd: 'ls' }, 'output', true)

    expect(calls).toHaveLength(1)
    const [, , options] = calls[0]
    expect(options?.identity).toBeUndefined()
  })
})
