'use strict'

// Tests for `mio observer <view>`. The observer research pipeline used to be
// reachable only from inside an MCP session; these pin that the terminal entry
// point reads the same files the same way -- including ordering (newest trend
// report first), the per-view limits and the documented default base directory.
// Data is seeded into a throwaway base dir and passed with --base-dir, so no
// assertion depends on the developer's cwd.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const CLI = path.join(repoRoot, 'packages', 'mio-cli', 'bin', 'mio.js')
const { createObserverStore } = require('../server/observer-store.js')

function workspace() {
  const mioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-obs-home-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-obs-cwd-'))
  return { mioHome, cwd, env: { ...process.env, MIO_HOME: mioHome } }
}

function run(ws, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ws.cwd, encoding: 'utf8', env: ws.env })
}

function jsonOf(ws, args) {
  const result = run(ws, args)
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

// Builds a populated observer base directory from a declarative spec.
function seedObserver(spec = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-obs-base-'))
  const write = (rel, content) => {
    const full = path.join(base, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content, 'utf8')
  }
  for (const [name, item] of Object.entries(spec.trends || {})) {
    write(`trends/${name}.json`, JSON.stringify(item))
  }
  for (const [name, item] of Object.entries(spec.research || {})) {
    write(`research/${name}.json`, JSON.stringify(item))
  }
  for (const [name, item] of Object.entries(spec.insights || {})) {
    write(`insights/${name}.json`, JSON.stringify(item))
  }
  for (const [name, text] of Object.entries(spec.essays || {})) {
    write(`essays/published/${name}`, text)
  }
  for (const [name, items] of Object.entries(spec.summaries || {})) {
    write(`summaries/${name}.jsonl`, items.map((i) => JSON.stringify(i)).join('\n') + '\n')
  }
  for (const [key, value] of Object.entries(spec.worldModel || {})) {
    write(`world_model/${key}.json`, JSON.stringify(value))
  }
  return base
}

function isoDate(offsetDays = 0) {
  const d = new Date()
  d.setDate(d.getDate() - offsetDays)
  return d.toISOString().slice(0, 10)
}

test('observer status reports zero for every stage when nothing was collected', () => {
  const ws = workspace()
  const base = seedObserver()
  const result = jsonOf(ws, ['observer', 'status', '--json', '--base-dir', base])

  for (const stage of ['observations', 'trends', 'topics', 'research', 'insights', 'world_model', 'essays']) {
    assert.equal(result[stage], 0, `${stage} should be empty`)
  }

  const text = run(ws, ['observer', 'status', '--base-dir', base])
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /No pipeline data yet/)
})

test('observer status counts files per pipeline stage', () => {
  const ws = workspace()
  const base = seedObserver({
    trends: { '2026-09-10': { title: 'a' }, '2026-09-12': { title: 'b' } },
    research: { r1: { title: 'r' } },
    insights: { i1: { title: 'i' } },
    essays: { 'e1.md': '# e' },
    worldModel: { entities: [{ name: 'MCP' }] },
  })

  const result = jsonOf(ws, ['observer', 'status', '--json', '--base-dir', base])
  assert.equal(result.trends, 2)
  assert.equal(result.research, 1)
  assert.equal(result.insights, 1)
  assert.equal(result.world_model, 1)
  assert.equal(result.essays, 1)
})

test('observer trends returns the newest report first', () => {
  const ws = workspace()
  const base = seedObserver({
    trends: {
      '2026-09-10': { date: '2026-09-10', title: 'older' },
      '2026-09-12': { date: '2026-09-12', title: 'newer' },
    },
  })

  const items = jsonOf(ws, ['observer', 'trends', '--json', '--base-dir', base])
  assert.equal(items.length, 2)
  assert.deepEqual(
    items.map((i) => i.title),
    ['newer', 'older'],
    'reports are ordered by file name descending, so the newest day comes first'
  )
})

test('observer trends --date returns just that day', () => {
  const ws = workspace()
  const base = seedObserver({
    trends: {
      '2026-09-10': { date: '2026-09-10', title: 'older' },
      '2026-09-12': { date: '2026-09-12', title: 'newer' },
    },
  })

  const items = jsonOf(ws, ['observer', 'trends', '--json', '--date', '2026-09-10', '--base-dir', base])
  assert.equal(items.length, 1)
  assert.equal(items[0].title, 'older')

  const missing = jsonOf(ws, ['observer', 'trends', '--json', '--date', '1999-01-01', '--base-dir', base])
  assert.deepEqual(missing, [], 'an unknown date is an empty result, not an error')
})

