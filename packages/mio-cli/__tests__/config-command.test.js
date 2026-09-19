'use strict'

// Tests for `mio config`. The point of this command is that LLM settings
// survive beyond a shell session, so the assertions here are mostly about the
// *resolution order*: environment variables must beat config.json, and
// config.json must beat the built-in defaults. A regression that flips that
// order would silently send calls to the wrong endpoint.
//
// Every case runs against a throwaway MIO_HOME, so nothing touches the real
// ~/.mio-intelligence and no test can clobber a developer's own config.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const CLI = path.join(repoRoot, 'packages', 'mio-cli', 'bin', 'mio.js')
const LLM_CLIENT = path.join(repoRoot, 'packages', 'mio-cli', 'server', 'llm-client.js')

// Build a clean environment: an isolated MIO_HOME and no inherited LLM_* vars,
// so the "env wins" cases can set exactly one variable and mean it.
function workspace(label) {
  const mioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-cfg-' + label + '-'))
  const env = { ...process.env, MIO_HOME: mioHome }
  delete env.LLM_API_URL
  delete env.LLM_KEY
  delete env.LLM_CHAT_MODEL
  delete env.LLM_MODEL
  return { mioHome, env }
}

function run(ws, args, envOverride) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...ws.env, ...(envOverride || {}) },
  })
}

function runJson(ws, args, envOverride) {
  const res = run(ws, ['--json', ...args], envOverride)
  return { res, json: JSON.parse(res.stdout) }
}

function readStoredConfig(ws) {
  return JSON.parse(fs.readFileSync(path.join(ws.mioHome, 'config.json'), 'utf8'))
}

// Exercise llmConfig() in-process so the resolution order is asserted against
// the real consumer, not just against what `config show` chooses to print.
function resolveInProcess(ws, envOverride) {
  const script = `
    const c = require(${JSON.stringify(LLM_CLIENT)})
    console.log(JSON.stringify({
      config: c.llmConfig(),
      configured: c.isLlmConfigured(),
      sources: c.llmConfigSources(),
    }))
  `
  const res = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...ws.env, ...(envOverride || {}) },
  })
  assert.equal(res.status, 0, `in-process probe failed: ${res.stderr}`)
  return JSON.parse(res.stdout)
}

const DEFAULT_URL = 'https://opencode.ai/zen/go/v1/chat/completions'
const DEFAULT_MODEL = 'deepseek-v4-flash'

test('config show on a fresh home reports the built-in defaults', () => {
  const ws = workspace('fresh')
  const { json } = runJson(ws, ['config', 'show'])

  assert.equal(json.llm.effective.apiUrl, DEFAULT_URL)
  assert.equal(json.llm.effective.model, DEFAULT_MODEL)
  assert.equal(json.llm.effective.hasApiKey, false)
  assert.equal(json.llm.configured, false)
  assert.equal(json.llm.sources.apiUrl, 'default')
  assert.equal(json.llm.sources.model, 'default')
  assert.equal(json.llm.sources.apiKey, 'unset')
})

test('config llm writes the values into config.json', () => {
  const ws = workspace('write')
  const res = run(ws, [
    'config',
    'llm',
    '--url',
    'http://localhost:11434/v1/chat/completions',
    '--model',
    'qwen2.5:14b',
    '--key',
    'sk-test-abcd1234efgh',
  ])
  assert.equal(res.status, 0, res.stderr)

  const stored = readStoredConfig(ws)
  assert.deepEqual(stored.llm, {
    apiUrl: 'http://localhost:11434/v1/chat/completions',
    apiKey: 'sk-test-abcd1234efgh',
    model: 'qwen2.5:14b',
  })
  // Pre-existing keys must survive: `mio install` writes `agents` into the same
  // file, and a config write that dropped them would uninstall every adapter.
  assert.equal(stored.version, 1)
  assert.ok(stored.agents)
})

test('stored config is picked up by llmConfig()', () => {
  const ws = workspace('readback')
  run(ws, ['config', 'llm', '--url', 'http://example.test/v1/chat/completions', '--model', 'my-model'])

  const { config, configured, sources } = resolveInProcess(ws)
  assert.equal(config.apiUrl, 'http://example.test/v1/chat/completions')
  assert.equal(config.model, 'my-model')
  assert.equal(configured, true)
  assert.equal(sources.apiUrl, 'config')
  assert.equal(sources.model, 'config')
})

test('environment variables win over config.json', () => {
  const ws = workspace('precedence')
  run(ws, ['config', 'llm', '--url', 'http://from-file.test/v1/chat/completions', '--model', 'file-model'])

  const { config, sources } = resolveInProcess(ws, {
    LLM_API_URL: 'http://from-env.test/v1/chat/completions',
    LLM_CHAT_MODEL: 'env-model',
  })

  assert.equal(config.apiUrl, 'http://from-env.test/v1/chat/completions')
  assert.equal(config.model, 'env-model')
  assert.equal(sources.apiUrl, 'env')
  assert.equal(sources.model, 'env')
})

