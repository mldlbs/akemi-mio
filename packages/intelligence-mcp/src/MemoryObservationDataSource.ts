import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'

import initSqlJs from 'sql.js'

import type { ObservedMemoryEntry } from './MemoryObservationAnalyzer'

export type ObservationMemorySource = 'electron-sqlite' | 'sqljs-snapshot'

type SqlSnapshotLoader = (input: { dbPath: string; cutoffMs: number; limit: number }) => Promise<ObservedMemoryEntry[]>

export interface LoadObservedMemoriesOptions {
  dbPath: string
  cutoffMs: number
  limit: number
  electronPath?: string | null
  projectRoot?: string
  execFileSyncImpl?: typeof execFileSync
  loadSqlJsSnapshot?: SqlSnapshotLoader
}

const CALL_MEMORY_SQL = `
  SELECT content, updated_at, structured_data
  FROM memories
  WHERE type = 'user_fact'
    AND updated_at >= ?
    AND (content LIKE '[工具调用]%' OR content LIKE '[能力调用]%')
  ORDER BY updated_at DESC
  LIMIT ?
`

export async function loadObservedMemories(
  options: LoadObservedMemoriesOptions,
): Promise<{ entries: ObservedMemoryEntry[]; source: ObservationMemorySource }> {
  const electronPath = options.electronPath ?? findElectronBinary(options.projectRoot ?? process.cwd())

  if (electronPath) {
    try {
      return {
        entries: loadObservedMemoriesViaElectron({
          ...options,
          electronPath,
        }),
        source: 'electron-sqlite',
      }
    } catch {
      // Fall through to sql.js snapshot mode.
    }
  }

  const loadSqlJsSnapshot = options.loadSqlJsSnapshot ?? loadObservedMemoriesViaSqlJs
  return {
    entries: await loadSqlJsSnapshot(options),
    source: 'sqljs-snapshot',
  }
}

export function loadObservedMemoriesViaElectron(
  options: LoadObservedMemoriesOptions & {
    electronPath: string
    projectRoot?: string
    execFileSyncImpl?: typeof execFileSync
  },
): ObservedMemoryEntry[] {
  const execImpl = options.execFileSyncImpl ?? execFileSync
  const projectRoot = options.projectRoot ?? process.cwd()
  const betterSqlitePath = resolve(projectRoot, 'node_modules', 'better-sqlite3')
  const js = [
    `const Database = require(${JSON.stringify(betterSqlitePath)});`,
    'const [dbPath, cutoffMs, limit] = process.argv.slice(1);',
    `const sql = ${JSON.stringify(CALL_MEMORY_SQL)};`,
    'const db = new Database(dbPath, { readonly: true, fileMustExist: true });',
    'const rows = db.prepare(sql).all(Number(cutoffMs), Number(limit));',
    'process.stdout.write(JSON.stringify(rows));',
    'db.close();',
  ].join('\n')

  const raw = execImpl(options.electronPath, ['-e', js, options.dbPath, String(options.cutoffMs), String(options.limit)], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
    },
  })

  const rows = JSON.parse(raw) as Array<{
    content?: string
    updated_at?: number
    structured_data?: string | null
  }>

  return rows.map((row) => ({
    content: String(row.content ?? ''),
    updatedAt: Number(row.updated_at ?? 0),
    structuredData: row.structured_data == null ? null : String(row.structured_data),
  }))
}

export async function loadObservedMemoriesViaSqlJs(input: {
  dbPath: string
  cutoffMs: number
  limit: number
}): Promise<ObservedMemoryEntry[]> {
  const SQL = await initSqlJs()
  const db = new SQL.Database(readFileSync(input.dbPath))
  const stmt = db.prepare(CALL_MEMORY_SQL)

  stmt.bind([input.cutoffMs, input.limit])
  const rows: ObservedMemoryEntry[] = []
  while (stmt.step()) {
    const row = stmt.getAsObject()
    rows.push({
      content: String(row.content ?? ''),
      updatedAt: Number(row.updated_at ?? 0),
      structuredData: row.structured_data == null ? null : String(row.structured_data),
    })
  }
  stmt.free()
  db.close()

  return rows
}

export function findElectronBinary(projectRoot: string): string | null {
  const candidates =
    process.platform === 'win32'
      ? [join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')]
      : process.platform === 'darwin'
        ? [join(projectRoot, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')]
        : [join(projectRoot, 'node_modules', 'electron', 'dist', 'electron')]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}
