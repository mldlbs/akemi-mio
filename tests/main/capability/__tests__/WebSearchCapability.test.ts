/**
 * WebSearchCapability — web.search / web.fetch capability 解析验证
 *
 * 2026-08-12：联网搜索接入 capability-first 模式。
 * 断言 CapabilityCatalog + CapabilityResolver 能把
 * web.search → web_search、web.fetch → web_fetch 解析到内置工具。
 */

import { describe, it, expect } from 'vitest'
import { MCPRegistry } from '@akemi-mio/intelligence/mcp/MCPRegistry'
import { CapabilityCatalog } from '@akemi-mio/capabilities/capability/CapabilityCatalog'
import { CapabilityResolver } from '@akemi-mio/capabilities/capability/CapabilityResolver'
import type { MCPServerManifest } from '@akemi-mio/intelligence/mcp/types'

const WEB_SEARCH_MANIFEST: MCPServerManifest = {
  id: 'web-search',
  name: 'Web Search',
  version: '1.0.0',
  runtime: { command: 'node', args: [] },
  capabilities: ['web.search'],
  capabilitySchemas: {
    'web.search': {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords, required' },
        max_results: { type: 'number', description: 'Max result count, default 5, range 1-10' },
        timeout_ms: { type: 'number', description: 'Per-backend timeout in ms, default 8000, range 1000-30000' },
      },
      required: ['query'],
    },
  },
  dependencies: [{ capability: 'web.search', tool: 'web_search' }],
  permissions: ['network.http'],
}

const WEB_FETCH_MANIFEST: MCPServerManifest = {
  id: 'web-fetch',
  name: 'Web Fetch',
  version: '1.0.0',
  runtime: { command: 'node', args: [] },
  capabilities: ['web.fetch'],
  capabilitySchemas: {
    'web.fetch': {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Target URL to fetch, http/https only, required' },
        max_chars: { type: 'number', description: 'Max body chars, default 6000, range 500-20000' },
        timeout_ms: { type: 'number', description: 'Request timeout in ms, default 10000, range 1000-30000' },
      },
      required: ['url'],
    },
  },
  dependencies: [{ capability: 'web.fetch', tool: 'web_fetch' }],
  permissions: ['network.http'],
}

function buildFixture(): { resolver: CapabilityResolver; catalog: CapabilityCatalog } {
  const registry = new MCPRegistry()
  registry.register(WEB_SEARCH_MANIFEST)
  registry.register(WEB_FETCH_MANIFEST)
  const catalog = new CapabilityCatalog(registry)
  catalog.rebuild()
  return { resolver: new CapabilityResolver(catalog), catalog }
}

describe('WebSearchCapability resolution', () => {
  const { resolver, catalog } = buildFixture()

  it('resolves web.search to web_search tool', () => {
    const result = resolver.resolve('web.search')
    expect(result).toBeDefined()
    expect(result!.provider.mcpServerId).toBe('web-search')
    expect(result!.provider.tool).toBe('web_search')
  })

  it('resolves web.fetch to web_fetch tool', () => {
    const result = resolver.resolve('web.fetch')
    expect(result).toBeDefined()
    expect(result!.provider.mcpServerId).toBe('web-fetch')
    expect(result!.provider.tool).toBe('web_fetch')
  })

  it('reverse-resolves web_search back to web.search', () => {
    const result = resolver.resolveByTool('web_search')
    expect(result).toBeDefined()
    expect(result!.capabilityId).toBe('web.search')
  })

  it('exposes capability schema with query / max_results / timeout_ms', () => {
    const def = catalog.get('web.search')
    expect(def).toBeDefined()
    const props = def!.inputSchema.properties as Record<string, { type: string }>
    expect(Object.keys(props).sort()).toEqual(['max_results', 'query', 'timeout_ms'])
  })
})
