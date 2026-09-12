import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { describe, expect, it } from 'vitest'

import { RepeatabilitySummaryWriter } from '@akemi-mio/core/core/evaluation/RepeatabilitySummaryWriter'

describe('RepeatabilitySummaryWriter', () => {
  it('writes repeatability-summary.json', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'repeatability-summary-'))
    const writer = new RepeatabilitySummaryWriter(directory)
    const summary = {
      schemaVersion: 1 as const,
      generatedAt: '2026-08-05T00:00:00.000Z',
      target: {
        caseFamily: 'browser.automation',
        capability: 'browser.automation',
        operation: 'navigate',
        issueType: 'timeout',
        windowId: 'window-2',
      },
      verdict: 'repeatable_positive' as const,
      comparison: {
        independentWindowCount: 1,
        matchedWindowIds: ['window-1'],
      },
      traceRefs: ['trace-a'],
    }

    try {
      const output = await writer.write(summary)

      expect(output).toBe(join(directory, 'repeatability-summary.json'))
      expect(existsSync(output)).toBe(true)
      expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(summary)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
