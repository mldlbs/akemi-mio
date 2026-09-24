'use strict'

// Shared query log: the single implementation behind queries.jsonl.
//
// Two consumers need it and cannot reach each other: memoryStore records a
// query during queryMemory (phase 0 auto-claim input), and taskStore reads the
// log to attribute a later task_outcome to that query. Passing one store into
// the other would be a cycle, so the log is its own module and both get an
// instance handed in.
//
// This replaces what used to be two copies of load/persist -- one inlined in
// mio-intelligence-mcp/index.js, one in task-store.js -- which had to be kept
// equivalent by hand.

const path = require('path')
const { readJsonlCached, writeJsonl } = require('./memory-store.js')

const MAX_RECENT_QUERIES = 200

// Evaluated once at load, matching the previous inlined behaviour. Tests that
// need a different window should set MIO_REUSE_MATCH_WINDOW_MIN before require.
const REUSE_MATCH_WINDOW_MS = (() => {
  const minutes = Number(process.env.MIO_REUSE_MATCH_WINDOW_MIN)
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : 60 * 60 * 1000
})()

function createQueryLog(options = {}) {
  const dataDir = options.dataDir
  const queryPath = path.join(dataDir, 'queries.jsonl')

  function load() {
    const now = Date.now()
    return readJsonlCached(queryPath)
      .filter(
        (entry) =>
          entry &&
          typeof entry.agent === 'string' &&
          entry.agent &&
          typeof entry.expiresAt === 'number' &&
          entry.expiresAt > now
      )
      .slice(-MAX_RECENT_QUERIES)
  }

  function persist(entries) {
    const limited = entries.slice(-MAX_RECENT_QUERIES)
    writeJsonl(queryPath, limited)
    return limited
  }

  function record(entry) {
    const entries = load()
    entries.push(entry)
    return persist(entries)
  }

  return { queryPath, windowMs: REUSE_MATCH_WINDOW_MS, load, persist, record }
}

module.exports = { createQueryLog, REUSE_MATCH_WINDOW_MS, MAX_RECENT_QUERIES }
