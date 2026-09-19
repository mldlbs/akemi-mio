'use strict'

// mio.observer.collect / mio.observer.ferment drive the upstream
// @akemi-mio/observer package, whose ObserverService.collectBySource and
// FermentationEngine.ferment are both async. The store used to call them
// synchronously: a Promise is `typeof 'object'` with no own enumerable keys, so
// `Object.entries(promise)` yielded nothing and collect() cheerfully reported
// `collected: 0` while the real observations were thrown away.
//
// The optional package is not linked into node_modules in this repo, so these
// tests inject a fake one with Module._load before requiring the store -- the
// same trick used for the insight/observer availability probes. Every assertion
// here runs against the injected module; nothing touches the network.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const os = require('node:os')

const STORE_PATH = path.resolve(__dirname, '..', 'server', 'observer-store.js')
const MCP_PATH = path.resolve(__dirname, '..', 'server', 'mio-intelligence-mcp', 'index.js')

// Loads a *fresh* copy of the store with `resolver` interposed on
// '@akemi-mio/observer'. The module-level require happens once per load, so the
// cache has to be dropped to see a different fake.
// The store resolves the package first and, if that throws, falls back to the
// workspace source at packages/observer (see server/observer-store.js). A
// resolver that throws is meant to simulate "not installed", so the fallback has
// to fail as well -- in this checkout packages/observer exists, and without
// blocking it the simulation silently stops simulating anything.
const OBSERVER_FALLBACK = path.resolve(__dirname, '..', '..', 'observer')

function loadStoreWith(resolver) {
  delete require.cache[STORE_PATH]
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === '@akemi-mio/observer') return resolver()
    if (path.resolve(request) === OBSERVER_FALLBACK) {
      throw new Error("Cannot find module '@akemi-mio/observer'")
    }
    return originalLoad.apply(this, [request, parent, isMain])
  }
  try {
    // eslint-disable-next-line global-require
    return require(STORE_PATH)
  } finally {
    Module._load = originalLoad
  }
}

function fakeObserver(overrides = {}) {
  return {
    ObserverStore: function ObserverStore() {},
    ObserverService: class {
      async collectBySource(sources, keywords, limit) {
        if (overrides.collectImpl) return overrides.collectImpl(sources, keywords, limit)
        const out = {}
        for (const name of sources) {
          out[name] = [{ id: `${name}-1`, source: name, content: `item from ${name}` }]
        }
        return out
      }

      getFermentation() {
        return {
          async ferment(session) {
            return { generatedAt: '2026-09-18T00:00:00.000Z', session, clusters: overrides.clusters || [] }
          },
        }
      }
    },
  }
}

test('collect awaits the async collector instead of dropping its result', async () => {
  const { createObserverStore } = loadStoreWith(() => fakeObserver())
  const store = createObserverStore({ baseDir: path.join(os.tmpdir(), 'mio-collect-1') })

  const result = await store.collect({ sources: ['rss', 'github'] })
  assert.equal(result.collected, 2, 'both sources returned one observation each')
  assert.deepEqual(
    result.observations.map((o) => o.id),
    ['rss-1', 'github-1'],
  )
})

test('collect flattens both the record and the array result shapes', async () => {
  // Older/newer ObserverService versions differ: collectBySource returns
  // Record<source, Observation[]> while a plain collect() returns an array.
  const recordShape = loadStoreWith(() => fakeObserver())
  const one = await recordShape.createObserverStore({}).collect({ sources: ['rss'] })
  assert.equal(one.collected, 1)

  const arrayShape = loadStoreWith(() =>
    fakeObserver({
      collectImpl: () => [{ id: 'a1' }, { id: 'a2' }],
    }),
  )
  const two = await arrayShape.createObserverStore({}).collect({ sources: ['rss'] })
  assert.equal(two.collected, 2)
  assert.deepEqual(
    two.observations.map((o) => o.id),
    ['a1', 'a2'],
  )
})

test('collect forwards keywords and the per-source limit', async () => {
  let seen = null
  const { createObserverStore } = loadStoreWith(() =>
    fakeObserver({
      collectImpl: (sources, keywords, limit) => {
        seen = { sources, keywords, limit }
        return {}
      },
    }),
  )
  await createObserverStore({}).collect({ sources: ['rss'], keywords: ['mcp'], limit: 5 })
  assert.deepEqual(seen, { sources: ['rss'], keywords: ['mcp'], limit: 5 })
})

test('a failing source is reported per source, not fatal to the whole call', async () => {
  const { createObserverStore } = loadStoreWith(() =>
    fakeObserver({
      collectImpl: (sources) => {
        if (sources[0] === 'broken') throw new Error('network down')
        return { rss: [{ id: 'rss-1' }] }
      },
    }),
  )
  const store = createObserverStore({})

  const result = await store.collect({ sources: ['broken', 'rss'] })
  assert.equal(result.collected, 2, 'the failure is kept as an entry alongside the real hit')
  assert.equal(result.observations[0].source, 'broken')
  assert.match(result.observations[0].error, /network down/)
  assert.equal(result.observations[1].id, 'rss-1')
})

test('ferment resolves to the association result, not a promise', async () => {
  const { createObserverStore } = loadStoreWith(() =>
    fakeObserver({ clusters: [{ theme: 'agents', strength: 0.9 }] }),
  )
  const store = createObserverStore({})

  const result = await store.ferment({ session: 'morning' })
  assert.equal(result.session, 'morning', 'the session label reaches the engine')
  assert.equal(result.clusters.length, 1)
  assert.equal(
    typeof result.then,
    'undefined',
    'a promise here would serialize as {} at any synchronous boundary',
  )
})

test('collect and ferment say so when the optional package is missing', async () => {
  // Simulates the package being absent by making the require throw, which is
  // what happens on a machine where @akemi-mio/observer was never linked.
  const { createObserverStore } = loadStoreWith(() => {
    throw new Error("Cannot find module '@akemi-mio/observer'")
  })
  const store = createObserverStore({})

  await assert.rejects(() => store.collect({}), /not installed/)
  await assert.rejects(() => store.ferment({}), /not installed/)
})

test('callTool stays async so the MCP layer awaits both promises', () => {
  // collect/ferment now return promises. They only reach the client as real
  // values because callTool is async and awaits whatever a handler returns;
  // if that ever changes the tools silently regress to `{}` / `collected: 0`.
  const source = fs.readFileSync(MCP_PATH, 'utf8')
  assert.match(source, /async function callTool/)
  assert.match(source, /case 'mio\.observer\.collect':/)
  assert.match(source, /case 'mio\.observer\.ferment':/)
})
