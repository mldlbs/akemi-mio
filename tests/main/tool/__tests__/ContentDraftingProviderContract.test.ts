import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { CapabilityCatalog } from '@akemi-mio/capabilities/capability/CapabilityCatalog'
import { CapabilityResolver } from '@akemi-mio/capabilities/capability/CapabilityResolver'
import { MCPRegistry } from '@akemi-mio/intelligence/mcp/MCPRegistry'
import type { MCPServerManifest } from '@akemi-mio/intelligence/mcp/types'

const workspaceRoot = process.cwd()
const appRuntimePath = join(workspaceRoot, 'packages', 'main', 'src', 'bootstrap', 'AppRuntime.ts')

describe('content.drafting provider contract', () => {
  it('does not advertise an unresolved save_draft binding in AppRuntime', () => {
    const source = readFileSync(appRuntimePath, 'utf8')

    expect(source).not.toContain("capability: 'content.drafting', tool: 'save_draft'")
    expect(source).not.toContain("capabilities: ['publishing', 'content.drafting']")
  })

  it('does not resolve content.drafting from the fanqie provider manifest', () => {
    const registry = new MCPRegistry()
    const manifest: MCPServerManifest = {
      id: 'fanqie-publish',
      name: 'Fanqie Publish',
      version: '1.0.0',
      runtime: { command: 'node', args: ['fanqie-mcp.mjs'] },
      capabilities: ['publishing'],
      dependencies: [{ capability: 'publishing', tool: 'fanqie_publish_novel', optional: false }],
      permissions: ['network.http'],
    }
    registry.register(manifest)

    const catalog = new CapabilityCatalog(registry)
    catalog.rebuild()
    const resolver = new CapabilityResolver(catalog)

    expect(catalog.has('content.drafting')).toBe(false)
    expect(resolver.resolve('content.drafting')).toBeUndefined()
    expect(resolver.resolveByTool('save_draft')).toBeUndefined()
    expect(resolver.resolveByTool('fanqie_publish_novel')).toEqual({
      capabilityId: 'publishing',
      tool: 'fanqie_publish_novel',
    })
  })

  it('documents that fanqie MCP exposes no save_draft tool', () => {
    const serverSource = readFileSync(join(workspaceRoot, 'extensions', 'fanqie-mcp', 'fanqie-mcp.mjs'), 'utf8')

    expect(serverSource).not.toContain("name: 'save_draft'")
    expect(serverSource).not.toContain("case 'save_draft'")
  })
})
