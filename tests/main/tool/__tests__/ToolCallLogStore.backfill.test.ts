import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { ToolCallLogStore } from '@akemi-mio/capabilities/tool/ToolCallLogStore'
import { buildToolCallIdentityBackfillResolver } from '@akemi-mio/capabilities/tool/ToolCallIdentityGapAnalyzer'
import type { ToolCallRecord } from '@akemi-mio/capabilities/tool/ToolCallLogStore'

const logFile = '.claude/tool-call-log-backfill.test.json'
const absoluteLogFile = process.cwd().replace(/\\/g, '/') + '/' + logFile

function legacyRecord(overrides: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: overrides.id ?? 'legacy_1',
    toolName: overrides.toolName ?? 'run_command',
    args: overrides.args ?? { command: 'ls' },
    result: 'ok',
    error: null,
    durationMs: 1,
    timestamp: Date.now(),
    success: true,
    errorType: null,
    ...overrides,
  }
}

describe('ToolCallLogStore capability backfill', () => {
  afterEach(() => {
    if (existsSync(absoluteLogFile)) {
      rmSync(absoluteLogFile, { force: true })
    }
  })

  it('backfills capability identity on untagged records and keeps tagged records', () => {
    if (!existsSync(process.cwd() + '/.claude')) {
      mkdirSync(process.cwd() + '/.claude', { recursive: true })
    }
    writeFileSync(
      absoluteLogFile,
      JSON.stringify([
        legacyRecord({ id: 'untagged-1', toolName: 'run_command', args: { command: 'pwd' } }),
        legacyRecord({ id: 'untagged-2', toolName: 'grep', args: { pattern: 'todo' } }),
        legacyRecord({
          id: 'tagged-1',
          toolName: 'run_command',
          args: { command: 'ls' },
          capability: 'system.execution',
          operation: 'run',
          provider: '@builtin/core',
        }),
        legacyRecord({ id: 'unmapped-1', toolName: 'unknown_tool', args: {} }),
      ]),
      'utf-8',
    )

    const store = new ToolCallLogStore({ LOG_FILE: logFile, MAX_ENTRIES: 20 })
    const result = store.backfillCapabilityIdentity((record) => {
      const byTool: Record<string, { capability: string; operation?: string }> = {
        run_command: { capability: 'system.execution', operation: 'run' },
        grep: { capability: 'search.retrieval', operation: 'query' },
      }
      const mapped = byTool[record.toolName]
      return mapped ? { capability: mapped.capability, operation: mapped.operation } : undefined
    })

    expect(result.scanned).toBe(4)
    expect(result.updated).toBe(2)
    expect(result.skipped).toBe(1)

    const records = store.query({ limit: 20 })
    const byId = new Map(records.map((r) => [r.id, r]))
    expect(byId.get('untagged-1')?.capability).toBe('system.execution')
    expect(byId.get('untagged-1')?.operation).toBe('run')
    expect(byId.get('untagged-2')?.capability).toBe('search.retrieval')
    expect(byId.get('tagged-1')?.capability).toBe('system.execution')
    expect(byId.get('tagged-1')?.operation).toBe('run')
    expect(byId.get('unmapped-1')?.capability).toBeUndefined()

    // Persisted to disk
    const reloaded = JSON.parse(readFileSync(absoluteLogFile, 'utf-8'))
    expect(reloaded.find((r: ToolCallRecord) => r.id === 'untagged-1').capability).toBe('system.execution')
  })

  it('backfill is idempotent', () => {
    if (!existsSync(process.cwd() + '/.claude')) {
      mkdirSync(process.cwd() + '/.claude', { recursive: true })
    }
    writeFileSync(absoluteLogFile, JSON.stringify([legacyRecord({ id: 'only-1', toolName: 'grep', args: {} })]), 'utf-8')

    const store = new ToolCallLogStore({ LOG_FILE: logFile, MAX_ENTRIES: 10 })
    const resolve = buildToolCallIdentityBackfillResolver({ grep: ['search.retrieval'] })

    const first = store.backfillCapabilityIdentity(resolve)
    const second = store.backfillCapabilityIdentity(resolve)

    expect(first.updated).toBe(1)
    expect(second.updated).toBe(0)
    expect(second.skipped).toBe(0)
    const [record] = store.query({ limit: 10 })
    expect(record.capability).toBe('search.retrieval')
  })
})

describe('buildToolCallIdentityBackfillResolver', () => {
  it('maps tool to first source capability and infers operation', () => {
    const resolve = buildToolCallIdentityBackfillResolver({
      grep_search: ['search.retrieval'],
      run_command: ['system.execution'],
      write_file: ['file.management'],
    })

    expect(resolve(legacyRecord({ toolName: 'grep_search', args: { pattern: 'x' } }))).toEqual({
      capability: 'search.retrieval',
      operation: 'query',
    })
    expect(resolve(legacyRecord({ toolName: 'run_command', args: { command: 'ls' } }))).toEqual({
      capability: 'system.execution',
      operation: 'run',
    })
    expect(resolve(legacyRecord({ toolName: 'write_file', args: { path: 'a.txt' } }))).toEqual({
      capability: 'file.management',
      operation: 'write',
    })
  })

  it('returns undefined for unmapped tools', () => {
    const resolve = buildToolCallIdentityBackfillResolver({ grep: ['search.retrieval'] })
    expect(resolve(legacyRecord({ toolName: 'unknown_tool' }))).toBeUndefined()
  })
})
