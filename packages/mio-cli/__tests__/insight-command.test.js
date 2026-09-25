'use strict'

// Tests for `mio insight`. The insight engine is an optional package
// (@akemi-mio/insight) that is not installed in this repo, so the store logic is
// exercised against an injected fake via a Module._load hook -- that covers the
// real filtering/marking code rather than only the "not installed" path. The
// subprocess tests then pin argument validation, which runs before the store is
// ever touched.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const CLI = path.join(repoRoot, 'packages', 'mio-cli', 'bin', 'mio.js')

// Captured before any fake is injected, so it reflects the real environment.
// Ask the store rather than the package name: the store falls back to the
// workspace source (packages/insight), so a bare require() of the package here
// would report "not installed" on a machine where the tools actually work.
const { isInsightAvailable } = require('../server/insight-store.js')
const realInsightAvailable = isInsightAvailable()

const INSIGHT_STORE_PATH = require.resolve('../server/insight-store.js')

// The workspace-source fallback the store uses when the package is missing.
const INSIGHT_FALLBACK = path.resolve(__dirname, '..', '..', 'insight')

// Loads insight-store.js with @akemi-mio/insight resolved to `fake`. The store
// caches the constructor at module load, so the cache entry is dropped first.
function loadStoreWithFake(fake) {
  const original = Module._load
  Module._load = function (request, ...rest) {
    if (request === '@akemi-mio/insight') return fake
    // `fake === null` means "the package is not installed" -- the fallback would
    // otherwise load packages/insight and the simulation would simulate nothing.
    if (fake === null && path.resolve(request) === INSIGHT_FALLBACK) {
      throw new Error('@akemi-mio/insight not installed')
    }
    return original.call(this, request, ...rest)
  }
  delete require.cache[INSIGHT_STORE_PATH]
  try {
    return require('../server/insight-store.js')
  } finally {
    Module._load = original
  }
}

function makeFake(seed) {
  const instances = []
  class FakeInsightStore {
    constructor(file) {
      this.file = file
      this.items = seed.map((i) => ({ ...i }))
      this.reportedIds = new Set(seed.filter((i) => i.reported).map((i) => i.id))
      instances.push(this)
    }
    getAll() {
      return this.items
    }
    getUnreported() {
      return this.items.filter((i) => !this.reportedIds.has(i.id))
    }
    getHighValueUnreported(limit, minScore) {
      return this.getUnreported().filter((i) => (i.score || 0) >= minScore).slice(0, limit)
    }
    markReported(id) {
      this.reportedIds.add(id)
    }
    addMany(list) {
      this.items.push(...list)
    }
  }
  return { module: { InsightStore: FakeInsightStore, InsightGenerator: class {} }, instances }
}

function insight(id, score, extra = {}) {
  return { id, score, detector: 'drift', content: 'insight ' + id, ...extra }
}

function workspace() {
  const mioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-ins-home-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-ins-cwd-'))
  return { mioHome, cwd, env: { ...process.env, MIO_HOME: mioHome } }
}

function run(ws, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ws.cwd, encoding: 'utf8', env: ws.env })
}

test('insight status counts total, reported, unreported and high-value', () => {
  const fake = makeFake([
    insight('i1', 0.9),
    insight('i2', 0.8, { reported: true }),
    insight('i3', 0.5),
    insight('i4', 0.75),
  ])
  const { createInsightStore } = loadStoreWithFake(fake.module)
  const store = createInsightStore({ dataDir: '/tmp/whatever' })

  const result = store.status()
  assert.equal(result.total, 4)
  assert.equal(result.reported, 1)
  assert.equal(result.unreported, 3)
  // high-value is unreported with score >= 0.7: i1 (0.9) and i4 (0.75).
  assert.equal(result.highValue, 2, 'i2 is reported so it must not count as high-value')
})

test('insight list filters by unreported, min-score and detector', () => {
  const fake = makeFake([
    insight('i1', 0.9),
    insight('i2', 0.4, { reported: true }),
    insight('i3', 0.6, { detector: 'other' }),
  ])
  const { createInsightStore } = loadStoreWithFake(fake.module)
  const store = createInsightStore({ dataDir: '/tmp/whatever' })

  const all = store.list({})
  assert.equal(all.length, 3)

  const unreported = store.list({ unreported: true })
  assert.deepEqual(unreported.map((i) => i.id), ['i1', 'i3'])

  const highScoring = store.list({ minScore: 0.6 })
  assert.deepEqual(highScoring.map((i) => i.id), ['i1', 'i3'])

  const byDetector = store.list({ detector: 'other' })
  assert.deepEqual(byDetector.map((i) => i.id), ['i3'])
})

