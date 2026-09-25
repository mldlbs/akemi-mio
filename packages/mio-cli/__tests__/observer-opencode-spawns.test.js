'use strict'

// Tier 3 perf guards for the opencode observation cycle. Two subprocess
// overheads used to burn spawns on every query:
//
// 1. findOpencodeBin() re-ran `where`/`which` opencode on EVERY
//    runOpencodeQuery call -- the bin does not move mid-run, so this doubled
//    the subprocess count of every cycle. It is now memoized (re-resolves
//    only when the cached path vanishes).
// 2. The seed path fired two `opencode db` queries (first rowid in the
//    backfill window, then MAX(rowid) as fallback). They are now one query
//    with scalar subselects.
//
// child_process is stubbed wholesale via Module._load interposition (the same
// trick observer-async.test.js uses), so these tests never touch a real
// opencode binary. The fake bin is process.execPath, which exists on disk and
// satisfies findOpencodeBin's fs.existsSync gate.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const OBSERVER_PATH = path.resolve(__dirname, '..', 'observe', 'observer.js')

// observer.js does `const { spawn, spawnSync } = require('child_process')` at
// module load, so the fakes must be installed on the shared child_process
// module object BEFORE the fresh require, and the real ones restored right
// after -- the destructured refs inside observer.js keep the fakes for the
// life of that module copy. (Module._load interposition does not reliably
// intercept the builtin child_process under `node --test`.)
function loadObserverWithSpawnSync(fakeSpawnSync) {
  const cp = require('child_process')
  const realSpawnSync = cp.spawnSync
  const realSpawn = cp.spawn
  cp.spawnSync = fakeSpawnSync
  cp.spawn = () => {
    throw new Error('spawn() must not be reached by runOpencodeCycle')
  }
  try {
    delete require.cache[OBSERVER_PATH]
    // eslint-disable-next-line global-require
    return require(OBSERVER_PATH)
  } finally {
    cp.spawnSync = realSpawnSync
    cp.spawn = realSpawn
  }
}

function makeSpawnHarness(rowsForSql) {
  const spawns = []
  const fakeBin = process.execPath
  const fakeSpawnSync = (command, args) => {
    spawns.push({ command, args: [...args] })
    if ((command === 'where' || command === 'which') && args[0] === 'opencode') {
      return { status: 0, stdout: fakeBin + '\n' }
    }
    if (command === fakeBin && args[0] === 'db') {
      const sql = args[1]
      const rows = rowsForSql(sql)
      return { status: 0, stdout: JSON.stringify(rows) }
    }
    return { status: 1, stdout: '', stderr: 'unexpected spawn: ' + command }
  }
  const dbSpawns = () => spawns.filter((s) => s.command === fakeBin && s.args[0] === 'db')
  const finderSpawns = () => spawns.filter((s) => s.command === 'where' || s.command === 'which')
  return { spawns, dbSpawns, finderSpawns, fakeBin, fakeSpawnSync }
}

function withTempDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-ocspawn-'))
  fs.writeFileSync(path.join(dir, 'opencode.db'), 'sqlite placeholder')
  const prevDataDir = process.env.OPENCODE_DATA_DIR
  const prevBin = process.env.OPENCODE_BIN
  process.env.OPENCODE_DATA_DIR = dir
  delete process.env.OPENCODE_BIN
  t.after(() => {
    if (prevDataDir === undefined) delete process.env.OPENCODE_DATA_DIR
    else process.env.OPENCODE_DATA_DIR = prevDataDir
    if (prevBin === undefined) delete process.env.OPENCODE_BIN
    else process.env.OPENCODE_BIN = prevBin
    fs.rmSync(dir, { recursive: true, force: true })
    delete require.cache[OBSERVER_PATH]
  })
  return dir
}

function touchMtime(file) {
  const st = fs.statSync(file)
  fs.utimesSync(file, new Date(st.atimeMs), new Date(st.mtimeMs + 5))
}

