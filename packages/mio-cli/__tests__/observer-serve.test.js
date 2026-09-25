'use strict'

// D6: the daily research engine had no scheduler host.
//
// ObserverService.start() already wired per-collector intervals, a 60s pipeline
// tick and a 5s first tick, and tickPipeline skips while today's DAG is
// COMPLETED -- but nothing in mio-agent-runtime ever called start(), so
// runPipeline/tickPipeline/forcePipeline had no long-lived caller and
// trends/research/insights only appeared if someone hand-ran
// `mio observer pipeline --run`.
//
// The fix is a host, not new scheduling logic: `mio observer serve` runs the
// service in the foreground, and `mio observe --start --research` spawns that
// same command as a second pid-managed child (opt-in: starting the transcript
// watcher must not silently start spending LLM calls). Because two hosts plus
// a manual `pipeline --run` can now overlap, runPipeline also takes a
// cross-process PipelineLock -- `pipelineRunning` only ever guarded one
// process.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const CLI = path.resolve(__dirname, '..', 'bin', 'mio.js')
const OBSERVER_PKG = path.resolve(__dirname, '..', '..', 'observer')
const { createObserverStore } = require('../server/observer-store.js')
const observer = require('../observe/observer.js')

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('D6 serve --dry-run reports the schedule without touching disk', async () => {
  const baseDir = path.join(tmpDir('mio-serve-dry-'), 'observer')
  const result = await createObserverStore().serve({ baseDir, dryRun: true })

  assert.equal(result.dryRun, true)
  assert.equal(result.observerAvailable, true)
  assert.equal(result.baseDir, baseDir)
  assert.equal(result.schedule.pipelineTickMs, 60000)
  assert.ok(result.schedule.lockFile.endsWith(path.join('dag', 'pipeline.lock')))
  assert.match(result.hint, /--dry-run/)
  assert.equal(
    fs.existsSync(baseDir),
    false,
    'a preview must not mkdir: check:cli-docs runs `mio observer serve --dry-run` against a temp --base-dir',
  )
})

test('D6 `mio observer serve --dry-run` exits 0 and previews', () => {
  const baseDir = path.join(tmpDir('mio-serve-cli-'), 'observer')
  const home = tmpDir('mio-serve-home-')
  const r = spawnSync(process.execPath, [CLI, 'observer', 'serve', '--dry-run', '--base-dir', baseDir], {
    encoding: 'utf8',
    env: { ...process.env, MIO_HOME: home },
    timeout: 30000,
  })
  const out = `${r.stdout || ''}${r.stderr || ''}`

  assert.equal(r.status, 0, out)
  assert.match(out, /Observer research scheduler preview/)
  assert.match(out, /gate:/)
  assert.doesNotMatch(out, /Unknown observer subcommand/)
  assert.equal(fs.existsSync(baseDir), false, 'the documented probe must stay side-effect free')
})

test('D6 `mio observe --research` without --start is refused', () => {
  const home = tmpDir('mio-observe-research-')
  const r = spawnSync(process.execPath, [CLI, 'observe', '--research'], {
    encoding: 'utf8',
    env: { ...process.env, MIO_HOME: home },
    timeout: 30000,
  })
  assert.equal(r.status, 1)
  assert.match(`${r.stderr || ''}`, /--research only applies to --start/)
})

test('D6 `mio observe --status` reports both daemons', () => {
  const home = tmpDir('mio-observe-status-')
  const r = spawnSync(process.execPath, [CLI, 'observe', '--status', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, MIO_HOME: home },
    timeout: 30000,
  })
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
  const payload = JSON.parse(r.stdout)
  assert.equal(payload.running, false)
  assert.ok('research' in payload, '--status must surface the research scheduler, not just the transcript daemon')
  assert.equal(payload.research.running, false)
  assert.match(payload.research.logFile, /research\.log$/, 'a stalled scheduler has to be diagnosable from its log path')
})