test('LLM_MODEL is the fallback for LLM_CHAT_MODEL', () => {
  const ws = workspace('model-fallback')
  const { config } = resolveInProcess(ws, { LLM_MODEL: 'legacy-model' })
  assert.equal(config.model, 'legacy-model')
})

test('config show flags when an env var shadows the stored config', () => {
  const ws = workspace('shadow')
  run(ws, ['config', 'llm', '--url', 'http://from-file.test/v1/chat/completions'])

  const res = run(ws, ['config', 'show'], { LLM_API_URL: 'http://from-env.test/v1/chat/completions' })
  assert.equal(res.status, 0)
  assert.match(res.stdout, /overrides part of this/)
})

test('config show masks the stored key', () => {
  const ws = workspace('mask')
  run(ws, ['config', 'llm', '--key', 'sk-supersecretvalue123'])

  const res = run(ws, ['config', 'show'])
  assert.doesNotMatch(res.stdout, /supersecretvalue123/)
  assert.match(res.stdout, /sk-s/)

  const { json } = runJson(ws, ['config', 'show'])
  assert.doesNotMatch(json.llm.effective.apiKey, /supersecretvalue123/)
  assert.equal(json.llm.effective.hasApiKey, true)
})

test('a short key is fully masked, never partially revealed', () => {
  const ws = workspace('short-key')
  run(ws, ['config', 'llm', '--key', 'abc123'])

  const res = run(ws, ['config', 'show'])
  assert.doesNotMatch(res.stdout, /abc123/)
  assert.match(res.stdout, /\*{6}/)
})

test('config llm --clear removes the stored block but keeps the rest', () => {
  const ws = workspace('clear')
  run(ws, ['config', 'llm', '--url', 'http://example.test/v1/chat/completions', '--model', 'm'])
  run(ws, ['config', 'llm', '--clear'])

  const stored = readStoredConfig(ws)
  assert.equal(stored.llm, undefined)
  assert.equal(stored.version, 1)

  const { configured, config } = resolveInProcess(ws)
  assert.equal(configured, false)
  assert.equal(config.apiUrl, DEFAULT_URL)
})

test('partial updates leave the other fields alone', () => {
  const ws = workspace('partial')
  run(ws, ['config', 'llm', '--url', 'http://a.test/v1/chat/completions', '--model', 'model-a', '--key', 'k1'])
  run(ws, ['config', 'llm', '--model', 'model-b'])

  const stored = readStoredConfig(ws)
  assert.equal(stored.llm.apiUrl, 'http://a.test/v1/chat/completions')
  assert.equal(stored.llm.apiKey, 'k1')
  assert.equal(stored.llm.model, 'model-b')
})

test('a malformed URL is rejected before anything is written', () => {
  const ws = workspace('badurl')
  const res = run(ws, ['config', 'llm', '--url', 'not a url'])

  assert.equal(res.status, 1)
  assert.match(res.stderr, /--url must be a valid URL/)
  assert.equal(fs.existsSync(path.join(ws.mioHome, 'config.json')), false)
})

test('a non-http(s) scheme is rejected', () => {
  const ws = workspace('scheme')
  const res = run(ws, ['config', 'llm', '--url', 'ftp://example.test/x'])

  assert.equal(res.status, 1)
  assert.match(res.stderr, /--url must be http\(s\)/)
})

test('config llm with no flags explains itself and fails', () => {
  const ws = workspace('noflags')
  const res = run(ws, ['config', 'llm'])

  assert.equal(res.status, 1)
  assert.match(res.stderr, /Nothing to set/)
})

test('an unknown subcommand lists the valid ones', () => {
  const ws = workspace('unknown')
  const res = run(ws, ['config', 'bogus'])

  assert.equal(res.status, 1)
  assert.match(res.stderr, /Usage: mio config/)
})

test('config path prints the config file location', () => {
  const ws = workspace('path')
  const res = run(ws, ['config', 'path'])

  assert.equal(res.status, 0)
  assert.equal(res.stdout.trim(), path.join(ws.mioHome, 'config.json'))
})

test('config show tolerates a corrupt config.json', () => {
  const ws = workspace('corrupt')
  fs.writeFileSync(path.join(ws.mioHome, 'config.json'), '{ not json', 'utf8')

  const res = run(ws, ['config', 'show'])
  assert.equal(res.status, 0, 'a corrupt config must not crash the CLI')
  assert.match(res.stdout, /built-in default/)

  // And a write must repair rather than propagate the corruption.
  const write = run(ws, ['config', 'llm', '--model', 'repaired-model'])
  assert.equal(write.status, 0)
  const stored = readStoredConfig(ws)
  assert.equal(stored.llm.model, 'repaired-model')
})

test('mio help lists the config command', () => {
  const ws = workspace('help')
  const res = run(ws, ['help'])

  assert.match(res.stdout, /mio config show/)
  assert.match(res.stdout, /mio config llm/)
})
