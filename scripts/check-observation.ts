/**
 * Observation Validation — 数据采集状态检查
 *
 * 用法: node scripts/check-observation.ts  (或 npx tsx scripts/check-observation.ts)
 * 检查当前 evaluation_events 累积状态，对比三个检查点。
 */
import { readFileSync } from 'fs'

const DB_PATH = 'C:/Users/gf191/AppData/Roaming/akemi-mio/akemi-mio.db'

async function main() {
  const initSqlJs = (await import('sql.js')).default
  const SQL = await initSqlJs()
  const buf = readFileSync(DB_PATH)
  const db = new SQL.Database(buf)

  const cnt = db.exec('SELECT COUNT(*) as c FROM evaluation_events')
  const total = cnt[0]?.values?.[0]?.[0] ?? 0

  console.log('═══════════════════════════════════════')
  console.log('  Observation Validation — 数据状态')
  console.log(`  采集时间: ${new Date().toISOString()}`)
  console.log('═══════════════════════════════════════')
  console.log(`  📊 总事件数: ${total}`)
  console.log()

  // 按类型分布
  const types = db.exec('SELECT type, COUNT(*) as c FROM evaluation_events GROUP BY type ORDER BY c DESC')
  if (types[0]?.values) {
    console.log('  ┌─ 按类型分布 ──────────────────────')
    for (const [type, count] of types[0].values) {
      console.log(`  │ ${String(type).padEnd(22)} ${String(count).padStart(6)}`)
    }
    console.log('  └────────────────────────────────────')
    console.log()
  }

  // 配对率
  const inv = Number(db.exec("SELECT COUNT(*) as c FROM evaluation_events WHERE type='model.invoked'")[0]?.values?.[0]?.[0] ?? 0)
  const comp = Number(db.exec("SELECT COUNT(*) as c FROM evaluation_events WHERE type='model.completed'")[0]?.values?.[0]?.[0] ?? 0)
  const pairRate = inv > 0 ? ((comp / inv) * 100).toFixed(2) : 'N/A'
  const traces = Number(db.exec('SELECT COUNT(DISTINCT trace_id) as c FROM evaluation_events')[0]?.values?.[0]?.[0] ?? 0)

  console.log(`  ┌─ 核心指标 ──────────────────────────`)
  console.log(`  │ model.invoked        ${String(inv).padStart(6)}`)
  console.log(`  │ model.completed      ${String(comp).padStart(6)}`)
  console.log(`  │ 配对率               ${String(pairRate).padStart(7)}%`)
  console.log(`  │ 唯一 Trace           ${String(traces).padStart(6)}`)
  console.log('  └────────────────────────────────────')
  console.log()

  // 检查点状态
  const milestones = [
    { name: '检查点 1: 10 次调用', target: 10 },
    { name: '检查点 2: 30–50 次调用', target: 30 },
    { name: '检查点 3: 100+ 次调用 (Exit)', target: 100 },
  ]
  console.log('  ┌─ 检查点进度 ────────────────────────')
  for (const m of milestones) {
    const met = inv >= m.target
    const bar = met ? '████████████████████ 100%' : `████░░░░░░░░░░░░░░ █ ${Math.min(100, Math.round((inv / m.target) * 100))}%`
    console.log(`  │ ${met ? '✅' : '⏳'} ${m.name.padEnd(30)} ${bar}`)
  }
  console.log('  └────────────────────────────────────')

  db.close()
}

main().catch(console.error)