test('insight list --limit keeps the most recent N, not the first N', () => {
  const fake = makeFake([insight('i1', 0.5), insight('i2', 0.5), insight('i3', 0.5), insight('i4', 0.5)])
  const { createInsightStore } = loadStoreWithFake(fake.module)
  const store = createInsightStore({ dataDir: '/tmp/whatever' })

  // The store slices from the end, which is the "most recent" end given
  // insights are appended in discovery order.
  assert.deepEqual(store.list({ limit: 2 }).map((i) => i.id), ['i3', 'i4'])
})

test('insight mark-reported marks every id and reports the count', () => {
  const fake = makeFake([insight('i1', 0.9), insight('i2', 0.8)])
  const { createInsightStore } = loadStoreWithFake(fake.module)
  const store = createInsightStore({ dataDir: '/tmp/whatever' })

  const result = store.markReported({ ids: ['i1', 'i2'] })
  assert.equal(result.marked, 2)
  assert.deepEqual(store.list({ unreported: true }), [], 'both insights are now reported')

  assert.throws(() => store.markReported({}), /ids array required/)
  assert.throws(() => store.markReported({ ids: 'i1' }), /ids array required/)
})

test('the insight store lives under <dataDir>/insights/insights.json', () => {
  const fake = makeFake([])
  const { createInsightStore } = loadStoreWithFake(fake.module)
  const store = createInsightStore({ dataDir: path.join('base', 'home') })

  assert.equal(store.storePath, path.join('base', 'home', 'insights', 'insights.json'))
  // Constructed lazily: creating the store must not touch the filesystem.
  assert.equal(fake.instances.length, 0)
  store.status()
  assert.equal(fake.instances.length, 1)
  assert.equal(fake.instances[0].file, store.storePath)
})

test('insight status explains a missing optional package instead of returning zeros', () => {
  // With no fake installed the store must fail loudly -- an empty report would
  // read as "no insights" rather than "engine not available".
  const { createInsightStore, isInsightAvailable } = loadStoreWithFake(null)
  const store = createInsightStore({ dataDir: '/tmp/whatever' })

  assert.equal(isInsightAvailable(), false)
  assert.throws(() => store.status(), /@akemi-mio\/insight not installed/)
})

