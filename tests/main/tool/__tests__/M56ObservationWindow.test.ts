import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'

import type { ToolCallRecord } from '@akemi-mio/capabilities/tool/ToolCallLogStore'
import { buildObservationSnapshot, persistObservationSnapshot } from '../../../../scripts/m56-observation-window'

function makeRecord(overrides: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: 'rec-1',
    toolName: 'read_file',
    args: {},
    result: 'ok',
    error: null,
    durationMs: 10,
    timestamp: 1,
    success: true,
    errorType: null,
    capability: undefined,
    operation: undefined,
    provider: undefined,
    ...overrides,
  }
}

const tempDirs: string[] = []

afterEach(() => {
  tempDirs.length = 0
})

describe('buildObservationSnapshot', () => {
  it('builds a post-contract snapshot with coverage and capability distribution', () => {
    const snapshot = buildObservationSnapshot(
      [
        makeRecord({ id: 'old', toolName: 'read_file', capability: 'file.management', timestamp: 100 }),
        makeRecord({ id: 'tagged', toolName: 'run_command', capability: 'system.execution', timestamp: 200 }),
        makeRecord({ id: 'gap', toolName: 'browser_navigate', timestamp: 210 }),
        makeRecord({ id: 'catalog', toolName: 'grep_search', timestamp: 220 }),
      ],
      {
        read_file: ['file.management'],
        run_command: ['system.execution'],
        browser_navigate: ['browser.automation', 'web.scraping'],
      },
      {
        now: new Date('2026-07-29T18:00:00+08:00'),
        sinceMs: 150,
      },
    )

    expect(snapshot).toEqual({
      timestamp: '2026-07-29T10:00:00.000Z',
      since: '1970-01-01T00:00:00.150Z',
      events: 3,
      taggedEvents: 1,
      coverage: 1 / 3,
      capabilities: {
        'system.execution': 1,
      },
      enrichmentGap: 1,
      catalogGap: 1,
      sourceMismatch: 0,
    })
  })
})

describe('persistObservationSnapshot', () => {
  it('writes latest, timestamped snapshot, and history jsonl', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'm56-observation-window-'))
    tempDirs.push(outDir)

    const snapshot = {
      timestamp: '2026-07-29T10:00:00.000Z',
      since: '2026-07-29T07:40:00.000Z',
      events: 3,
      taggedEvents: 3,
      coverage: 1,
      capabilities: {
        'file.management': 2,
        'system.execution': 1,
      },
      enrichmentGap: 0,
      catalogGap: 0,
      sourceMismatch: 0,
    }

    const result = persistObservationSnapshot(outDir, snapshot)

    expect(JSON.parse(readFileSync(result.latestPath, 'utf8'))).toEqual(snapshot)
    expect(readFileSync(result.historyPath, 'utf8').trim()).toBe(JSON.stringify(snapshot))
    expect(existsSync(result.snapshotPath)).toBe(true)
    expect(result.snapshotPath).toContain('2026-07-29T10-00-00.000Z.json')
  })
})
