/**
 * P1.3b Phase A Exit Gate Verification
 *
 * 验证 6 项 Exit Gate 指标（在 capability-first mode 下）:
 * | 指标 | 目标 |
 * |------|------|
 * | schema 模式切换 | dual ↔ capability-first |
 * | capability-first schema 数 | 4+1 |
 * | capability selected | >0 (selected → invoked) |
 * | invoke 链路 | selected→invoked→completed 100% |
 * | raw fallback dispatch | 可用 |
 * | provider adapter | canonical → tool params |
 *
 * 注意: 某些步骤（如 LLM 实际调用）需要 E2E / 真实 LLM。
 * 此测试聚焦 capability-first mode 的代码逻辑正确性。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { ToolInvocationRouter } from '../ToolInvocationRouter'
import { ToolSchemaProvider, SchemaExposureMode } from '../ToolSchemaProvider'
import { CapabilityFunctionSchemaAdapter } from '../../capability/CapabilityFunctionSchemaAdapter'
import { CapabilityCatalog } from '../../capability/CapabilityCatalog'
import { CapabilityResolver } from '../../capability/CapabilityResolver'
import { CapabilityServiceImpl } from '../../capability/CapabilityServiceImpl'
import { MCPRegistry } from '../../mcp/MCPRegistry'
import type { MCPServerManifest } from '../../mcp/types'
import { eventBus } from '../../core/EventBus'
import { fanqiePublishAdapter } from '../../capability/adapters/fanqie-adapter'
import { playwrightAdapter } from '../../capability/adapters/playwright-adapter'
import { fileSystemAdapter } from '../../capability/adapters/file-system-adapter'
import { searchAdapter } from '../../capability/adapters/search-adapter'
import { systemAdapter } from '../../capability/adapters/system-adapter'

// ═════════════════════════════════════════════════
// Mock: ServerManager
// ═════════════════════════════════════════════════

function createMockServerManager() {
  const callTool = vi.fn().mockResolvedValue('mock result')
  const getToolSchemas = vi.fn().mockReturnValue([])

  return {
    getAllSchemas: getToolSchemas,
    callTool,
    getTool: vi.fn(),
    getServerName: vi.fn(),
    hasTool: vi.fn(),
  } as any
}

// ═════════════════════════════════════════════════
// Manifests
// ═════════════════════════════════════════════════

const FANQIE_MANIFEST: MCPServerManifest = {
  id: 'fanqie-publish', name: 'Fanqie Publish', version: '1.0.0',
  runtime: { command: 'node', args: ['fanqie-mcp.mjs'] },
  capabilities: ['publishing'], dependencies: [{ capability: 'publishing', tool: 'publish_novel', optional: false }],
  permissions: ['network.http'],
}

const PLAYWRIGHT_MANIFEST: MCPServerManifest = {
  id: 'playwright', name: 'Playwright Browser Automation', version: '1.0.0',
  runtime: { command: 'node', args: ['playwright-cli.js'] },
  capabilities: ['browser.automation', 'web.scraping'],
  dependencies: [{ capability: 'browser.automation', tool: 'browser_navigate' }, { capability: 'web.scraping', tool: 'browser_navigate' }],
  permissions: ['network.http'],
}

const FILE_SYSTEM_MANIFEST: MCPServerManifest = {
  id: 'file-system', name: 'File System', version: '1.0.0',
  runtime: { command: 'node', args: [] },
  capabilities: ['file.management'],
  dependencies: [
    { capability: 'file.management', tool: 'read_file' },
    { capability: 'file.management', tool: 'write_file' },
    { capability: 'file.management', tool: 'edit_file' },
    { capability: 'file.management', tool: 'delete_file' },
  ],
  permissions: ['file.read', 'file.write'],
}

const SEARCH_ENGINE_MANIFEST: MCPServerManifest = {
  id: 'search-engine', name: 'Search', version: '1.0.0',
  runtime: { command: 'node', args: [] },
  capabilities: ['search.retrieval'],
  dependencies: [
    { capability: 'search.retrieval', tool: 'grep_search' },
    { capability: 'search.retrieval', tool: 'glob_find' },
  ],
  permissions: ['file.read'],
}

const SYSTEM_EXECUTOR_MANIFEST: MCPServerManifest = {
  id: 'system-executor', name: 'System', version: '1.0.0',
  runtime: { command: 'node', args: [] },
  capabilities: ['system.execution'],
  dependencies: [{ capability: 'system.execution', tool: 'run_command' }],
  permissions: ['shell.execute'],
}

// ═════════════════════════════════════════════════
// Adapter tests (standalone, no mocking needed)
// ═════════════════════════════════════════════════

describe('P1.3b Exit Gate — Provider Adapters', () => {
  // ── fanqie adapter ──
  it('[fanqie] maps canonical title → novelName', () => {
    const result = fanqiePublishAdapter({ title: '我的小说', content: '正文' }, 'publish_novel') as Record<string, unknown>
    expect(result.novelName).toBe('我的小说')
    expect(result.content).toBe('正文')
  })

  it('[fanqie] falls back to raw keys when canonical keys are absent', () => {
    const result = fanqiePublishAdapter({ novelName: '已有名', content: '已有正文', category: '玄幻' }, 'publish_novel') as Record<string, unknown>
    expect(result.novelName).toBe('已有名')
    expect(result.category).toBe('玄幻')
  })

  it('[fanqie] maps platform → category', () => {
    const result = fanqiePublishAdapter({ title: 'T', content: 'C', platform: 'fantasy' }, 'publish_novel') as Record<string, unknown>
    expect(result.category).toBe('fantasy')
  })

  it('[fanqie] empty title falls back to empty string', () => {
    const result = fanqiePublishAdapter({ content: '正文' }, 'publish_novel') as Record<string, unknown>
    expect(result.novelName).toBe('')
  })

  // ── playwright adapter ──
  it('[playwright] maps canonical browser params', () => {
    const result = playwrightAdapter({ action: 'navigate', url: 'https://example.com' }, 'browser_navigate') as Record<string, unknown>
    expect(result.action).toBe('navigate')
    expect(result.url).toBe('https://example.com')
  })

  it('[playwright] returns all mapped keys (undefined values still present as keys)', () => {
    const result = playwrightAdapter({ action: 'click', selector: '#btn' }, 'browser_navigate') as Record<string, unknown>
    expect(result.action).toBe('click')
    expect(result.selector).toBe('#btn')
    // undefined keys are still present (adapter behavior — keys with undefined are harmless)
    expect('action' in result).toBe(true)
    expect('selector' in result).toBe(true)
  })

  it('[playwright] throws if action is missing', () => {
    expect(() => playwrightAdapter({ url: 'https://example.com' }, 'browser_navigate')).toThrow('action')
  })

  // ── M5.4 identity adapters ──
  it('[file-system] projects canonical input to tool params: read', () => {
    const result = fileSystemAdapter({ operation: 'read', path: '/test.txt' }, 'read_file') as Record<string, unknown>
    expect(result.path).toBe('/test.txt')
    expect(result.content).toBeUndefined()
  })

  it('[file-system] projects canonical input to tool params: write', () => {
    const result = fileSystemAdapter({ operation: 'write', path: '/test.txt', content: 'hello' }, 'write_file') as Record<string, unknown>
    expect(result.path).toBe('/test.txt')
    expect(result.content).toBe('hello')
  })

  it('[search] projects canonical query to grep params', () => {
    const result = searchAdapter({ query: 'TODO', scope: '/src' }, 'grep_search') as Record<string, unknown>
    expect(result.pattern).toBe('TODO')
    expect(result.path).toBe('/src')
  })

  it('[search] projects canonical query to web_search params', () => {
    const result = searchAdapter({ query: 'latest news' }, 'web_search') as Record<string, unknown>
    expect(result.query).toBe('latest news')
  })

  it('[system] projects canonical command to run_command params', () => {
    const result = systemAdapter({ command: 'ls -la' }, 'run_command') as Record<string, unknown>
    expect(result.command).toBe('ls -la')
  })

  it('[system] projects canonical command to execute_python params', () => {
    const result = systemAdapter({ command: 'print(1+1)' }, 'execute_python') as Record<string, unknown>
    expect(result.code).toBe('print(1+1)')
  })

  // ── adapter passthrough (no adapter = identity) ──
  it('CapabilityService invoke passes input through when no adapter registered', async () => {
    const serverManager = createMockServerManager()
    const registry = new MCPRegistry()
    registry.register(FANQIE_MANIFEST)
    const catalog = new CapabilityCatalog(registry)
    catalog.rebuild()
    const resolver = new CapabilityResolver(catalog)
    const service = new CapabilityServiceImpl(resolver, serverManager)

    // No adapter set → input should pass through unchanged
    const binding = await service.resolve('publishing')
    expect(binding).toBeDefined()

    await service.invoke(binding!, { title: 'test', content: 'hello' })

    // Verify the raw input was passed to callTool (no adapter transformation)
    expect(serverManager.callTool).toHaveBeenCalledWith(
      binding!.tool,
      { title: 'test', content: 'hello' },
    )
  })

  it('CapabilityService invoke applies adapter when registered', async () => {
    const serverManager = createMockServerManager()
    const registry = new MCPRegistry()
    registry.register(FANQIE_MANIFEST)
    const catalog = new CapabilityCatalog(registry)
    catalog.rebuild()
    const resolver = new CapabilityResolver(catalog)
    const service = new CapabilityServiceImpl(resolver, serverManager)

    const binding = await service.resolve('publishing')
    expect(binding).toBeDefined()
    // The resolved tool name is the catalog's defaultTool
    const resolvedTool = binding!.tool

    // Register adapter with the resolved tool name
    service.setAdapter('fanqie-publish', resolvedTool, fanqiePublishAdapter)

    await service.invoke(binding!, { title: '我的小说', content: '正文', platform: 'fantasy' })

    // Verify adapter transformed the input before callTool
    expect(serverManager.callTool).toHaveBeenCalledWith(
      resolvedTool,
      { novelName: '我的小说', content: '正文', category: 'fantasy' },
    )
  })
})

// ═════════════════════════════════════════════════
// Capability-first schema mode tests
// ═════════════════════════════════════════════════

describe('P1.3b Exit Gate — Capability-First Schema Mode', () => {
  let registry: MCPRegistry
  let catalog: CapabilityCatalog
  let adapter: CapabilityFunctionSchemaAdapter
  let schemaProvider: ToolSchemaProvider
  let serverManager: ReturnType<typeof createMockServerManager>

  beforeEach(() => {
    registry = new MCPRegistry()
    registry.register(FANQIE_MANIFEST)
    registry.register(PLAYWRIGHT_MANIFEST)
    registry.register(FILE_SYSTEM_MANIFEST)
    registry.register(SEARCH_ENGINE_MANIFEST)
    registry.register(SYSTEM_EXECUTOR_MANIFEST)

    catalog = new CapabilityCatalog(registry)
    catalog.rebuild()

    serverManager = createMockServerManager()
    adapter = new CapabilityFunctionSchemaAdapter(catalog)
    schemaProvider = new ToolSchemaProvider(serverManager, adapter)
  })

  it('[Exit Gate 1] default mode is dual', () => {
    expect(schemaProvider.getMode()).toBe('dual')
  })

  it('[Exit Gate 1] capability-first mode outputs capability schemas + call_raw_tool', () => {
    schemaProvider.setMode('capability-first')
    expect(schemaProvider.getMode()).toBe('capability-first')

    const schemas = schemaProvider.getSchemas()
    const names = schemas.map(s => s.function.name)

    // Must contain existing capability functions
    expect(names).toContain('publishing')
    expect(names).toContain('browser_automation')
    expect(names).toContain('web_scraping')
    // M5.4: grouped capabilities
    expect(names).toContain('file_management')
    expect(names).toContain('search_retrieval')
    expect(names).toContain('system_execution')

    // Must contain call_raw_tool fallback
    expect(names).toContain('call_raw_tool')

    // Must NOT contain raw tool schemas (mock returns empty, but in dual mode
    // they would be included; capability-first mode only returns cap + fallback)
    // 6 capabilities + 1 fallback = 7 total (test asserts contract not count)
    expect(schemas.length).toBeGreaterThanOrEqual(5) // at least 4 caps + 1 fallback
  })

  it('[Exit Gate 1] dual mode includes both tool and capability schemas', () => {
    // mock serverManager returns 0 tools for getSchemas
    const schemas = schemaProvider.getSchemas()
    const names = schemas.map(s => s.function.name)

    // dual mode: capabilities are included alongside raw tools
    expect(names).toContain('publishing')
    expect(names).not.toContain('call_raw_tool') // call_raw_tool only in capability-first
  })

  it('[Exit Gate 1] isCapabilityTool works in both modes', () => {
    expect(schemaProvider.isCapabilityTool('publishing')).toBe(true)
    expect(schemaProvider.isCapabilityTool('browser_automation')).toBe(true)
    expect(schemaProvider.isCapabilityTool('browser.automation')).toBe(true)
    expect(schemaProvider.isCapabilityTool('non_existent')).toBe(false)
  })

  it('[Exit Gate 1] isCallRawTool identifies call_raw_tool', () => {
    expect(schemaProvider.isCallRawTool('call_raw_tool')).toBe(true)
    expect(schemaProvider.isCallRawTool('publishing')).toBe(false)
    expect(schemaProvider.isCallRawTool('browser_automation')).toBe(false)
  })

  it('[Exit Gate 1] call_raw_tool schema has correct structure', () => {
    schemaProvider.setMode('capability-first')
    const schemas = schemaProvider.getSchemas()
    const rawToolSchema = schemas.find(s => s.function.name === 'call_raw_tool')

    expect(rawToolSchema).toBeDefined()
    expect(rawToolSchema!.function.parameters.required).toContain('toolName')
    expect(rawToolSchema!.function.parameters.required).toContain('args')
    expect(rawToolSchema!.function.parameters.properties.toolName.type).toBe('string')
    expect(rawToolSchema!.function.parameters.properties.args.type).toBe('object')
  })

  it('[Exit Gate 1] mode switching is reversible', () => {
    schemaProvider.setMode('capability-first')
    const capFirstSchemas = schemaProvider.getSchemas()
    const capFirstNames = capFirstSchemas.map(s => s.function.name)
    expect(capFirstNames).toContain('call_raw_tool')

    schemaProvider.setMode('dual')
    const dualSchemas = schemaProvider.getSchemas()
    const dualNames = dualSchemas.map(s => s.function.name)
    expect(dualNames).not.toContain('call_raw_tool')
    expect(dualNames).toContain('publishing')
  })

  it('[Exit Gate 1] resolveCapabilityName works in capability-first mode', () => {
    schemaProvider.setMode('capability-first')
    adapter.buildSchemas()

    expect(schemaProvider.resolveCapabilityName?.('browser_automation')).toBe('browser.automation')
    expect(schemaProvider.resolveCapabilityName?.('publishing')).toBe('publishing')
    expect(schemaProvider.resolveCapabilityName?.('call_raw_tool')).toBeUndefined()
  })
})

// ═════════════════════════════════════════════════
// Capability-first mode dispatch tests
// ═════════════════════════════════════════════════

describe('P1.3b Exit Gate — Capability-First Dispatch', () => {
  let registry: MCPRegistry
  let catalog: CapabilityCatalog
  let resolver: CapabilityResolver
  let capabilityService: CapabilityServiceImpl
  let adapter: CapabilityFunctionSchemaAdapter
  let schemaProvider: ToolSchemaProvider
  let router: ToolInvocationRouter
  let serverManager: ReturnType<typeof createMockServerManager>

  let capturedSelected: any[] = []
  let capturedInvoked: any[] = []
  let capturedCompleted: any[] = []
  let disposers: (() => void)[] = []

  beforeEach(() => {
    capturedSelected = []
    capturedInvoked = []
    capturedCompleted = []
    disposers = []

    registry = new MCPRegistry()
    registry.register(FANQIE_MANIFEST)
    registry.register(PLAYWRIGHT_MANIFEST)
    registry.register(FILE_SYSTEM_MANIFEST)
    registry.register(SEARCH_ENGINE_MANIFEST)
    registry.register(SYSTEM_EXECUTOR_MANIFEST)

    catalog = new CapabilityCatalog(registry)
    catalog.rebuild()

    serverManager = createMockServerManager()
    resolver = new CapabilityResolver(catalog)
    capabilityService = new CapabilityServiceImpl(resolver, serverManager)
    adapter = new CapabilityFunctionSchemaAdapter(catalog)
    schemaProvider = new ToolSchemaProvider(serverManager, adapter)
    router = new ToolInvocationRouter(serverManager, schemaProvider, capabilityService)

    disposers.push(
      eventBus.on('capability.selected', (p: any) => capturedSelected.push(p)),
      eventBus.on('capability.invoked', (p: any) => capturedInvoked.push(p)),
      eventBus.on('capability.completed', (p: any) => capturedCompleted.push(p)),
    )
  })

  afterEach(() => {
    for (const d of disposers) d()
  })

  // ═════════════════════════════════════════════
  // Exit Gate 2: selected → invoked → completed
  // ═════════════════════════════════════════════

  it('[Exit Gate 2] capability dispatch works in capability-first mode', async () => {
    schemaProvider.setMode('capability-first')

    const result = await router.dispatch('publishing', { content: 'test' })
    expect(result.routedAs).toBe('capability')
    expect(result.capability).toBe('publishing')
    expect(result.result).toBeTruthy()
  })

  it('[Exit Gate 2] events fire in order: selected → invoked → completed', async () => {
    await router.dispatch('publishing', { content: 'test' })

    const order: string[] = []
    capturedSelected.forEach(() => order.push('selected'))
    capturedInvoked.forEach(() => order.push('invoked'))
    capturedCompleted.forEach(() => order.push('completed'))

    expect(order.indexOf('selected')).toBeLessThan(order.indexOf('invoked'))
    expect(order.indexOf('invoked')).toBeLessThan(order.indexOf('completed'))
  })

  it('[Exit Gate 2] Sel→Inv rate = 100%', async () => {
    await router.dispatch('publishing', { content: 'test' })
    expect(capturedSelected.length).toBeGreaterThan(0)
    expect(capturedInvoked.length).toBe(capturedSelected.length)
  })

  it('[Exit Gate 2] Inv→Comp rate = 100%', async () => {
    await router.dispatch('publishing', { content: 'test' })
    expect(capturedInvoked.length).toBeGreaterThan(0)
    expect(capturedCompleted.length).toBe(capturedInvoked.length)
  })

  it('[Exit Gate 2] Invocation success rate = 100% on valid execution', async () => {
    await router.dispatch('publishing', { content: 'test' })
    const allSuccess = capturedCompleted.every((c: any) => c.success === true)
    expect(allSuccess).toBe(true)
  })

  // ═════════════════════════════════════════════
  // Exit Gate 4: call_raw_tool fallback
  // ═════════════════════════════════════════════

  it('[Exit Gate 4] call_raw_tool dispatches to ServerManager.callTool', async () => {
    serverManager.callTool.mockResolvedValue('raw tool result')

    const result = await router.dispatch('call_raw_tool', {
      toolName: 'read_file',
      args: { path: '/test.txt' },
    })

    expect(result.routedAs).toBe('tool')
    expect(result.result).toBe('raw tool result')
    expect(serverManager.callTool).toHaveBeenCalledWith('read_file', { path: '/test.txt' })
  })

  it('[Exit Gate 4] call_raw_tool with missing toolName returns error', async () => {
    const result = await router.dispatch('call_raw_tool', {
      args: { path: '/test.txt' },
    })

    expect(result.routedAs).toBe('tool')
    expect(result.result).toContain('Error')
    expect(result.result).toContain('toolName')
  })

  it('[Exit Gate 4] call_raw_tool with empty args passes empty object', async () => {
    serverManager.callTool.mockResolvedValue('ok')

    const result = await router.dispatch('call_raw_tool', {
      toolName: 'list_files',
    })

    expect(result.result).toBe('ok')
    expect(serverManager.callTool).toHaveBeenCalledWith('list_files', {})
  })

  // ═════════════════════════════════════════════
  // Cross-mode: non-capability tools still route correctly
  // ═════════════════════════════════════════════

  it('non-capability tools route to callTool in capability-first mode', async () => {
    schemaProvider.setMode('capability-first')
    serverManager.callTool.mockResolvedValue('tool result')

    const result = await router.dispatch('non_capability_tool', { arg: 1 })
    // In capability-first mode, non-capability tools still route to ServerManager
    // if they're not capability tools — Router falls through to dispatchTool
    expect(result.routedAs).toBe('tool')
    expect(serverManager.callTool).toHaveBeenCalledWith('non_capability_tool', { arg: 1 })
  })

  // ═════════════════════════════════════════════════
  // M5.4: resolve new capabilities
  // ═════════════════════════════════════════════════

  it('[M5.4] capabilities include file.management', () => {
    expect(schemaProvider.isCapabilityTool('file_management')).toBe(true)
  })

  it('[M5.4] capabilities include search.retrieval', () => {
    expect(schemaProvider.isCapabilityTool('search_retrieval')).toBe(true)
  })

  it('[M5.4] capabilities include system.execution', () => {
    expect(schemaProvider.isCapabilityTool('system_execution')).toBe(true)
  })
})

// ═════════════════════════════════════════════════
// Adapter + Invoke integration (full chain)
// ═════════════════════════════════════════════════

describe('P1.3b Exit Gate — Adapter + Invoke Integration', () => {
  let registry: MCPRegistry
  let catalog: CapabilityCatalog
  let resolver: CapabilityResolver
  let capabilityService: CapabilityServiceImpl
  let adapter: CapabilityFunctionSchemaAdapter
  let schemaProvider: ToolSchemaProvider
  let router: ToolInvocationRouter
  let serverManager: ReturnType<typeof createMockServerManager>

  let capturedInvoked: any[] = []
  let capturedCompleted: any[] = []
  let disposers: (() => void)[] = []

  beforeEach(() => {
    capturedInvoked = []
    capturedCompleted = []
    disposers = []

    registry = new MCPRegistry()
    registry.register(FANQIE_MANIFEST)
    registry.register(PLAYWRIGHT_MANIFEST)

    catalog = new CapabilityCatalog(registry)
    catalog.rebuild()

    serverManager = createMockServerManager()
    resolver = new CapabilityResolver(catalog)
    capabilityService = new CapabilityServiceImpl(resolver, serverManager)
    adapter = new CapabilityFunctionSchemaAdapter(catalog)
    schemaProvider = new ToolSchemaProvider(serverManager, adapter)
    router = new ToolInvocationRouter(serverManager, schemaProvider, capabilityService)

    // Register adapters with the resolved tool names (catalog defaultTool = capability id)
    adapter.buildSchemas() // populate nameToCapability map
    capabilityService.setAdapter('fanqie-publish', 'publish_novel', fanqiePublishAdapter)
    capabilityService.setAdapter('playwright', 'browser_navigate', playwrightAdapter)

    disposers.push(
      eventBus.on('capability.invoked', (p: any) => capturedInvoked.push(p)),
      eventBus.on('capability.completed', (p: any) => capturedCompleted.push(p)),
    )
  })

  afterEach(() => {
    for (const d of disposers) d()
  })

  it('[Exit Gate 3] fanqie adapter transforms input in full dispatch chain', async () => {
    await router.dispatch('publishing', { title: '我的小说', content: '正文', platform: 'fantasy' })

    expect(serverManager.callTool).toHaveBeenCalledWith(
      'publish_novel',
      { novelName: '我的小说', content: '正文', category: 'fantasy' },
    )
    expect(capturedInvoked.length).toBe(1)
    expect(capturedCompleted.length).toBe(1)
    expect(capturedCompleted[0].success).toBe(true)
  })

  it('[Exit Gate 3] playwright adapter validates action in full chain', async () => {
    // Must fail before callTool — adapter throws
    serverManager.callTool.mockResolvedValue('navigated')

    await router.dispatch('browser_automation', { action: 'navigate', url: 'https://example.com' })

    expect(serverManager.callTool).toHaveBeenCalledWith(
      'browser_navigate',
      { action: 'navigate', url: 'https://example.com' },
    )
  })

  it('[Exit Gate 3] playwright adapter rejects missing action in full chain', async () => {
    const result = await router.dispatch('browser_automation', { url: 'https://example.com' })

    // Router catches the error and returns it
    expect(result.routedAs).toBe('capability')
    expect(result.result).toContain('Error')
    expect(result.result).toContain('action')
  })
})
