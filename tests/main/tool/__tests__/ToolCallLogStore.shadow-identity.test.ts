import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { ToolCallLogStore } from '@akemi-mio/capabilities/tool/ToolCallLogStore'

const logFile = '.claude/tool-call-log-shadow-identity.test.json'
const absoluteLogFile = `${process.cwd()}\\${logFile}`

describe('ToolCallLogStore shadow identity', () => {
  afterEach(() => {
    if (existsSync(absoluteLogFile)) {
      rmSync(absoluteLogFile, { force: true })
    }
  })

  it('stores optional shadow identity fields on new records', () => {
    const store = new ToolCallLogStore({ LOG_FILE: logFile, MAX_ENTRIES: 10 })

    const record = store.record('write_file', { path: 'note.txt' }, 'ok', null, 12, true, {
      capability: 'file.management',
      operation: 'write',
      provider: '@builtin/core',
    })

    expect(record.capability).toBe('file.management')
    expect(record.operation).toBe('write')
    expect(record.provider).toBe('@builtin/core')
  })

  it('loads legacy records that do not include shadow identity fields', () => {
    if (!existsSync(`${process.cwd()}\\.claude`)) {
      mkdirSync(`${process.cwd()}\\.claude`, { recursive: true })
    }
    writeFileSync(
      absoluteLogFile,
      JSON.stringify([
        {
          id: 'legacy_1',
          toolName: 'list_files',
          args: { path: '.' },
          result: 'ok',
          error: null,
          durationMs: 1,
          timestamp: Date.now(),
          success: true,
          errorType: null,
        },
      ]),
      'utf-8',
    )

    const store = new ToolCallLogStore({ LOG_FILE: logFile, MAX_ENTRIES: 10 })
    const [record] = store.query({ toolName: 'list_files' })

    expect(record.capability).toBeUndefined()
    expect(record.operation).toBeUndefined()
    expect(record.provider).toBeUndefined()
  })
})