test('observer research and insights honour --limit', () => {
  const ws = workspace()
  const base = seedObserver({
    research: { r1: { title: 'r1' }, r2: { title: 'r2' }, r3: { title: 'r3' } },
    insights: { i1: { title: 'i1' }, i2: { title: 'i2' } },
  })

  const research = jsonOf(ws, ['observer', 'research', '--json', '--limit', '2', '--base-dir', base])
  assert.equal(research.length, 2)

  const insights = jsonOf(ws, ['observer', 'insights', '--json', '--limit', '1', '--base-dir', base])
  assert.equal(insights.length, 1)
})

test('observer essays reads published markdown', () => {
  const ws = workspace()
  const base = seedObserver({ essays: { 'e1.md': '# Hello essay\n\nbody text' } })

  const items = jsonOf(ws, ['observer', 'essays', '--json', '--base-dir', base])
  assert.equal(items.length, 1)
  assert.equal(items[0].file, 'e1.md')
  assert.equal(items[0].type, 'published')
  assert.match(items[0].content, /# Hello essay/)

  const text = run(ws, ['observer', 'essays', '--base-dir', base])
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /e1\.md/)
  assert.match(text.stdout, /# Hello essay/)
})

test('observer dag aggregates daily summaries', () => {
  const ws = workspace()
  const base = seedObserver({
    summaries: {
      [isoDate(0)]: [{ text: 'today one' }, { text: 'today two' }],
      [isoDate(1)]: [{ text: 'yesterday' }],
    },
  })

  const result = jsonOf(ws, ['observer', 'dag', '--json', '--days', '7', '--base-dir', base])
  assert.equal(result.summaryCount, 3)
  assert.equal(result.summaries.length, 2)
  assert.equal(result.summaries[0].date, isoDate(0), 'most recent day first')
  assert.equal(result.summaries[0].summaries.length, 2)

  const text = run(ws, ['observer', 'dag', '--days', '7', '--base-dir', base])
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /3 summary\(ies\)/)
})

test('observer world-model returns all four sections, defaulting missing ones', () => {
  const ws = workspace()
  const base = seedObserver({
    worldModel: { entities: [{ name: 'MCP' }], events: [{ name: 'evt' }] },
  })

  const model = jsonOf(ws, ['observer', 'world-model', '--json', '--base-dir', base])
  assert.equal(model.entities.length, 1)
  assert.equal(model.events.length, 1)
  assert.deepEqual(model.trends, [], 'missing sections default to an empty list')
  assert.deepEqual(model.narratives, [])
})

test('observer defaults to <cwd>/.local/observer', () => {
  // Pins the documented default: with no --base-dir the CLI must read the
  // project-local directory the MCP server also uses.
  const ws = workspace()
  const local = path.join(ws.cwd, '.local', 'observer')
  fs.mkdirSync(path.join(local, 'trends'), { recursive: true })
  fs.writeFileSync(
    path.join(local, 'trends', '2026-09-12.json'),
    JSON.stringify({ title: 'from cwd default' }),
    'utf8'
  )

  const items = jsonOf(ws, ['observer', 'trends', '--json'])
  assert.equal(items.length, 1)
  assert.equal(items[0].title, 'from cwd default')
})

test('observer validates its subcommands', () => {
  const ws = workspace()

  const none = run(ws, ['observer'])
  assert.equal(none.status, 1)
  assert.match(none.stdout, /Usage:/)

  const unknown = run(ws, ['observer', 'bogus'])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /Unknown observer subcommand: bogus/)
  // Usage must go to stderr too, leaving stdout empty for `--json` callers.
  assert.match(unknown.stderr, /Usage:/)
  assert.equal(unknown.stdout, '')

  const help = run(ws, ['observer', 'help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /mio observer status/)
  // collect/ferment are skipped by scripts/check-cli-docs.cjs (they hit the
  // network / an LLM), so this is what still catches a rename.
  assert.match(help.stdout, /mio observer collect/)
  assert.match(help.stdout, /mio observer ferment/)
})

test('bad --limit is rejected rather than silently ignored', () => {
  const ws = workspace()
  const base = seedObserver({ research: { r1: { title: 'r1' } } })

  const result = run(ws, ['observer', 'research', '--limit', 'abc', '--base-dir', base])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /--limit must be a number/)
})