test('the CLI validates insight subcommands before touching the store', () => {
  const ws = workspace()

  const none = run(ws, ['insight'])
  assert.equal(none.status, 1)
  assert.match(none.stdout, /Usage:/)

  const unknown = run(ws, ['insight', 'bogus'])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /Unknown insight subcommand: bogus/)
  // Usage must go to stderr too, leaving stdout empty for `--json` callers.
  assert.match(unknown.stderr, /Usage:/)
  assert.equal(unknown.stdout, '')

  // generate is exposed now (it was the only mio.insight.* tool without a
  // terminal entry point), but it must refuse to touch the LLM without context.
  const generate = run(ws, ['insight', 'generate'])
  assert.equal(generate.status, 1)
  assert.match(generate.stderr, /needs context/)

  const noIds = run(ws, ['insight', 'mark-reported'])
  assert.equal(noIds.status, 1)
  assert.match(noIds.stderr, /requires --ids/)

  const help = run(ws, ['insight', 'help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /mio insight status/)
})

// ── mio insight generate ────────────────────────────────────────────────
// generate calls an LLM, so the engine is stubbed the same way
// creativity-generate.test.js does it: a fake @akemi-mio/insight injected
// through a Module._load hook. The CLI-level cases run with a `-r` preload, so
// the whole path (argv -> store -> generator -> stdout) is exercised for real
// without a network call.

function makeFakeWithGenerator(seed, generateImpl) {
  const fake = makeFake(seed)
  fake.module = {
    ...fake.module,
    InsightGenerator: class {
      async generate(ctx) {
        return generateImpl(ctx)
      }
    },
  }
  return fake
}

function generatedTwo() {
  return [insight('g1', 0.8, { content: 'generated one' }), insight('g2', 0.5, { content: 'generated two' })]
}

// The preload resolves @akemi-mio/insight to a fake whose generator records the
// context it was handed in $FAKE_CTX -- that file is the proof the LLM was (or
// was not) called.
function runWithFake(ws, args) {
  const preload = path.join(ws.cwd, 'fake-insight-preload.js')
  const ctxFile = path.join(ws.cwd, 'ctx.json')
  fs.writeFileSync(
    preload,
    `'use strict'
const Module = require('node:module')
const fs = require('node:fs')
const original = Module._load
class FakeInsightStore {
  constructor(file) { this.items = [] }
  getAll() { return this.items }
  getUnreported() { return this.items }
  getHighValueUnreported() { return [] }
  markReported() {}
  addMany(list) { this.items.push(...list) }
}
class FakeInsightGenerator {
  async generate(ctx) {
    fs.writeFileSync(process.env.FAKE_CTX, JSON.stringify(ctx))
    return [
      { id: 'g1', score: 0.8, content: 'generated one', detector: 'drift' },
      { id: 'g2', score: 0.5, content: 'generated two', detector: 'drift' },
    ]
  }
}
Module._load = function (request, ...rest) {
  if (request === '@akemi-mio/insight') {
    return { InsightStore: FakeInsightStore, InsightGenerator: FakeInsightGenerator }
  }
  return original.call(this, request, ...rest)
}
`
  )
  const result = spawnSync(process.execPath, ['-r', preload, CLI, ...args], {
    cwd: ws.cwd,
    encoding: 'utf8',
    env: { ...ws.env, FAKE_CTX: ctxFile },
  })
  return { ctxFile, result }
}

test('insight generate maps --memory "kind|content" onto generator context entries', async () => {
  let seen = null
  const fake = makeFakeWithGenerator([], (ctx) => {
    seen = ctx
    return []
  })
  const { createInsightStore } = loadStoreWithFake(fake.module)
  const store = createInsightStore({ dataDir: '/tmp/whatever' })

  const result = await store.generate({
    memories: [{ kind: 'decision', content: 'moved parsing into a shared store' }],
    summaries: ['shipped 0.7.0'],
  })

  assert.equal(result.generated, 0)
  assert.equal(seen.memoryEntries.length, 1)
  assert.equal(seen.memoryEntries[0].type, 'decision')
  assert.equal(seen.memoryEntries[0].content, 'moved parsing into a shared store')
  assert.deepEqual(seen.summaries, ['shipped 0.7.0'])
})

test('insight generate falls back to the default kind when --memory has none', async () => {
  let seen = null
  const fake = makeFakeWithGenerator([], (ctx) => {
    seen = ctx
    return []
  })
  const { createInsightStore } = loadStoreWithFake(fake.module)
  const store = createInsightStore({ dataDir: '/tmp/whatever' })

  await store.generate({ memories: [{ content: 'bare content' }] })
  assert.equal(seen.memoryEntries[0].type, 'note')
  assert.equal(seen.memoryEntries[0].content, 'bare content')
})

test('insight generate persists what the generator returns', async () => {
  const fake = makeFakeWithGenerator([insight('existing', 0.9)], () => generatedTwo())
  const { createInsightStore } = loadStoreWithFake(fake.module)
  const store = createInsightStore({ dataDir: '/tmp/whatever' })

  const result = await store.generate({ memories: [{ content: 'x' }] })
  assert.equal(result.generated, 2)
  // Persisted, or `mio insight list` would never show what was just generated.
  assert.equal(fake.instances[0].items.length, 3)
})

test('insight generate --json emits the same shape as the MCP tool', () => {
  const ws = workspace()
  const { result } = runWithFake(ws, ['insight', 'generate', '--memory', 'decision|moved parsing', '--json'])

  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.generated, 2)
  assert.equal(payload.insights.length, 2)
})

test('insight generate splits kind from content before the store sees it', () => {
  const ws = workspace()
  const { ctxFile, result } = runWithFake(ws, ['insight', 'generate', '--memory', 'decision|moved parsing'])

  assert.equal(result.status, 0, result.stderr)
  const ctx = JSON.parse(fs.readFileSync(ctxFile, 'utf8'))
  assert.equal(ctx.memoryEntries.length, 1)
  assert.equal(ctx.memoryEntries[0].type, 'decision')
  assert.equal(ctx.memoryEntries[0].content, 'moved parsing')
})

test('insight generate refuses to call the LLM without context', () => {
  const ws = workspace()
  const { ctxFile, result } = runWithFake(ws, ['insight', 'generate'])

  assert.equal(result.status, 1)
  assert.match(result.stderr, /needs context/)
  assert.equal(fs.existsSync(ctxFile), false, 'the generator must not run when context is missing')
})

test('a trailing --json is a flag, not the value of --memory', () => {
  const ws = workspace()
  const { result } = runWithFake(ws, ['insight', 'generate', '--memory', 'decision|x', '--json'])

  assert.equal(result.status, 0, result.stderr)
  // If --json were eaten as a second --memory value the output would be the
  // human-readable form instead, and this parse would throw.
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.generated, 2)
})