test('seed cycle spawns one finder + one db query, and seeds from the in-window rowid', (t) => {
  const dir = withTempDataDir(t)
  const harness = makeSpawnHarness(() => [{ first_rid: 42, max_rid: 1000 }])
  const observer = loadObserverWithSpawnSync(harness.fakeSpawnSync)

  const state = {}
  const out = observer.runOpencodeCycle(dir, state, {}, {})

  assert.equal(harness.finderSpawns().length, 1, 'exactly one `where`/`which` spawn for the whole cycle')
  assert.equal(harness.dbSpawns().length, 1, 'exactly one `opencode db` spawn for the seed (was two)')
  const sql = harness.dbSpawns()[0].args[1]
  assert.ok(sql.includes('first_rid') && sql.includes('max_rid'), 'the combined seed query carries both lookups')
  assert.equal(state.ocLastRowid, 42, 'cursor starts at the first in-window rowid')
  assert.equal(state.ocSeeded, true)
  assert.equal(state.ocPending, true)
  assert.equal(out.files, 1)
})

test('seed falls back to MAX(rowid) when nothing was written inside the window', (t) => {
  const dir = withTempDataDir(t)
  const harness = makeSpawnHarness(() => [{ first_rid: null, max_rid: 1000 }])
  const observer = loadObserverWithSpawnSync(harness.fakeSpawnSync)

  const state = {}
  observer.runOpencodeCycle(dir, state, {}, {})

  assert.equal(state.ocLastRowid, 1000, 'NULL first_rid must map to the MAX(rowid) fallback, not 0')
})

test('steady-state cycles re-run the finder zero extra times (memoized bin)', (t) => {
  const dir = withTempDataDir(t)
  const harness = makeSpawnHarness(() => [])
  const observer = loadObserverWithSpawnSync(harness.fakeSpawnSync)
  const db = observer.opencodeDbPath()

  // Seed first.
  const state = { ocSeeded: false }
  observer.runOpencodeCycle(dir, state, {}, {})
  assert.equal(harness.finderSpawns().length, 1)

  // Three more cycles, each seeing a changed db mtime -> one query each.
  for (let i = 0; i < 3; i++) {
    touchMtime(db)
    const out = observer.runOpencodeCycle(dir, state, {}, {})
    assert.equal(out.files, 1, 'cycle ' + i + ' reached the query path')
  }

  assert.equal(harness.finderSpawns().length, 1, 'the bin lookup must be memoized across cycles (was 4 spawns)')
  assert.equal(harness.dbSpawns().length, 4, 'each changed-mtime cycle still performs exactly one db query')
})

test('the memo re-resolves when the cached bin vanishes from disk', (t) => {
  const dir = withTempDataDir(t)
  let binPath = path.join(dir, 'fake-opencode.exe')
  fs.writeFileSync(binPath, 'stub')
  const harness = makeSpawnHarness(() => [])
  const originalSpawnSync = harness.fakeSpawnSync
  const dynamicSpawnSync = (command, args) => {
    if ((command === 'where' || command === 'which') && args[0] === 'opencode') {
      harness.spawns.push({ command, args: [...args] })
      return { status: 0, stdout: binPath + '\n' }
    }
    return originalSpawnSync(command, args)
  }
  const observer = loadObserverWithSpawnSync(dynamicSpawnSync)

  const state = { ocSeeded: true, ocLastRowid: 0, ocDbMtime: null, ocPending: false, ocTurns: {} }
  observer.runOpencodeCycle(dir, state, {}, {})
  assert.equal(harness.finderSpawns().length, 1)

  // The cached bin disappears: the memo must invalidate and re-resolve.
  fs.unlinkSync(binPath)
  touchMtime(observer.opencodeDbPath())
  observer.runOpencodeCycle(dir, state, {}, {})
  assert.equal(harness.finderSpawns().length, 2, 'a vanished bin must be re-resolved, not served from the memo')
})