test('the CLI and the shared observer store agree', () => {
  // Both entry points delegate to server/observer-store.js; this pins that the
  // CLI is not re-implementing the reads.
  const ws = workspace()
  const base = seedObserver({
    trends: { '2026-09-10': { title: 'a' }, '2026-09-12': { title: 'b' } },
    research: { r1: { title: 'r1' } },
  })

  const store = createObserverStore({ baseDir: base })
  const viaCliTrends = jsonOf(ws, ['observer', 'trends', '--json', '--base-dir', base])
  assert.deepEqual(viaCliTrends, store.trends({}))

  const viaCliStatus = jsonOf(ws, ['observer', 'status', '--json', '--base-dir', base])
  assert.deepEqual(viaCliStatus, store.status({}))
})

// ─────────────────────────────────────────────────────────────────────────────
// ingest: records an arbitrary trace event (tool_call / error / retry / ...).
// It appends rather than modifies, so like `mio remember` it writes immediately
// instead of previewing -- but bad arguments must still be rejected before any
// write happens.
// ─────────────────────────────────────────────────────────────────────────────

function readTraces(ws) {
  const file = path.join(ws.mioHome, 'traces.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test('observer ingest records a trace event', () => {
  const ws = workspace()

  const result = run(ws, [
    'observer', 'ingest',
    '--trace-id', 't1',
    '--event-type', 'tool_call',
    '--payload', '{"tool":"Bash"}',
    '--project', 'demo',
  ])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Ingested tool_call \(trace=t1\)/)

  const traces = readTraces(ws)
  assert.equal(traces.length, 1)
  assert.equal(traces[0].trace_id, 't1')
  assert.equal(traces[0].event_type, 'tool_call')
  assert.deepEqual(traces[0].payload, { tool: 'Bash' })
  assert.equal(traces[0].project, 'demo')
  assert.equal(traces[0].agent, 'cli', 'the CLI identifies itself as cli')
})

test('observer ingest requires trace id and event type, writing nothing', () => {
  const ws = workspace()

  const missing = run(ws, ['observer', 'ingest'])
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /requires --trace-id/)

  const partial = run(ws, ['observer', 'ingest', '--trace-id', 't1'])
  assert.equal(partial.status, 1)
  assert.match(partial.stderr, /requires --trace-id/)

  assert.equal(fs.existsSync(path.join(ws.mioHome, 'traces.jsonl')), false, 'nothing written')
})

test('observer ingest rejects a malformed payload before writing', () => {
  const ws = workspace()

  const bad = run(ws, [
    'observer', 'ingest', '--trace-id', 't2', '--event-type', 'error', '--payload', '{not json',
  ])
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /valid JSON/)

  // Valid JSON but not an object -- also rejected, rather than silently stored.
  const array = run(ws, [
    'observer', 'ingest', '--trace-id', 't3', '--event-type', 'error', '--payload', '[1,2]',
  ])
  assert.equal(array.status, 1)
  assert.match(array.stderr, /JSON object/)

  assert.equal(readTraces(ws).length, 0, 'no write for either bad payload')
})

test('observer ingest --json returns the recorded event', () => {
  const ws = workspace()
  const result = run(ws, [
    'observer', 'ingest', '--trace-id', 't1', '--event-type', 'retry',
    '--outcome', 'success', '--project', 'demo', '--json',
  ])
  assert.equal(result.status, 0, result.stderr)
  const json = JSON.parse(result.stdout)
  assert.equal(json.recorded, true)
  assert.equal(json.event.trace_id, 't1')
  assert.equal(json.event.event_type, 'retry')
  assert.equal(json.event.outcome, 'success')
  assert.equal(readTraces(ws).length, 1)
})

