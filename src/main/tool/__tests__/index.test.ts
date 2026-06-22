import { describe, it, expect } from 'vitest'
import { getAllTools } from '../index'
import { buildTool } from '../types'

const READONLY_TOOLS = new Set([
  'read_file',
  'grep',
  'list_files',
  'list_plans',
  'get_credential',
  'list_credentials',
  'list_skills',
  'list_procedures',
  'list_workflows',
  'analyze_codebase',
  'analyze_task',
])

describe('getAllTools', () => {
  const tools = getAllTools()

  it('返回 25 个工具', () => {
    expect(tools).toHaveLength(25)
  })

  it('每个工具有 name/description/inputJSONSchema/handler', () => {
    for (const t of tools) {
      expect(t.name).toBeTruthy()
      expect(typeof t.description).toBe('string')
      expect(t.inputJSONSchema.type).toBe('object')
      expect(t.inputJSONSchema.properties).toBeDefined()
      expect(typeof t.handler).toBe('function')
    }
  })

  it('没有重复名字', () => {
    const names = tools.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('isReadOnly 分类正确', () => {
    for (const t of tools) {
      expect(t.isReadOnly).toBe(READONLY_TOOLS.has(t.name))
    }
  })

  it('serverName 默认 @builtin/core', () => {
    for (const t of tools) {
      expect(t.serverName).toBe('@builtin/core')
    }
  })

  it('isEnabled 默认为 true', () => {
    for (const t of tools) {
      expect(t.isEnabled).toBe(true)
    }
  })
})

describe('buildTool', () => {
  it('填充默认值', () => {
    const t = buildTool({
      name: 'test_tool',
      description: '测试工具',
      inputJSONSchema: { type: 'object', properties: { a: { type: 'string', description: '' } }, required: ['a'] },
      handler: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
    })
    expect(t.serverName).toBe('@builtin/core')
    expect(t.isReadOnly).toBe(false)
    expect(t.isEnabled).toBe(true)
  })

  it('覆盖默认值', () => {
    const t = buildTool({
      name: 'custom',
      description: 'custom',
      inputJSONSchema: { type: 'object', properties: {}, required: [] },
      handler: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
      serverName: 'custom',
      isReadOnly: true,
      isEnabled: false,
    })
    expect(t.serverName).toBe('custom')
    expect(t.isReadOnly).toBe(true)
    expect(t.isEnabled).toBe(false)
  })
})
