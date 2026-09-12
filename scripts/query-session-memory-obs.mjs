#!/usr/bin/env node
/**
 * Session Memory Observation Query — ADR-013 Phase 1 Runtime Evidence Collection
 *
 * Usage:
 *   node scripts/query-session-memory-obs.mjs
 *
 * Reads main.db via sql.js (WASM, no native module dependency).
 * Reports compaction state.
 *
 * events.db 使用 WAL 模式，sql.js 无法直接读 WAL。
 * 如需查询 events.db:
 *   1. 关闭 app（Electron 释放锁）
 *   2. 或先 PRAGMA wal_checkpoint(FULL)
 *   3. 再用 sql.js 读
 *
 * 本脚本保持只读，不 checkpoint，只查 main.db。
 */
import initSqlJs from 'sql.js'

import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const DB_DIR = join(homedir(), 'AppData', 'Roaming', 'akemi-mio', 'databases')

async function main() {
  const SQL = await initSqlJs()
  const mainBuf = readFileSync(join(DB_DIR, 'main.db'))
  const main = new SQL.Database(mainBuf)

  console.log('═══════════════════════════════════════════════')
  console.log('Session Memory Observation — Runtime Evidence')
  console.log(`Time: ${new Date().toISOString()}`)
  console.log('═══════════════════════════════════════════════')
  console.log('')

  // ── V2: Storage ──
  console.log('▶ V2 — Storage')

  // Migration status
  const migrations = main.exec('SELECT version FROM _migrations ORDER BY version')
  const mVersions = migrations.length ? migrations[0].values.map(r => r[0]) : []
  console.log(`  Migrations applied: ${mVersions.length} total`)
  console.log(`  Migration v41: ${mVersions.includes(41) ? '✅' : '❌'}`)

  // Table exists
  const hasTable = main.exec(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='session_compactions'`
  )
  console.log(`  session_compactions table: ${hasTable.length && hasTable[0].values.length > 0 ? '✅' : '❌'}`)

  // Row count
  if (hasTable.length && hasTable[0].values.length > 0) {
    const cnt = main.exec('SELECT COUNT(*) FROM session_compactions')
    const count = cnt[0].values[0][0]
    console.log(`  Compaction rows: ${count}  ${count >= 1 ? '✅' : '(awaiting interaction)'}`)

    if (count > 0) {
      // All compactions summary
      const summary = main.exec(
        `SELECT session_id, message_count, importance_score, topics, source,
                session_start_at, session_end_at, created_at, trigger_reason
         FROM session_compactions ORDER BY created_at DESC`
      )
      if (summary.length && summary[0].values.length > 0) {
        console.log('')
        console.log('  All compactions:')
        console.log(`  ${'session'.padEnd(30)} msgs  imp   topics              source    reason             duration`)
        console.log(`  ${''.padEnd(30, '─')} ───── ───── ─────────────────── ──────── ─────────────────── ──────────`)
        for (const row of summary[0].values) {
          const [sid, msgCnt, imp, topicsJson, source, startAt, endAt, , triggerReason] = row
          let topics = ''
          try { topics = JSON.parse(topicsJson).slice(0, 3).join(', ') } catch {}
          const dur = ((endAt - startAt) / 60000).toFixed(0)
          console.log(`  ${String(sid).padEnd(30)} ${String(msgCnt).padEnd(5)} ${imp.toFixed(2)}  ${topics.padEnd(19)} ${String(source).padEnd(8)} ${String(triggerReason).padEnd(19)} ${dur}min`)
        }
      }
    }
  }

  // ── V4 Input Token Trend (from main.db if available) ──
  // evaluation_events is in events.db, not accessible.
  // The regression check is manual: compare with pre-Phase-1 latency baseline.
  console.log('')
  console.log('▶ V4 — Regression')

  // Total message count (proxy for app usage)
  const msgCount = main.exec('SELECT COUNT(*) FROM messages')
  console.log(`  Total messages in DB: ${msgCount[0].values[0][0]}`)

  // Session count
  const sessCount = main.exec('SELECT COUNT(DISTINCT session_id) FROM messages WHERE session_id IS NOT NULL')
  console.log(`  Total sessions: ${sessCount[0].values[0][0]}`)

  console.log('')
  console.log('▶ Events')
  console.log('  events.db: use PRAGMA wal_checkpoint(FULL) then re-run with --events')
  console.log('  or close app, re-run, then events.db is readable.')

  console.log('')
  console.log('═══════════════════════════════════════════════')
  console.log('Observation Window Exit Criteria')
  console.log('═══════════════════════════════════════════════')
  console.log('')
  console.log('  Target                          Current   Status')
  console.log('  ─────────────────────────────── ───────── ──────')
  console.log(`  Compaction count ≥ 1              ${main.exec('SELECT COUNT(*) FROM session_compactions')[0].values[0][0]}        ${main.exec('SELECT COUNT(*) FROM session_compactions')[0].values[0][0] >= 1 ? '✅' : '⏳'}`)
  console.log(`    ├ observation_threshold         ${main.exec("SELECT COUNT(*) FROM session_compactions WHERE trigger_reason = 'observation_threshold'")[0].values[0][0]}`)
  console.log(`    ├ production_threshold          ${main.exec("SELECT COUNT(*) FROM session_compactions WHERE trigger_reason = 'production_threshold'")[0].values[0][0]}`)
  console.log(`    └ idle                          ${main.exec("SELECT COUNT(*) FROM session_compactions WHERE trigger_reason = 'idle'")[0].values[0][0]}`)
  console.log(`  Session switches ≥ 20            ${sessCount[0].values[0][0]}        ${sessCount[0].values[0][0] >= 20 ? '✅' : '⏳'}`)
  console.log(`  Memory failures = 0              —        ⏳`)
  console.log(`  Runtime regression = 0           —        ⏳`)
  console.log('')
  console.log('  Phase 2 Scoring Ranking: 🔒 Blocked until all exit criteria met')
  console.log('')

  main.close()
}

main().catch(console.error)