test('the store rejects an ingest with no trace id or event type', () => {
  const { createTaskStore } = require('../server/task-store.js')
  const { createMemoryStore } = require('../server/memory-store.js')
  const ws = workspace()
  const store = createTaskStore({
    dataDir: ws.mioHome,
    projectName: () => 'demo',
    memoryStore: createMemoryStore({ dataDir: ws.mioHome, projectName: () => 'demo' }),
    agentId: () => 'cli',
  })

  assert.throws(() => store.ingestObservation({}), /requires trace_id/)
  assert.throws(() => store.ingestObservation({ trace_id: 't1' }), /requires event_type/)
  assert.equal(readTraces(ws).length, 0)
})

// ─────────────────────────────────────────────────────────────────────────────
// subscribe / digest. The digest is cursor-based: it returns only events newer
// than the last one delivered, so the second call returning 0 is correct, not a
// bug -- and the CLI says so in its output.
// ─────────────────────────────────────────────────────────────────────────────

function readSubscriptions(ws) {
  const file = path.join(ws.mioHome, 'subscriptions.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test('observer subscribe previews without writing', () => {
  const ws = workspace()

  const result = run(ws, [
    'observer', 'subscribe', '--event-types', 'tool_call,error', '--project', 'demo',
  ])
  assert.equal(result.status, 1, 'preview exits non-zero')
  assert.match(result.stdout, /Subscribe preview/)
  assert.match(result.stdout, /event types: tool_call, error/)
  assert.match(result.stdout, /will create a new subscription/)
  assert.equal(fs.existsSync(path.join(ws.mioHome, 'subscriptions.jsonl')), false)
})

test('observer subscribe --yes creates then renews in place', () => {
  const ws = workspace()

  const first = run(ws, [
    'observer', 'subscribe', '--event-types', 'tool_call', '--project', 'demo', '--yes',
  ])
  assert.equal(first.status, 0, first.stderr)
  let subs = readSubscriptions(ws)
  assert.equal(subs.length, 1)
  assert.equal(subs[0].agent, 'cli')
  assert.deepEqual(subs[0].eventTypes, ['tool_call'])

  // Same key -> renewal, not a second row.
  const again = run(ws, [
    'observer', 'subscribe', '--event-types', 'tool_call', '--project', 'demo', '--yes',
  ])
  assert.equal(again.status, 0, again.stderr)
  subs = readSubscriptions(ws)
  assert.equal(subs.length, 1, 'renewed in place, no duplicate')
})

test('observer digest returns matching events then stops repeating them', () => {
  const ws = workspace()
  run(ws, ['observer', 'subscribe', '--event-types', 'tool_call,error', '--project', 'demo', '--yes'])
  run(ws, ['observer', 'ingest', '--trace-id', 't1', '--event-type', 'tool_call', '--project', 'demo'])

  const first = run(ws, ['observer', 'digest', '--project', 'demo'])
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stdout, /Observer digest: 1 event\(s\)/)
  assert.match(first.stdout, /subscriptions: 1 active, 1 matched/)
  assert.match(first.stdout, /- tool_call trace=t1/)
  assert.match(first.stdout, /advances the cursor/, 'tells the user the run is not repeatable')

  // Cursor advanced: the same event is not delivered twice.
  const second = run(ws, ['observer', 'digest', '--project', 'demo'])
  assert.equal(second.status, 0, second.stderr)
  assert.match(second.stdout, /Observer digest: 0 event\(s\)/)
  assert.match(second.stdout, /Nothing new since the last digest/)

  // A genuinely new event comes through.
  run(ws, ['observer', 'ingest', '--trace-id', 't2', '--event-type', 'error', '--project', 'demo'])
  const third = run(ws, ['observer', 'digest', '--project', 'demo'])
  assert.match(third.stdout, /Observer digest: 1 event\(s\)/)
  assert.match(third.stdout, /- error trace=t2/)
})

