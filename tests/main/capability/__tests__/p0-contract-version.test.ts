/**
 * 机制涌现 P0 (a): contractVersion 盖章链路
 * Catalog 从 manifest.version 盖章 → Resolver 返回 → Binding 携带
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { CapabilityCatalog } from '@akemi-mio/capabilities/capability/CapabilityCatalog'
import { CapabilityResolver } from '@akemi-mio/capabilities/capability/CapabilityResolver'
import { CapabilityServiceImpl } from '@akemi-mio/capabilities/capability/CapabilityServiceImpl'
import type { MCPServerManifest } from '@akemi-mio/intelligence-mcp/types'

class FakeRegistry {
  private manifests: MCPServerManifest[] = []
  register(m: MCPServerManifest): void {
    this.manifests.push(m)
  }
  list(): MCPServerManifest[] {
    return [...this.manifests]
  }
}

const MANIFEST: MCPServerManifest = {
  id: 'fanqie-publish',
  name: 'Fanqie Publish',
  version: '2.1.0',
  runtime: { command: 'node', args: ['fanqie-mcp.mjs'] },
  capabilities: ['publishing'],
  dependencies: [{ capability: 'publishing', tool: 'fanqie_publish_novel', optional: false }],
  permissions: ['network.http'],
}

const MANIFEST_NO_VERSION_FALLBACK: MCPServerManifest = {
  id: 'edge-provider',
  name: 'Edge',
  version: '',
  runtime: { command: 'node', args: ['edge.js'] },
  capabilities: ['edge.cap'],
  permissions: [],
}

describe('P0 contractVersion stamping', () => {
  let registry: FakeRegistry
  let catalog: CapabilityCatalog
  let resolver: CapabilityResolver

  beforeEach(() => {
    registry = new FakeRegistry()
    registry.register(MANIFEST)
    catalog = new CapabilityCatalog(registry as any)
    resolver = new CapabilityResolver(catalog)
  })

  it('catalog stamps manifest.version onto CapabilityDefinition', () => {
    const def = catalog.get('publishing')
    expect(def).toBeDefined()
    expect(def!.version).toBe('2.1.0')
  })

  it('resolver returns non-empty contractVersion on resolve', () => {
    const result = resolver.resolve('publishing')
    expect(result).toBeDefined()
    expect(result!.contractVersion).toBe('2.1.0')
    expect(result!.contractVersion.length).toBeGreaterThan(0)
  })

  it('resolver returns non-empty contractVersion on toolHint path', () => {
    const result = resolver.resolve('publishing', 'fanqie_publish_novel')
    expect(result).toBeDefined()
    expect(result!.contractVersion).toBe('2.1.0')
  })

  it('service binding carries contractVersion', async () => {
    const fakeServerManager = { callTool: async () => ({ content: [], isError: false }) } as any
    const service = new CapabilityServiceImpl(resolver, fakeServerManager)
    const binding = await service.resolve('publishing')
    expect(binding).toBeDefined()
    expect(binding!.contractVersion).toBe('2.1.0')
  })

  it('empty manifest.version falls back to 1 (never empty binding)', () => {
    registry.register(MANIFEST_NO_VERSION_FALLBACK)
    catalog.rebuild()
    const result = resolver.resolve('edge.cap')
    expect(result).toBeDefined()
    expect(result!.contractVersion).toBe('1')
    expect(result!.contractVersion.length).toBeGreaterThan(0)
  })
})
