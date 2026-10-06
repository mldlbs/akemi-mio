'use strict'

// Tests for server/llm-client.js: config resolution order, key masking, isLlmConfigured

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const originalEnv = { ...process.env }

function resetEnv() {
  process.env = { ...originalEnv }
  delete process.env.MIO_HOME
  delete process.env.MIO_DATA_DIR
  delete process.env.LLM_API_URL
  delete process.env.LLM_KEY
  delete process.env.LLM_CHAT_MODEL
  delete process.env.LLM_MODEL
}

function writeConfig(dir, obj) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(obj, null, 2), 'utf8')
}

function loadLlmClient(mioHome) {
  delete require.cache[require.resolve('../server/llm-client.js')]
  process.env.MIO_HOME = mioHome
  return require('../server/llm-client.js')
}

function withCleanEnv(fn) {
  return () => {
    resetEnv()
    fn()
  }
}

test('config resolution: env > config.json > defaults', withCleanEnv(() => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-llm-test-'))
  const client = loadLlmClient(testDir)
  writeConfig(testDir, { llm: { apiUrl: 'file-url', apiKey: 'file-key', model: 'file-model' } })
  client.resetLlmConfigCache()

  let cfg = client.llmConfig()
  assert.equal(cfg.apiUrl, 'file-url')
  assert.equal(cfg.apiKey, 'file-key')
  assert.equal(cfg.model, 'file-model')

  process.env.LLM_API_URL = 'env-url'
  process.env.LLM_KEY = 'env-key'
  process.env.LLM_CHAT_MODEL = 'env-model'
  client.resetLlmConfigCache()
  cfg = client.llmConfig()
  assert.equal(cfg.apiUrl, 'env-url')
  assert.equal(cfg.apiKey, 'env-key')
  assert.equal(cfg.model, 'env-model')

  delete process.env.LLM_KEY
  delete process.env.LLM_CHAT_MODEL
  client.resetLlmConfigCache()
  cfg = client.llmConfig()
  assert.equal(cfg.apiUrl, 'env-url')
  assert.equal(cfg.apiKey, 'file-key')
  assert.equal(cfg.model, 'file-model')

  fs.rmSync(testDir, { recursive: true, force: true })
}))

test('config resolution: missing file falls back to defaults', withCleanEnv(() => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-llm-empty-'))
  const client = loadLlmClient(emptyDir)
  client.resetLlmConfigCache()

  const cfg = client.llmConfig()
  assert.equal(cfg.apiUrl, 'https://opencode.ai/zen/go/v1/chat/completions')
  assert.equal(cfg.model, 'deepseek-v4-flash')
  assert.equal(cfg.apiKey, '')
  fs.rmSync(emptyDir, { recursive: true, force: true })
}))

test('config resolution: malformed config.json degrades to defaults', withCleanEnv(() => {
  const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-llm-bad-'))
  fs.writeFileSync(path.join(badDir, 'config.json'), '{ not json', 'utf8')
  const client = loadLlmClient(badDir)
  client.resetLlmConfigCache()

  const cfg = client.llmConfig()
  assert.equal(cfg.apiUrl, 'https://opencode.ai/zen/go/v1/chat/completions')
  assert.equal(cfg.model, 'deepseek-v4-flash')
  fs.rmSync(badDir, { recursive: true, force: true })
}))

test('llmConfigSources reports source for each field', withCleanEnv(() => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-llm-src-'))
  const client = loadLlmClient(testDir)
  writeConfig(testDir, { llm: { apiUrl: 'file-url', apiKey: 'secret-key', model: 'file-model' } })
  client.resetLlmConfigCache()

  let sources = client.llmConfigSources()
  assert.equal(sources.apiUrl, 'config')
  assert.equal(sources.apiKey, 'config')
  assert.equal(sources.model, 'config')

  process.env.LLM_API_URL = 'env-url'
  process.env.LLM_KEY = 'env-secret'
  client.resetLlmConfigCache()
  sources = client.llmConfigSources()
  assert.equal(sources.apiUrl, 'env')
  assert.equal(sources.apiKey, 'env')
  assert.equal(sources.model, 'config')

  delete process.env.LLM_KEY
  client.resetLlmConfigCache()
  sources = client.llmConfigSources()
  assert.equal(sources.apiUrl, 'env')
  assert.equal(sources.apiKey, 'config')
  assert.equal(sources.model, 'config')

  fs.rmSync(testDir, { recursive: true, force: true })
}))

