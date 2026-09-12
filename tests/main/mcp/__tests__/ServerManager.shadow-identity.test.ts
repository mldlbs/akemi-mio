import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityResolver } from '@akemi-mio/capabilities/capability/CapabilityResolver'
import { ServerManager } from '@akemi-mio/intelligence/mcp/ServerManager'
import { toolCallLogStore } from '@akemi-mio/capabilities/tool/ToolCallLogStore'
import { behaviorPredictor } from '@akemi-mio/intelligence/mcp/BehaviorPredictor'

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => `${process.cwd()}/test-user-data`,
  },
}))

describe('ServerManager shadow identity enrichment', () => {
  let manager: ServerManager

  beforeEach(() => {
    manager = new ServerManager()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('enriches telemetry writes with capability identity when resolver succeeds', async () => {
    const toolRecordSpy = vi.spyOn(toolCallLogStore, 'record')
    const predictorSpy = vi.spyOn(behaviorPredictor, 'recordCall')
    const resolver = {
      resolveByTool: vi.fn(() => ({ capabilityId: 'file.management', tool: 'list_files' })),
    } as unknown as CapabilityResolver

    manager.setCapabilityResolver(resolver)
    await manager.callTool('list_files', { path: '.' })

    expect(toolRecordSpy).toHaveBeenCalledWith(
      'list_files',
      { path: '.' },
      expect.any(String),
      null,
      expect.any(Number),
      true,
      expect.objectContaining({
        capability: 'file.management',
        operation: 'read',
        provider: '@builtin/core',
      }),
    )
    expect(predictorSpy).toHaveBeenCalledWith(
      'list_files',
      { path: '.' },
      0,
      true,
      expect.objectContaining({
        capability: 'file.management',
        operation: 'read',
        provider: '@builtin/core',
      }),
    )
  })

  it('does not block telemetry writes when resolver throws', async () => {
    const toolRecordSpy = vi.spyOn(toolCallLogStore, 'record')
    const predictorSpy = vi.spyOn(behaviorPredictor, 'recordCall')
    const resolver = {
      resolveByTool: vi.fn(() => {
        throw new Error('resolver boom')
      }),
    } as unknown as CapabilityResolver

    manager.setCapabilityResolver(resolver)

    await expect(manager.callTool('list_files', { path: '.' })).resolves.toEqual(expect.any(String))
    expect(toolRecordSpy).toHaveBeenCalledWith('list_files', { path: '.' }, expect.any(String), null, expect.any(Number), true, undefined)
    expect(predictorSpy).toHaveBeenCalledWith('list_files', { path: '.' }, 0, true, undefined)
  })
})