test('observer digest without --event-types does not filter subscriptions out', () => {
  // Regression: the CLI passes [] when --event-types is omitted, and an empty
  // array is truthy -- it used to be treated as "match only subscriptions with
  // no event types", silently excluding everything.
  const ws = workspace()
  run(ws, ['observer', 'subscribe', '--event-types', 'tool_call', '--project', 'demo', '--yes'])
  run(ws, ['observer', 'ingest', '--trace-id', 't1', '--event-type', 'tool_call', '--project', 'demo'])

  const result = run(ws, ['observer', 'digest', '--project', 'demo'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /subscriptions: 1 active/, 'the subscription must still be considered')
  assert.match(result.stdout, /Observer digest: 1 event\(s\)/)
})

test('observer digest --json exposes counts and events', () => {
  const ws = workspace()
  run(ws, ['observer', 'subscribe', '--event-types', 'tool_call', '--project', 'demo', '--yes'])
  run(ws, ['observer', 'ingest', '--trace-id', 't1', '--event-type', 'tool_call', '--project', 'demo'])

  const json = jsonOf(ws, ['observer', 'digest', '--project', 'demo', '--json'])
  assert.equal(json.count, 1)
  assert.equal(json.subscriptionCount, 1)
  assert.equal(json.events[0].event_type, 'tool_call')
  assert.equal(json.events[0].trace_id, 't1')
})

// ─────────────────────────────────────────────────────────────────────────────
// collect / ferment: the two driver commands. They need the optional
// @akemi-mio/observer package, so the happy path is exercised against a fake
// injected with a -r preload (the package is not linked in this repo), while the
// "package missing" path is the real thing.
// ─────────────────────────────────────────────────────────────────────────────

// Writes a preload that swaps '@akemi-mio/observer' for a fake whose
// collectBySource/ferment log their arguments to $FAKE_OBSERVER_LOG so the test
// can see exactly what the CLI passed down.
function fakeObserverPreload(logFile) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mio-preload-')), 'fake-observer.js')
  fs.writeFileSync(
    file,
    `'use strict'
const Module = require('node:module')
const fs = require('node:fs')
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === '@akemi-mio/observer') {
    return {
      ObserverStore: function ObserverStore() {},
      ObserverService: class {
        async collectBySource(sources, keywords, limit) {
          // Appended, not overwritten: the store calls this once per source.
          fs.appendFileSync(
            process.env.FAKE_OBSERVER_LOG,
            JSON.stringify({ call: 'collect', sources, keywords, limit }) + '\\n',
          )
          const out = {}
          for (const name of sources) {
            out[name] = [{ id: name + '-1', source: name, content: 'item from ' + name }]
          }
          if (sources.includes('broken')) throw new Error('network down')
          return out
        }
        getFermentation() {
          return {
            async ferment(session) {
              fs.appendFileSync(
                process.env.FAKE_OBSERVER_LOG,
                JSON.stringify({ call: 'ferment', session }) + '\\n',
              )
              return {
                generatedAt: '2026-09-18T00:00:00.000Z',
                clusters: [{ theme: 'agent runtimes', associations: ['mcp', 'cli'], strength: 0.82 }],
              }
            },
          }
        }
      },
    }
  }
  return originalLoad.apply(this, [request, parent, isMain])
}
`,
    'utf8',
  )
  return { file, logFile }
}

function runFake(ws, args, logFile) {
  const { file } = fakeObserverPreload(logFile)
  if (fs.existsSync(logFile)) fs.rmSync(logFile)
  const result = spawnSync(process.execPath, ['-r', file, CLI, ...args], {
    cwd: ws.cwd,
    encoding: 'utf8',
    env: { ...ws.env, FAKE_OBSERVER_LOG: logFile },
  })
  const logged = fs.existsSync(logFile)
    ? fs
        .readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
  return { result, logged }
}

// Simulates a machine where @akemi-mio/observer was never installed. Both
// resolution routes have to fail: the package name, and the workspace-source
// fallback the store now uses (packages/observer exists in this checkout, so
// blocking only the package name would no longer simulate anything).
function missingObserverPreload() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mio-preload-')), 'missing-observer.js')
  const fallback = JSON.stringify(path.resolve(__dirname, '..', '..', 'observer'))
  fs.writeFileSync(
    file,
    `'use strict'
const Module = require('node:module')
const path = require('node:path')
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === '@akemi-mio/observer' || path.resolve(request) === ${fallback}) {
    throw new Error("Cannot find module '@akemi-mio/observer'")
  }
  return originalLoad.apply(this, [request, parent, isMain])
}
`
  )
  return file
}

function runWithoutObserver(ws, args) {
  return spawnSync(process.execPath, ['-r', missingObserverPreload(), CLI, ...args], {
    cwd: ws.cwd,
    encoding: 'utf8',
    env: ws.env,
  })
}

