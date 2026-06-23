import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ServerManager } from '../mcp/ServerManager'
import { LocalProvider } from '../mcp/LocalProvider'
import { toolRegistry } from '../plugin/registry'
import managementPlugin from '../plugin/builtin/management.plugin'

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd() + '/test-user-data',
  },
}))

describe('LocalProvider', () => {
  let provider: LocalProvider

  beforeEach(() => {
    provider = new LocalProvider()
  })

  it('provides core tools', () => {
    const defs = provider.getToolDefinitions()
    const names = defs.map((d) => d.name).sort()
    const expected = [
      'abandon_plan',
      'analyze_codebase',
      'analyze_task',
      'complete_plan',
      'create_dev_plan',
      'disable_skill',
      'edit_file',
      'enable_skill',
      'generate_card',
      'generate_image',
      'get_credential',
      'grep',
      'list_credentials',
      'list_files',
      'list_plans',
      'list_procedures',
      'list_skills',
      'list_workflows',
      'read_file',
      'remember_fact',
      'remember_procedure',
      'run_command',
      'set_credential',
      'update_plan_progress',
      'write_file',
      'writing_system',
    ]
    expect(names).toEqual(expected)
  })

  it('each tool has name, description, parameters', () => {
    for (const def of provider.getToolDefinitions()) {
      expect(def.name).toBeTruthy()
      expect(def.description).toBeTruthy()
      expect(def.parameters).toBeDefined()
    }
  })

  it('read_file rejects paths outside project root', async () => {
    const result = await provider.callTool('read_file', { path: '../outside' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('超出')
  })

  it('list_files returns directory contents', async () => {
    const result = await provider.callTool('list_files', { path: '.' })
    expect(result.isError).toBe(false)
  })

  it('run_command rejects disallowed prefixes', async () => {
    const result = await provider.callTool('run_command', { command: 'sudo rm -rf /' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('不允许执行命令')
  })

  it('run_command allows npm', async () => {
    const result = await provider.callTool('run_command', { command: 'npm --version' })
    expect(result.isError).toBe(false)
    expect(result.content[0].text).toBeTruthy()
  })
})

describe('ToolRegistry', () => {
  beforeEach(() => {
    for (const name of toolRegistry.listTools()) {
      toolRegistry.unregister(name)
    }
  })

  it('registers and executes tools', async () => {
    toolRegistry.register({
      name: 'test_tool',
      description: 'A test tool',
      parameters: {},
      required: [],
      handler: () => 'hello',
      pluginName: 'test',
    })
    expect(toolRegistry.has('test_tool')).toBe(true)
    expect(await toolRegistry.execute('test_tool', {})).toBe('hello')
  })

  it('getAllSchemas returns correct format', () => {
    toolRegistry.register({
      name: 'schema_test',
      description: 'Test',
      parameters: { x: { type: 'string', description: 'X' } },
      required: ['x'],
      handler: () => 'ok',
      pluginName: 'test',
    })
    const schemas = toolRegistry.getAllSchemas()
    expect(schemas[0]).toHaveProperty('type', 'function')
    expect(schemas[0].function.name).toBe('schema_test')
    expect(schemas[0].function.parameters.required).toContain('x')
  })

  it('rejects duplicate registration', () => {
    toolRegistry.register({ name: 'dup', description: 'First', parameters: {}, required: [], handler: () => 'a', pluginName: 'p1' })
    expect(() =>
      toolRegistry.register({ name: 'dup', description: 'Second', parameters: {}, required: [], handler: () => 'b', pluginName: 'p2' }),
    ).toThrow('already registered')
  })

  it('unregisters all tools for a plugin', () => {
    toolRegistry.register({ name: 't1', description: '', parameters: {}, required: [], handler: () => '', pluginName: 'p1' })
    toolRegistry.register({ name: 't2', description: '', parameters: {}, required: [], handler: () => '', pluginName: 'p1' })
    toolRegistry.unregisterAll('p1')
    expect(toolRegistry.has('t1')).toBe(false)
    expect(toolRegistry.has('t2')).toBe(false)
  })
})

describe('Management plugin', () => {
  it('has create_plugin and list_plugins tools', () => {
    const names = managementPlugin.tools.map((t) => t.name).sort()
    expect(names).toEqual(['create_plugin', 'list_plugins'])
  })

  it('create_plugin rejects invalid names', () => {
    expect(() => (managementPlugin.handle as any)('create_plugin', { name: '', content: 'x' })).toThrow('无效')
  })

  it('create_plugin validates content has manifest', () => {
    expect(() => (managementPlugin.handle as any)('create_plugin', { name: 'test', content: 'console.log(1)' })).toThrow('manifest')
  })

  it('list_plugins returns string output', async () => {
    const result = await (managementPlugin.handle as any)('list_plugins', {})
    expect(typeof result).toBe('string')
  })
})

describe('ServerManager', () => {
  let manager: ServerManager

  beforeEach(() => {
    manager = new ServerManager()
  })

  it('starts with local provider tools', () => {
    expect(manager.hasTool('read_file')).toBe(true)
    expect(manager.hasTool('run_command')).toBe(true)
    expect(manager.listTools().length).toBeGreaterThanOrEqual(15)
    expect(manager.hasTool('list_mcp_servers')).toBe(true)
    expect(manager.hasTool('remove_mcp_server')).toBe(true)
  })

  it('getAllSchemas returns correct format', () => {
    const schemas = manager.getAllSchemas()
    expect(schemas.length).toBeGreaterThanOrEqual(15)
    expect(schemas[0]).toHaveProperty('type', 'function')
    expect(schemas[0].function).toHaveProperty('name')
    expect(schemas[0].function).toHaveProperty('parameters')
  })

  it('callTool executes local tools', async () => {
    const result = await manager.callTool('list_files', { path: '.' })
    expect(typeof result).toBe('string')
  })

  it('callTool throws for unknown tools', async () => {
    await expect(manager.callTool('nonexistent', {})).rejects.toThrow('未知工具')
  })

  it('listServers returns local provider', () => {
    const servers = manager.listServers()
    expect(servers.length).toBeGreaterThanOrEqual(1)
    expect(servers[0].name).toBe('@builtin/core')
    expect(servers[0].initialized).toBe(true)
  })
})
