'use strict'

// mio.observer.pipeline is the terminal/MCP entry point for the observer
// research DAG. Before it existed, runPipeline/tickPipeline/forcePipeline had no
// caller anywhere in mio-agent-runtime, so the trend/research/insight stages
// never ran (D1).
//
// It is also where the D2 fix is observable: the store must hand the resolved
// shared LLM config (server/llm-client.js) to the ObserverService constructor,
// and must pass nothing when the user never configured an LLM -- otherwise an
// existing local-Ollama setup would be silently redirected to the hosted
// default.
//
// Nothing here touches the network: the observer package is injected as a fake
// via Module._load, exactly like observer-async.test.js.

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

const STORE_PATH = path.resolve(__dirname, '..', 'server', 'observer-store.js')
const OBSERVER_FALLBACK = path.resolve(__dirname, '..', '..', 'observer')
const llmClient = require(path.resolve(__dirname, '..', 'server', 'llm-client.js'))

const LLM_ENV = ['LLM_API_URL', 'LLM_KEY', 'LLM_CHAT_MODEL', 'LLM_MODEL', 'OBSERVER_LLM_API_URL', 'OBSERVER_OLLAMA_URL', 'OBSERVER_MODEL', 'OBSERVER_LLM_PROVIDER']

function resetEnv() {
  for (const key of LLM_ENV) delete process.env[key]
  process.env.MIO_HOME = path.join(os.tmpdir(), `mio-pipeline-home-${process.pid}`)
  llmClient.resetLlmConfigCache()
}

// Loads a fresh store with a fake @akemi-mio/observer. The fallback to
// packages/observer is blocked so "not installed" is genuinely simulated.
function loadStoreWith(fake) {
  delete require.cache[STORE_PATH]
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === '@akemi-mio/observer') return fake
    if (path.resolve(request) === OBSERVER_FALLBACK) throw new Error("Cannot find module '@akemi-mio/observer'")
    return originalLoad.apply(this, [request, parent, isMain])
  }
  try {
    // eslint-disable-next-line global-require
    return require(STORE_PATH)
  } finally {
    Module._load = originalLoad
  }
}

// Records the constructor arguments for both services. The pipeline preview
// must NOT construct ObserverService (it would mkdir the dag directory), but
// MAY construct ObserverLlmService to report the resolved endpoint.
function recordingFake(opts = {}) {
  const calls = { service: [], llm: [], pipeline: [] }
  const fake = {
    ObserverStore: function ObserverStore() {},
    ObserverLlmService: class {
      constructor(config) {
        calls.llm.push(config)
      }
      getInfo() {
        return { provider: 'openai', model: 'test-model', apiUrl: 'https://example.test/v1/chat/completions', hasApiKey: true }
      }
    },
    ObserverService: class {
      constructor(baseDir, llmConfig) {
        calls.service.push([baseDir, llmConfig])
      }
      async forcePipeline(mode) {
        calls.pipeline.push(mode)
        return opts.envelope === null
          ? null
          : opts.envelope || {
              type: 'daily_research',
              dagState: { taskId: 'dag_20260925', state: 'COMPLETED' },
              payload: { id: 'insight-1', topic: 'test topic', sections: [{}, {}, {}] },
              metadata: { taskDurationMs: 123, llmCalls: 5 },
            }
      }
      async collectBySource() {
        return {}
      }
      getFermentation() {
        return { async ferment() { return {} } }
      }
    },
  }
  return { fake, calls }
}

test('pipeline previews by default: no service constructed, no network', async () => {
  resetEnv()
  const { fake, calls } = recordingFake()
  const { createObserverStore } = loadStoreWith(fake)
  const store = createObserverStore({ baseDir: path.join(os.tmpdir(), 'mio-pipeline-preview') })

  const result = await store.pipeline({})

  assert.equal(result.dryRun, true)
  assert.equal(result.mode, 'analytical')
  assert.equal(result.observerAvailable, true)
  assert.equal(calls.service.length, 0, 'the preview must not construct ObserverService')
  assert.match(result.hint, /--run/)
})

