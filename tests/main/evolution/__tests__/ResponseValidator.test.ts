import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ResponseValidator, formatValidationSummary } from '@akemi-mio/evolution/ResponseValidator'
import { eventBus } from '@akemi-mio/core/core/EventBus'

vi.mock('@akemi-mio/core/logger/Logger', () => ({ log: vi.fn() }))

function resetEvents() {
  eventBus.removeAll()
}

describe('ResponseValidator', () => {
  let validator: ResponseValidator

  beforeEach(() => {
    resetEvents()
    validator = new ResponseValidator()
  })

  afterEach(() => {
    validator.cleanup()
  })

  it('startListening 清空缓冲区', () => {
    validator.startListening()
    expect(validator.getSnapshot()).toEqual([])
  })

  it('stopAndValidate analyze 模式检测 write_file', () => {
    validator.startListening()
    eventBus.emit('agent.tool.invoked' as any, { tool: 'read_file', args: { path: 'x' } })
    eventBus.emit('agent.tool.invoked' as any, { tool: 'write_file', args: { path: 'y' } })
    const result = validator.stopAndValidate('analyze')
    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.toolName === 'write_file')).toBe(true)
    expect(result.stats.total).toBe(2)
  })

  it('analyze 模式 edit_file 算违规', () => {
    validator.startListening()
    eventBus.emit('agent.tool.invoked' as any, { tool: 'edit_file', args: {} })
    const result = validator.stopAndValidate('analyze')
    expect(result.passed).toBe(false)
  })

  it('analyze 模式 create_plugin 算违规', () => {
    validator.startListening()
    eventBus.emit('agent.tool.invoked' as any, { tool: 'create_plugin', args: {} })
    const result = validator.stopAndValidate('analyze')
    expect(result.passed).toBe(false)
  })

  it('execute 模式 create_dev_plan 算违规', () => {
    validator.startListening()
    eventBus.emit('agent.tool.invoked' as any, { tool: 'create_dev_plan', args: {} })
    const result = validator.stopAndValidate('execute')
    expect(result.passed).toBe(false)
  })

  it('execute 模式 write_file 不算违规', () => {
    validator.startListening()
    eventBus.emit('agent.tool.invoked' as any, { tool: 'write_file', args: { path: 'x' } })
    const result = validator.stopAndValidate('execute')
    expect(result.passed).toBe(true)
  })

  it('review 模式 write_file 算违规', () => {
    validator.startListening()
    eventBus.emit('agent.tool.invoked' as any, { tool: 'write_file', args: {} })
    const result = validator.stopAndValidate('review')
    expect(result.passed).toBe(false)
  })

  it('错误过多触发警告', () => {
    validator.startListening()
    for (let i = 0; i < 5; i++) {
      eventBus.emit('agent.tool.invoked' as any, { tool: 'read_file', args: {} })
      eventBus.emit('agent.tool.failed' as any, { tool: 'read_file', error: 'err' })
    }
    const result = validator.stopAndValidate('analyze')
    expect(result.violations.some((v) => v.type === 'excessive_errors')).toBe(true)
  })

  it('无工具调用触发警告', () => {
    validator.startListening()
    const result = validator.stopAndValidate('analyze')
    expect(result.warnings.length).toBeGreaterThanOrEqual(1)
    expect(result.warnings[0]).toContain('没有任何工具调用')
  })

  it('setRollbackState 影响快照警告', () => {
    validator.setRollbackState(true)
    validator.startListening()
    eventBus.emit('agent.tool.invoked' as any, { tool: 'read_file', args: {} })
    const result = validator.stopAndValidate('analyze')
    expect(result.warnings.some((w) => w.includes('快照'))).toBe(true)
  })

  it('reset 清空缓冲区', () => {
    validator.startListening()
    eventBus.emit('agent.tool.invoked' as any, { tool: 'read_file', args: {} })
    validator.reset()
    expect(validator.getSnapshot()).toEqual([])
  })

  it('stopAndValidate 后事件监听器被清理', () => {
    validator.startListening()
    validator.stopAndValidate('analyze')
    eventBus.emit('agent.tool.invoked' as any, { tool: 'write_file', args: {} })
    validator.startListening()
    const result = validator.stopAndValidate('analyze')
    expect(result.stats.total).toBe(0)
  })

  it('formatValidationSummary 包含统计信息', () => {
    validator.startListening()
    eventBus.emit('agent.tool.invoked' as any, { tool: 'read_file', args: {} })
    const result = validator.stopAndValidate('analyze')
    const summary = formatValidationSummary(result)
    expect(summary).toContain('工具调用统计')
    expect(summary).toContain('1次')
  })
})