test('an empty --memory does not swallow the flag that follows it', () => {
  const ws = workspace()
  // Note: --json cannot be used to probe this -- main() strips it from argv
  // before the command ever sees it. --summary does reach the command.
  const { ctxFile, result } = runWithFake(ws, ['insight', 'generate', '--memory', '--summary', 'context text'])

  assert.equal(result.status, 0, result.stderr)
  const ctx = JSON.parse(fs.readFileSync(ctxFile, 'utf8'))
  // If "--summary" were taken as the value of --memory, it would arrive as a
  // memory entry and the summary list would be emptied instead.
  assert.deepEqual(ctx.memoryEntries, [])
  assert.deepEqual(ctx.summaries, ['context text'])
})

// Blocks both resolution routes (package name + workspace fallback) so the run
// behaves like a machine that never installed @akemi-mio/insight. Depending on
// whether the real package happens to be present would make this assertion
// untestable in this checkout, where the fallback now provides it.
function runWithoutInsight(ws, args) {
  const preload = path.join(ws.cwd, 'missing-insight-preload.js')
  const fallback = JSON.stringify(INSIGHT_FALLBACK)
  fs.writeFileSync(
    preload,
    `'use strict'
const Module = require('node:module')
const path = require('node:path')
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === '@akemi-mio/insight' || path.resolve(request) === ${fallback}) {
    throw new Error('Cannot find module \\'@akemi-mio/insight\\'')
  }
  return originalLoad.apply(this, [request, parent, isMain])
}
`
  )
  return spawnSync(process.execPath, ['-r', preload, CLI, ...args], {
    cwd: ws.cwd,
    encoding: 'utf8',
    env: ws.env,
  })
}

test('insight generate reports a missing engine instead of a misleading zero', () => {
  const ws = workspace()
  const result = runWithoutInsight(ws, ['insight', 'generate', '--summary', 'x'])

  assert.equal(result.status, 1, 'an unavailable engine must fail, not report generated: 0')
  assert.match(result.stderr, /@akemi-mio\/insight not installed/)
})

test('insight status reports counts when installed, or says it is not', () => {
  const ws = workspace()
  const result = run(ws, ['insight', 'status', '--json'])

  if (realInsightAvailable) {
    assert.equal(result.status, 0, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.equal(typeof payload.total, 'number')
    assert.equal(typeof payload.unreported, 'number')
    assert.equal(typeof payload.highValue, 'number')
  } else {
    assert.equal(result.status, 1, 'an unavailable engine must fail, not report zeros')
    assert.match(result.stderr, /@akemi-mio\/insight not installed/)
  }
})

// The CLI must wire chatJson into createInsightStore exactly like the MCP
// server does ({ dataDir, chatJson }). Without it the real generator stores
// `this.llm = { chatJson: undefined }` and dies at generate time with
// "TypeError: this.llm.chatJson is not a function" -- the fakes above never
// touch the deps object, so this records what the CLI actually passed in.
test('insight generate passes chatJson into the store', () => {
  const ws = workspace()
  const preload = path.join(ws.cwd, 'chatjson-preload.js')
  const recordFile = path.join(ws.cwd, 'chatjson.json')
  fs.writeFileSync(
    preload,
    `'use strict'
const Module = require('node:module')
const fs = require('node:fs')
const original = Module._load
class FakeInsightStore {
  constructor(file) { this.items = [] }
  getAll() { return this.items }
  getUnreported() { return this.items }
  getHighValueUnreported() { return [] }
  markReported() {}
  addMany(list) { this.items.push(...list) }
}
class FakeInsightGenerator {
  constructor(deps) {
    fs.writeFileSync(process.env.RECORD_FILE, JSON.stringify({
      chatJsonType: typeof (deps && deps.chatJson),
    }))
  }
  async generate() { return [] }
}
Module._load = function (request, ...rest) {
  if (request === '@akemi-mio/insight') {
    return { InsightStore: FakeInsightStore, InsightGenerator: FakeInsightGenerator }
  }
  return original.call(this, request, ...rest)
}
`
  )
  const result = spawnSync(
    process.execPath,
    ['-r', preload, CLI, 'insight', 'generate', '--summary', 'x', '--json'],
    { cwd: ws.cwd, encoding: 'utf8', env: { ...ws.env, RECORD_FILE: recordFile } }
  )

  assert.equal(result.status, 0, result.stderr)
  const rec = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
  assert.equal(
    rec.chatJsonType,
    'function',
    'cliInsightStore() must call createInsightStore({ dataDir: MIO_HOME, chatJson })'
  )
})