test('observer collect fails gracefully when the optional package is missing', () => {
  const ws = workspace()

  const text = runWithoutObserver(ws, ['observer', 'collect'])
  assert.equal(text.status, 1)
  assert.match(text.stderr, /@akemi-mio\/observer not installed/)

  const json = runWithoutObserver(ws, ['observer', 'collect', '--json'])
  assert.equal(json.status, 1)
  assert.match(json.stderr, /not installed/)

  const ferment = runWithoutObserver(ws, ['observer', 'ferment'])
  assert.equal(ferment.status, 1)
  assert.match(ferment.stderr, /@akemi-mio\/observer not installed/)
})

test('observer collect reports what each source returned', () => {
  const ws = workspace()
  const logFile = path.join(ws.mioHome, 'collect-args.json')

  const { result, logged } = runFake(ws, ['observer', 'collect', '--sources', 'rss,github'], logFile)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Collected 2 observation\(s\)/)
  assert.match(result.stdout, /rss: 1/)
  assert.match(result.stdout, /github: 1/)
  assert.deepEqual(logged, [
    { call: 'collect', sources: ['rss'], keywords: [], limit: 20 },
    { call: 'collect', sources: ['github'], keywords: [], limit: 20 },
  ])
})

test('observer collect defaults to every source instead of none', () => {
  // Regression guard: splitTagsOption returns [] for an absent flag and [] is
  // truthy, so passing it straight through meant "collect from zero sources".
  const ws = workspace()
  const logFile = path.join(ws.mioHome, 'collect-args.json')

  const { logged } = runFake(ws, ['observer', 'collect'], logFile)
  assert.equal(logged.length, 5, 'the store default is five sources, one call each')
  assert.deepEqual(
    logged.map((entry) => entry.sources[0]),
    ['bilibili', 'hackernews', 'github', 'douyin', 'rss'],
  )
  assert.ok(
    logged.every((entry) => entry.sources.length === 1),
    'never an empty source list',
  )
})

test('observer collect forwards --keywords and --limit, and keeps a failing source', () => {
  const ws = workspace()
  const logFile = path.join(ws.mioHome, 'collect-args.json')

  const { result, logged } = runFake(
    ws,
    ['observer', 'collect', '--sources', 'rss,broken', '--keywords', 'mcp,cli', '--limit', '3'],
    logFile,
  )
  assert.deepEqual(logged, [
    { call: 'collect', sources: ['rss'], keywords: ['mcp', 'cli'], limit: 3 },
    { call: 'collect', sources: ['broken'], keywords: ['mcp', 'cli'], limit: 3 },
  ])
  assert.equal(result.status, 0, 'one broken source must not fail the whole run')
  assert.match(result.stdout, /rss: 1/)
  assert.match(result.stdout, /broken: 0 \(errors: network down\)/)
})

test('observer collect --json matches mio.observer.collect', () => {
  const ws = workspace()
  const logFile = path.join(ws.mioHome, 'collect-args.json')

  const { result } = runFake(ws, ['observer', 'collect', '--sources', 'rss', '--json'], logFile)
  assert.equal(result.status, 0, result.stderr)
  const json = JSON.parse(result.stdout)
  assert.equal(json.collected, 1)
  assert.equal(json.observations[0].id, 'rss-1')
})

test('observer ferment prints its clusters and forwards --session', () => {
  const ws = workspace()
  const logFile = path.join(ws.mioHome, 'ferment-args.json')

  const { result, logged } = runFake(ws, ['observer', 'ferment', '--session', 'morning'], logFile)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(logged, [{ call: 'ferment', session: 'morning' }])
  assert.match(result.stdout, /Fermentation \(session=morning\): 1 cluster\(s\)/)
  assert.match(result.stdout, /\[0\.82\] agent runtimes — mcp, cli/)
})

test('observer ferment defaults to the afternoon session', () => {
  const ws = workspace()
  const logFile = path.join(ws.mioHome, 'ferment-args.json')

  const { logged } = runFake(ws, ['observer', 'ferment'], logFile)
  assert.deepEqual(logged, [{ call: 'ferment', session: 'afternoon' }])
})