test('isLlmConfigured true when ANY field configured (env or file)', withCleanEnv(() => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-llm-cfg-'))
  const client = loadLlmClient(testDir)

  client.resetLlmConfigCache()
  assert.equal(client.isLlmConfigured(), false)

  process.env.LLM_API_URL = 'x'
  client.resetLlmConfigCache()
  assert.equal(client.isLlmConfigured(), true)

  process.env.LLM_KEY = 'k'
  process.env.LLM_CHAT_MODEL = 'm'
  client.resetLlmConfigCache()
  assert.equal(client.isLlmConfigured(), true)

  delete process.env.LLM_API_URL
  delete process.env.LLM_KEY
  delete process.env.LLM_CHAT_MODEL
  writeConfig(testDir, { llm: { apiUrl: 'u' } })
  client.resetLlmConfigCache()
  assert.equal(client.isLlmConfigured(), true)

  writeConfig(testDir, { llm: {} })
  client.resetLlmConfigCache()
  assert.equal(client.isLlmConfigured(), false)

  fs.rmSync(testDir, { recursive: true, force: true })
}))

test('homeDir prefers MIO_HOME over MIO_DATA_DIR', withCleanEnv(() => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-llm-home-'))
  process.env.MIO_HOME = testDir
  process.env.MIO_DATA_DIR = '/custom/data'
  const client = loadLlmClient(testDir)
  writeConfig(testDir, { llm: { apiUrl: 'from-home', apiKey: 'k', model: 'm' } })
  client.resetLlmConfigCache()
  const cfg = client.llmConfig()
  assert.equal(cfg.apiUrl, 'from-home')
  fs.rmSync(testDir, { recursive: true, force: true })
}))

// ── chatJson response handling ──

function stubFetchReturning(content) {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  })
  return { restore: () => { globalThis.fetch = original } }
}

test('chatJson parses a JSON answer into data', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-llm-json-'))
  const client = loadLlmClient(testDir)
  const stub = stubFetchReturning('{"title":"ok","novelty":70}')
  try {
    const out = await client.chatJson('go')
    assert.equal(out.error, undefined)
    assert.deepEqual(out.data, { title: 'ok', novelty: 70 })
  } finally {
    stub.restore()
    fs.rmSync(testDir, { recursive: true, force: true })
  }
})

test('chatJson strips a code fence before giving up on a JSON answer', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-llm-fence-'))
  const client = loadLlmClient(testDir)
  const stub = stubFetchReturning('```json\n{"title":"fenced"}\n```')
  try {
    const out = await client.chatJson('go')
    assert.deepEqual(out.data, { title: 'fenced' })
  } finally {
    stub.restore()
    fs.rmSync(testDir, { recursive: true, force: true })
  }
})

test('chatJson reports prose as an error instead of passing it off as data', async () => {
  // The old fallback returned { data: rawText }, so a non-JSON answer looked
  // like a successful parse to every truthy-`result.data` caller and landed
  // in the store as an untitled record.
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-llm-prose-'))
  const client = loadLlmClient(testDir)
  const stub = stubFetchReturning('Sure! Here is an analysis of the idea...')
  try {
    const out = await client.chatJson('go')
    assert.equal(out.data, undefined, 'no fake data')
    assert.match(out.error, /unparseable/)
    assert.match(out.raw, /Sure!/, 'the raw text is kept for diagnosis')
  } finally {
    stub.restore()
    fs.rmSync(testDir, { recursive: true, force: true })
  }
})

test('chatJson passes maxTokens through to the request body', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-llm-tok-'))
  const client = loadLlmClient(testDir)
  const original = globalThis.fetch
  let body = null
  globalThis.fetch = async (_url, opts) => {
    body = JSON.parse(opts.body)
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) }
  }
  try {
    await client.chatJson('go', { maxTokens: 900 })
    assert.equal(body.max_tokens, 900)
    assert.deepEqual(body.response_format, { type: 'json_object' })
  } finally {
    globalThis.fetch = original
    fs.rmSync(testDir, { recursive: true, force: true })
  }
})

test.after(resetEnv)