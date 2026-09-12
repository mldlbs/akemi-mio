const { DatabaseSync } = require('node:sqlite')
const path = require('path')

const ROAMING = 'C:/Users/gf191/AppData/Roaming/akemi-mio'
const destPath = path.join(ROAMING, 'databases', 'main.db')
const srcPath = path.join(ROAMING, 'akemi-mio.db.bak')

const dest = new DatabaseSync(destPath)
const src = new DatabaseSync(srcPath, { readOnly: true })
dest.exec('PRAGMA journal_mode=WAL')
dest.exec('PRAGMA synchronous=OFF')

/** 逐表迁移 */
const tables = [
  {
    name: 'messages',
    cols: [
      'id',
      'source',
      'role',
      'content',
      'telegram_chat_id',
      'telegram_user_id',
      'telegram_from',
      'telegram_message_id',
      'created_at',
      'session_id',
      'category',
    ],
    srcQuery:
      'SELECT id, source, role, content, telegram_chat_id, telegram_user_id, telegram_from, telegram_message_id, created_at, session_id, category FROM messages',
    extraDefault: { updated_at: null, original_created_at: null },
  },
  {
    name: 'memories',
    cols: ['id', 'type', 'content', 'confidence', 'created_at', 'updated_at', 'tier', 'reinforce_count'],
    srcQuery: 'SELECT id, type, content, confidence, created_at, updated_at, tier, reinforce_count FROM memories',
  },
  {
    name: 'memory_vectors',
    cols: ['id', 'content', 'embedding', 'confidence', 'source', 'created_at', 'updated_at'],
    srcQuery: 'SELECT id, content, embedding, confidence, source, created_at, updated_at FROM memory_vectors',
  },
  {
    name: 'memory_summaries',
    cols: ['id', 'summary', 'turn_start', 'turn_end', 'created_at'],
    srcQuery: 'SELECT id, summary, turn_start, turn_end, created_at FROM memory_summaries',
  },
  {
    name: 'engineering_memory',
    cols: ['id', 'type', 'content', 'source', 'confidence', 'related_files', 'tags', 'created_at', 'updated_at'],
    srcQuery: 'SELECT id, type, content, source, confidence, related_files, tags, created_at, updated_at FROM engineering_memory',
  },
  {
    name: 'procedures',
    cols: [
      'id',
      'name',
      'description',
      'steps',
      'trigger_keywords',
      'success_count',
      'fail_count',
      'created_at',
      'updated_at',
      'embedding',
    ],
    srcQuery:
      'SELECT id, name, description, steps, trigger_keywords, success_count, fail_count, created_at, updated_at, embedding FROM procedures',
  },
]

for (const t of tables) {
  let rows
  try {
    rows = src.prepare(t.srcQuery).all()
  } catch (e) {
    console.log(`${t.name}: ERROR - ${e.message}`)
    continue
  }
  if (rows.length === 0) {
    console.log(`${t.name}: 0 rows`)
    continue
  }

  // 新 DB 有更多列，INSERT 只插 src 存在的列
  const placeholders = t.cols.map(() => '?').join(', ')
  const stmt = dest.prepare(`INSERT OR IGNORE INTO ${t.name} (${t.cols.join(', ')}) VALUES (${placeholders})`)

  for (const r of rows) {
    const values = t.cols.map((c) => (r[c] !== undefined ? r[c] : null))
    stmt.run(...values)
  }
  console.log(`${t.name}: ${rows.length} rows restored`)
}

// events 和 evaluation_events 迁移到 events.db
const evDest = new DatabaseSync(path.join(ROAMING, 'databases', 'events.db'))
evDest.exec('PRAGMA journal_mode=WAL')
evDest.exec('PRAGMA synchronous=OFF')

for (const tEv of ['events', 'evaluation_events']) {
  try {
    const cols = src.prepare(`SELECT * FROM ${tEv} LIMIT 0`).all()
    const colNames = Object.keys(cols)
    if (colNames.length === 0) continue
    const rows = src.prepare(`SELECT * FROM ${tEv}`).all()
    if (rows.length === 0) {
      console.log(`${tEv}: 0 rows`)
      continue
    }
    const placeholders = colNames.map(() => '?').join(', ')
    const stmt = evDest.prepare(`INSERT OR IGNORE INTO ${tEv} (${colNames.join(', ')}) VALUES (${placeholders})`)
    const batch = evDest.transaction((rows) => {
      for (const r of rows) {
        const values = colNames.map((c) => (r[c] !== undefined ? r[c] : null))
        stmt.run(...values)
      }
    })
    batch(rows)
    console.log(`${tEv}: ${rows.length} rows restored`)
  } catch (e) {
    console.log(`${tEv}: ERROR - ${e.message}`)
  }
}

dest.exec('PRAGMA synchronous=NORMAL')
dest.exec('PRAGMA wal_checkpoint(TRUNCATE)')
evDest.exec('PRAGMA synchronous=NORMAL')
evDest.exec('PRAGMA wal_checkpoint(TRUNCATE)')

dest.close()
evDest.close()
src.close()
console.log('All done')
