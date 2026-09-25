'use strict'

// ObserverLlmService is where D2 lived: it hardcoded Ollama
// (localhost:11434 / qwen2.5:7b) and ignored the shared `mio config llm`
// settings, so the research pipeline produced empty shells even after the
// server-side LLM fix.
//
// This exercises the built package (packages/observer/dist), which CI produces
// with `npm run build --workspaces --if-present` before running these tests --
// the same order the real CLI relies on, since the CLI requires the package
// through its `main` field. Locally, build it first:
//   npx tsc -p packages/observer/tsconfig.json
//
// fetch is stubbed; nothing leaves the machine.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const pkg = require(path.resolve(__dirname, '..', '..', 'observer'))
const { ObserverLlmService } = pkg

const ENV = ['LLM_API_URL', 'LLM_KEY', 'LLM_CHAT_MODEL', 'LLM_MODEL', 'OBSERVER_LLM_API_URL', 'OBSERVER_OLLAMA_URL', 'OBSERVER_MODEL', 'OBSERVER_LLM_PROVIDER']

function clearEnv() {
  for (const key of ENV) delete process.env[key]
}

function stubFetch(handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return handler(url, options)
  }
  return {
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

function jsonResponse(body, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => JSON.stringify(body) }
}

test('an OpenAI-compatible endpoint is detected and used as-is', () => {
  clearEnv()
  const info = new ObserverLlmService({
    apiUrl: 'https://api.deepseek.com/v1/chat/completions',
    apiKey: 'sk-test',
    model: 'deepseek-flash',
  }).getInfo()

  assert.equal(info.provider, 'openai')
  assert.equal(info.apiUrl, 'https://api.deepseek.com/v1/chat/completions')
  assert.equal(info.model, 'deepseek-flash')
  assert.equal(info.hasApiKey, true)
})

test('a bare host:port is treated as Ollama', () => {
  clearEnv()
  const info = new ObserverLlmService({ apiUrl: 'http://localhost:11434', model: 'qwen2.5:7b' }).getInfo()
  assert.equal(info.provider, 'ollama')
  assert.equal(info.apiUrl, 'http://localhost:11434/api/chat')
})

test('a trailing /v1 is completed into a chat/completions URL', () => {
  clearEnv()
  const info = new ObserverLlmService({ apiUrl: 'https://gateway.test/v1', model: 'm' }).getInfo()
  assert.equal(info.provider, 'openai')
  assert.equal(info.apiUrl, 'https://gateway.test/v1/chat/completions')
})

test('legacy OBSERVER_* env vars still resolve to Ollama', () => {
  clearEnv()
  process.env.OBSERVER_OLLAMA_URL = 'http://ollama.internal:11434'
  process.env.OBSERVER_MODEL = 'qwen2.5:14b'
  const info = new ObserverLlmService().getInfo()
  assert.equal(info.provider, 'ollama')
  assert.equal(info.model, 'qwen2.5:14b')
  assert.equal(info.apiUrl, 'http://ollama.internal:11434/api/chat')
  clearEnv()
})

test('generic LLM_* env vars win over the legacy OBSERVER_* ones', () => {
  clearEnv()
  process.env.LLM_API_URL = 'https://api.deepseek.com/v1/chat/completions'
  process.env.LLM_CHAT_MODEL = 'deepseek-flash'
  process.env.OBSERVER_OLLAMA_URL = 'http://stale:11434'
  const info = new ObserverLlmService().getInfo()
  assert.equal(info.provider, 'openai')
  assert.equal(info.model, 'deepseek-flash')
  clearEnv()
})

test('generate sends an OpenAI body with the bearer key and parses choices[]', async () => {
  clearEnv()
  const stub = stubFetch(() => jsonResponse({ choices: [{ message: { content: 'hello' } }] }))
  try {
    const llm = new ObserverLlmService({
      apiUrl: 'https://api.deepseek.com/v1/chat/completions',
      apiKey: 'sk-test',
      model: 'deepseek-flash',
    })
    const out = await llm.generate('hi', { system: 'be terse', maxTokens: 100 })

    assert.equal(out.data, 'hello')
    assert.equal(stub.calls.length, 1, 'an OpenAI endpoint must not be probed first')
    const { url, options } = stub.calls[0]
    assert.equal(url, 'https://api.deepseek.com/v1/chat/completions')
    assert.equal(options.headers.Authorization, 'Bearer sk-test')
    const body = JSON.parse(options.body)
    assert.equal(body.model, 'deepseek-flash')
    assert.deepEqual(body.messages, [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ])
    assert.equal(body.max_tokens, 100)
  } finally {
    stub.restore()
  }
})

test('generate probes Ollama /api/tags then posts to /api/chat', async () => {
  clearEnv()
  const stub = stubFetch((url) => {
    if (url.endsWith('/api/tags')) return jsonResponse({ models: [{ name: 'qwen2.5:7b' }] })
    return jsonResponse({ message: { content: 'local answer' } })
  })
  try {
    const llm = new ObserverLlmService({ apiUrl: 'http://localhost:11434', model: 'qwen2.5:7b' })
    const out = await llm.generate('hi')

    assert.equal(out.data, 'local answer')
    assert.equal(stub.calls[0].url, 'http://localhost:11434/api/tags')
    assert.equal(stub.calls[1].url, 'http://localhost:11434/api/chat')
  } finally {
    stub.restore()
  }
})

test('a missing Ollama model fails generate instead of returning an empty string', async () => {
  clearEnv()
  const stub = stubFetch(() => jsonResponse({ models: [{ name: 'llama3:8b' }] }))
  try {
    const llm = new ObserverLlmService({ apiUrl: 'http://localhost:11434', model: 'qwen2.5:7b' })
    const out = await llm.generate('hi')
    assert.match(out.error, /不可用/)
    assert.equal(out.data, undefined)
  } finally {
    stub.restore()
  }
})