test('pipeline injects the shared LLM config when one is configured', async () => {
  resetEnv()
  process.env.LLM_API_URL = 'https://api.deepseek.com/v1/chat/completions'
  process.env.LLM_KEY = 'sk-test'
  process.env.LLM_CHAT_MODEL = 'deepseek-flash'
  const { fake, calls } = recordingFake()
  const { createObserverStore } = loadStoreWith(fake)
  const store = createObserverStore({ baseDir: path.join(os.tmpdir(), 'mio-pipeline-llm') })

  const result = await store.pipeline({ run: true })

  assert.deepEqual(calls.service[0][1], {
    apiUrl: 'https://api.deepseek.com/v1/chat/completions',
    apiKey: 'sk-test',
    model: 'deepseek-flash',
  })
  assert.equal(calls.service[0][0], path.join(os.tmpdir(), 'mio-pipeline-llm'))
  assert.equal(result.completed, true)
})

test('pipeline with no configured LLM passes nothing, preserving the Ollama fallback', async () => {
  resetEnv()
  const { fake, calls } = recordingFake()
  const { createObserverStore } = loadStoreWith(fake)
  const store = createObserverStore({ baseDir: path.join(os.tmpdir(), 'mio-pipeline-noconfig') })

  await store.pipeline({ run: true })

  assert.equal(calls.service[0][1], undefined, 'an unconfigured LLM must fall through to the observer defaults')
})

test('pipeline --run forwards the mode and summarizes the envelope', async () => {
  resetEnv()
  const { fake, calls } = recordingFake()
  const { createObserverStore } = loadStoreWith(fake)
  const store = createObserverStore({ baseDir: path.join(os.tmpdir(), 'mio-pipeline-run') })

  const result = await store.pipeline({ run: true, mode: 'creative' })

  assert.deepEqual(calls.pipeline, ['creative'])
  assert.equal(result.ran, true)
  assert.equal(result.completed, true)
  assert.equal(result.topic, 'test topic')
  assert.equal(result.sections, 3)
  assert.equal(result.llmCalls, 5)
})

test('pipeline reports a null envelope as incomplete instead of throwing', async () => {
  resetEnv()
  const { fake } = recordingFake({ envelope: null })
  const { createObserverStore } = loadStoreWith(fake)
  const store = createObserverStore({ baseDir: path.join(os.tmpdir(), 'mio-pipeline-null') })

  const result = await store.pipeline({ run: true })

  assert.equal(result.ran, true)
  assert.equal(result.completed, false)
  assert.match(result.reason, /null/)
})

test('pipeline preview survives an older observer package without getInfo', async () => {
  resetEnv()
  // The published @akemi-mio/observer can lag this CLI and have no getInfo().
  // A preview must degrade to "llm: null" rather than throwing on version skew.
  const fake = {
    ObserverStore: function ObserverStore() {},
    ObserverLlmService: class {
      constructor() {}
    },
    ObserverService: class {},
  }
  const { createObserverStore } = loadStoreWith(fake)
  const result = await createObserverStore({ baseDir: path.join(os.tmpdir(), 'mio-pipeline-old-pkg') }).pipeline({})

  assert.equal(result.dryRun, true)
  assert.equal(result.llm, null)
})

test('pipeline says so when the optional package is missing', async () => {
  resetEnv()
  const { createObserverStore } = loadStoreWith({
    get ObserverService() {
      throw new Error("Cannot find module '@akemi-mio/observer'")
    },
  })
  const store = createObserverStore({})
  await assert.rejects(() => store.pipeline({}), /not installed/)
})

test('collect and ferment also receive the resolved LLM config (D2)', async () => {
  resetEnv()
  process.env.LLM_CHAT_MODEL = 'deepseek-flash'
  process.env.LLM_API_URL = 'https://api.deepseek.com/v1/chat/completions'
  const { fake, calls } = recordingFake()
  const { createObserverStore } = loadStoreWith(fake)
  const store = createObserverStore({})

  await store.collect({ sources: ['rss'] })
  await store.ferment({ session: 'morning' })

  assert.equal(calls.service.length, 2)
  for (const [, config] of calls.service) {
    assert.equal(config.model, 'deepseek-flash')
    assert.equal(config.apiUrl, 'https://api.deepseek.com/v1/chat/completions')
  }
})
