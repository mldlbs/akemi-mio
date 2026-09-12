import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { collectObservationSamples, runObservationCommand } from '@akemi-mio/intelligence/mcp/MemoryObservationCollector'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'm55-collector-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('MemoryObservationCollector', () => {
  it('writes a timestamped report, latest.txt, and index.json for each collected sample', async () => {
    const outDir = makeTempDir()
    const runObservationImpl = vi.fn().mockResolvedValue('M5.5 Observation Gate\nIdentity Coverage: 41.7%\n')
    const now = vi.fn().mockReturnValue(new Date('2026-07-28T15:00:00.000Z'))

    const result = await collectObservationSamples({
      outDir,
      days: 1,
      limit: 500,
      samples: 1,
      intervalMinutes: 60,
      runObservationImpl,
      now,
    })

    expect(runObservationImpl).toHaveBeenCalledWith({ days: 1, limit: 500 })
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.fileName).toBe('2026-07-28T15-00-00.000Z.txt')
    expect(existsSync(join(outDir, '2026-07-28T15-00-00.000Z.txt'))).toBe(true)
    expect(readFileSync(join(outDir, 'latest.txt'), 'utf8')).toBe('M5.5 Observation Gate\nIdentity Coverage: 41.7%\n')

    const index = JSON.parse(readFileSync(join(outDir, 'index.json'), 'utf8')) as {
      samples: Array<{ capturedAt: string; fileName: string; relativePath: string }>
    }
    expect(index.samples).toEqual([
      {
        capturedAt: '2026-07-28T15:00:00.000Z',
        fileName: '2026-07-28T15-00-00.000Z.txt',
        relativePath: '2026-07-28T15-00-00.000Z.txt',
      },
    ])
  })

  it('collects multiple samples and waits between iterations', async () => {
    const outDir = makeTempDir()
    const runObservationImpl = vi.fn().mockResolvedValueOnce('sample-1').mockResolvedValueOnce('sample-2')
    const now = vi.fn().mockReturnValueOnce(new Date('2026-07-28T15:00:00.000Z')).mockReturnValueOnce(new Date('2026-07-28T21:00:00.000Z'))
    const sleepImpl = vi.fn().mockResolvedValue(undefined)

    const result = await collectObservationSamples({
      outDir,
      days: 7,
      limit: 250,
      samples: 2,
      intervalMinutes: 360,
      runObservationImpl,
      sleepImpl,
      now,
    })

    expect(runObservationImpl).toHaveBeenCalledTimes(2)
    expect(sleepImpl).toHaveBeenCalledTimes(1)
    expect(sleepImpl).toHaveBeenCalledWith(360 * 60 * 1000)
    expect(result.entries.map((entry) => entry.fileName)).toEqual(['2026-07-28T15-00-00.000Z.txt', '2026-07-28T21-00-00.000Z.txt'])

    const index = JSON.parse(readFileSync(join(outDir, 'index.json'), 'utf8')) as {
      samples: Array<{ fileName: string }>
    }
    expect(index.samples.map((entry) => entry.fileName)).toEqual(['2026-07-28T15-00-00.000Z.txt', '2026-07-28T21-00-00.000Z.txt'])
    expect(readFileSync(join(outDir, 'latest.txt'), 'utf8')).toBe('sample-2')
  })

  it('executes the observation script through Node + tsx cli so Windows collection does not rely on tsx.cmd', async () => {
    const execFileSyncImpl = vi.fn().mockReturnValue('ok')

    await runObservationCommand({ days: 1, limit: 100 }, 'D:/work/code/akemi-mio', execFileSyncImpl)

    expect(execFileSyncImpl).toHaveBeenCalledOnce()
    expect(execFileSyncImpl.mock.calls[0]?.[0]).toBe(process.execPath)
    expect(execFileSyncImpl.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([expect.stringContaining('node_modules'), expect.stringContaining('tsx'), '--days=1', '--limit=100']),
    )
    expect(String(execFileSyncImpl.mock.calls[0]?.[1]?.[0])).toContain('cli.mjs')
    expect(String(execFileSyncImpl.mock.calls[0]?.[1]?.[1])).toContain('m55-observe.ts')
  })
})