// The scheduler child is spawned detached and never joined, so its argv and pid
// file are asserted through an injected spawn: a test must not start a real
// scheduler, and must never signal a pid it does not own.
test('D6 `mio observe --start --research` spawns `observer serve` in the launcher cwd', () => {
  const home = tmpDir('mio-research-home-')
  const cwd = tmpDir('mio-research-cwd-')
  const spawned = []
  const fakeSpawn = (cmd, argv, opts) => {
    spawned.push({ cmd, argv, opts })
    // process.pid, not a made-up one: isResearchRunning() probes liveness with
    // kill(pid, 0), so an invented pid would make the "already running" branch
    // depend on what happens to be running on this machine.
    return { pid: process.pid, unref() {} }
  }

  const started = observer.startResearchBackground(home, { cwd, spawn: fakeSpawn })
  assert.equal(started.started, true)
  assert.equal(started.pid, process.pid)
  assert.equal(started.baseDir, path.join(cwd, '.local', 'observer'))

  assert.equal(spawned.length, 1)
  const { cmd, argv, opts } = spawned[0]
  assert.equal(cmd, process.execPath)
  assert.deepEqual(argv.slice(1), [
    'observer',
    'serve',
    '--base-dir',
    path.join(cwd, '.local', 'observer'),
  ])
  assert.equal(opts.detached, true)
  assert.equal(opts.cwd, cwd, 'the child must inherit the launcher cwd so research data lands in the same directory `mio observer status` reads')
  // stdout/stderr go to an append fd, not a pipe: the scheduler logs to stdout
  // and a pipe nobody drains would block it once the buffer fills.
  assert.equal(opts.stdio[0], 'ignore')
  assert.equal(typeof opts.stdio[1], 'number')
  assert.equal(opts.stdio[1], opts.stdio[2])
  assert.equal(started.logFile, path.join(home, 'research.log'))
  assert.equal(fs.existsSync(started.logFile), true, 'the log fd must be opened (and truncated-free append) before spawn')
  assert.equal(fs.readFileSync(path.join(home, 'research.pid'), 'utf8'), String(process.pid))

  // Already running: a second --start must not fork a second scheduler.
  const again = observer.startResearchBackground(home, { cwd, spawn: fakeSpawn })
  assert.equal(again.started, false)
  assert.equal(spawned.length, 1)

  const killed = []
  const stopped = observer.stopResearchBackground(home, (pid) => killed.push(pid))
  assert.deepEqual(killed, [process.pid])
  assert.equal(stopped.stopped, true)
  assert.equal(fs.existsSync(path.join(home, 'research.pid')), false)
})

function loadLock() {
  const file = path.resolve(OBSERVER_PKG, 'dist', 'PipelineLock.js')
  if (!fs.existsSync(file)) {
    assert.fail(`missing ${file} -- build it first: npx tsc -p packages/observer/tsconfig.json`)
  }
  return require(file).PipelineLock
}

test('D6 PipelineLock blocks a second holder and steals a stale lock', () => {
  const PipelineLock = loadLock()
  const dir = tmpDir('mio-pipeline-lock-')
  const file = path.join(dir, 'pipeline.lock')

  const first = new PipelineLock(file)
  assert.equal(first.acquire(), true, 'first acquire must win')
  assert.equal(fs.existsSync(file), true)

  const second = new PipelineLock(file)
  assert.equal(second.acquire(), false, 'a live holder must not be stealable -- this is what stops serve + daemon + --run from interleaving one DAG')

  const stale = new PipelineLock(file, 60_000)
  const old = new Date(Date.now() - 10 * 60 * 1000)
  fs.utimesSync(file, old, old)
  assert.equal(stale.acquire(), true, 'a lock whose holder died before releasing must be recoverable')
  stale.release()
  assert.equal(fs.existsSync(file), false)

  first.release()
  assert.equal(new PipelineLock(file).acquire(), true, 'after release the lock is free again')
})

test('D6 runPipeline takes the cross-process lock and always releases it', () => {
  const files = [
    ['observer src', path.resolve(OBSERVER_PKG, 'src', 'ObserverService.ts')],
    ['observer dist (what npm installs)', path.resolve(OBSERVER_PKG, 'dist', 'ObserverService.js')],
    ['intelligence-observer src (app bundle)', path.resolve(__dirname, '..', '..', 'intelligence-observer', 'src', 'ObserverService.ts')],
  ]
  for (const [label, file] of files) {
    if (!fs.existsSync(file)) {
      assert.fail(`missing ${file} -- build it first: npx tsc -p packages/observer/tsconfig.json`)
    }
    const source = fs.readFileSync(file, 'utf8')
    const body = source.slice(source.indexOf('async runPipeline('), source.indexOf('async forceCollect('))
    assert.ok(body.length > 0, `${label}: runPipeline not found`)
    assert.match(body, /acquireRunLock\(\)/, `${label}: runPipeline must take the cross-process lock`)
    assert.match(body, /releaseRunLock\(\)/, `${label}: runPipeline must release it in finally`)
    assert.ok(
      body.indexOf('acquireRunLock()') < body.indexOf('pipelineRunning = true'),
      `${label}: the lock has to be taken before the run is marked in progress, so a losing caller returns null instead of joining half a run`,
    )
  }
})
