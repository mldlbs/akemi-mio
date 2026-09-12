import { describe, expect, it, vi } from 'vitest'

import { loadObservedMemories, loadObservedMemoriesViaElectron } from '@akemi-mio/intelligence/mcp/MemoryObservationDataSource'

describe('MemoryObservationDataSource', () => {
  it('uses an Electron-backed SQLite query so observation can see WAL-backed memory writes', () => {
    const execFileSync = vi.fn().mockReturnValue(
      JSON.stringify([
        {
          content: '[能力调用] capability:file.management operation:write tool:write_file (path=docs/spec.md) → 成功: wrote docs/spec.md',
          updated_at: 123,
          structured_data: '{"identity":{"capability":"file.management","operation":"write","tool":"write_file"}}',
        },
      ]),
    )

    const entries = loadObservedMemoriesViaElectron({
      dbPath: 'C:/Users/test/AppData/Roaming/akemi-mio/databases/main.db',
      cutoffMs: 100,
      limit: 50,
      electronPath: 'D:/work/code/akemi-mio/node_modules/electron/dist/electron.exe',
      projectRoot: 'D:/work/code/akemi-mio',
      execFileSyncImpl: execFileSync,
    })

    expect(execFileSync).toHaveBeenCalledOnce()
    expect(execFileSync.mock.calls[0]?.[0]).toBe('D:/work/code/akemi-mio/node_modules/electron/dist/electron.exe')
    expect(execFileSync.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        '-e',
        expect.stringContaining('better-sqlite3'),
        'C:/Users/test/AppData/Roaming/akemi-mio/databases/main.db',
      ]),
    )
    expect(entries).toEqual([
      {
        content: '[能力调用] capability:file.management operation:write tool:write_file (path=docs/spec.md) → 成功: wrote docs/spec.md',
        updatedAt: 123,
        structuredData: '{"identity":{"capability":"file.management","operation":"write","tool":"write_file"}}',
      },
    ])
  })

  it('falls back to sql.js only when the Electron-backed query path is unavailable', async () => {
    const loadSqlJsSnapshot = vi.fn().mockResolvedValue([
      {
        content: '[工具调用] write_file(path=legacy.txt) → 成功: wrote legacy.txt',
        updatedAt: 88,
        structuredData: null,
      },
    ])

    const result = await loadObservedMemories({
      dbPath: 'C:/Users/test/AppData/Roaming/akemi-mio/databases/main.db',
      cutoffMs: 10,
      limit: 25,
      electronPath: null,
      loadSqlJsSnapshot,
    })

    expect(loadSqlJsSnapshot).toHaveBeenCalledOnce()
    expect(result.source).toBe('sqljs-snapshot')
    expect(result.entries).toHaveLength(1)
  })
})
