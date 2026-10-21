'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// These adapters resolve their target through os.homedir(). On Windows that is
// USERPROFILE (HOME is ignored), so the tests below repoint USERPROFILE at a
// temp dir instead of touching the real ~/.codex/config.toml. Getting this
// wrong is not theoretical: an earlier `install --auto` probe set only
// MIO_HOME and wrote the real config twice.
function withFakeHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-adapter-'))
  const prev = process.env.USERPROFILE
  process.env.USERPROFILE = home
  try {
    return fn(home)
  } finally {
    if (prev === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = prev
    fs.rmSync(home, { recursive: true, force: true })
  }
}

const INSTALL_OPTS = {
  node: '/usr/bin/node',
  serverScript: '/opt/mio/server/mio-intelligence-mcp/index.js',
  home: '/data/mio-home',
  workspace: '/work/project',
}

// A config with a foreign server block already in it, so stripping and
// re-appending are both exercised.
const SEED_TOML = [
  '[model]',
  'name = "gpt-5"',
  '',
  '[mcp_servers.other]',
  'command = "other-binary"',
  'args = ["--serve"]',
  '',
  '[projects.\'d:\\work\\demo\']',
  'trust_level = "trusted"',
  '',
].join('\n')

test('template-driven codex adapter is byte-identical to the hand-written one', () => {
  withFakeHome(() => {
    const handwritten = require('../adapters/codex.js')
    const { loadAdapter } = require('../adapters/loader.js')
    const templated = loadAdapter('codex')

    const cfg = path.join(os.homedir(), '.codex', 'config.toml')
    fs.mkdirSync(path.dirname(cfg), { recursive: true })

    fs.writeFileSync(cfg, SEED_TOML)
    const resultA = handwritten.install(INSTALL_OPTS)
    const bytesA = fs.readFileSync(cfg, 'utf8')

    fs.writeFileSync(cfg, SEED_TOML)
    const resultB = templated.install(INSTALL_OPTS)
    const bytesB = fs.readFileSync(cfg, 'utf8')

    assert.strictEqual(bytesB, bytesA, 'template output must match hand-written output byte for byte')
    assert.strictEqual(resultB.changed, resultA.changed)
    assert.strictEqual(resultB.configPath, resultA.configPath)
    // The message may carry a restart hint whose timing depends on whether the
    // host app is running, so only the stable prefix is compared.
    assert.ok(resultB.message.startsWith('Codex Mio MCP installed.'), resultB.message)
  })
})

test('template and hand-written codex agree on isInstalled / configNeedsRepair', () => {
  withFakeHome(() => {
    const handwritten = require('../adapters/codex.js')
    const templated = require('../adapters/loader.js').loadAdapter('codex')
    const cfg = path.join(os.homedir(), '.codex', 'config.toml')
    fs.mkdirSync(path.dirname(cfg), { recursive: true })

    // Before install: neither sees it.
    fs.writeFileSync(cfg, SEED_TOML)
    assert.strictEqual(templated.isInstalled(), handwritten.isInstalled())
    assert.strictEqual(templated.isInstalled(), false)

    // After install: both see it, and the template adapter wants no repair.
    // codex.js keeps configNeedsRepair internal, so only the template adapter's
    // behaviour is asserted here -- it must export it because the loader
    // contract (and `install --check`) depends on it.
    templated.install(INSTALL_OPTS)
    assert.strictEqual(templated.isInstalled(), true)
    assert.strictEqual(handwritten.isInstalled(), true)
    assert.strictEqual(templated.configNeedsRepair(INSTALL_OPTS.serverScript), false)

    // A different server path must be reported as stale.
    const stale = '/some/other/checkout/server/mio-intelligence-mcp/index.js'
    assert.strictEqual(templated.configNeedsRepair(stale), true)
  })
})

test('template-driven install is idempotent and preserves foreign blocks', () => {
  withFakeHome(() => {
    const templated = require('../adapters/loader.js').loadAdapter('codex')
    const cfg = path.join(os.homedir(), '.codex', 'config.toml')
    fs.mkdirSync(path.dirname(cfg), { recursive: true })
    fs.writeFileSync(cfg, SEED_TOML)

    const first = templated.install(INSTALL_OPTS)
    assert.strictEqual(first.changed, true)
    const afterFirst = fs.readFileSync(cfg, 'utf8')

    const second = templated.install(INSTALL_OPTS)
    assert.strictEqual(second.changed, false, 'second install must be a no-op')
    assert.strictEqual(fs.readFileSync(cfg, 'utf8'), afterFirst, 'no-op must not rewrite the file')

    assert.ok(afterFirst.includes('[mcp_servers.other]'), 'foreign server block must survive')
    assert.ok(afterFirst.includes("trust_level = \"trusted\""), 'unrelated tables must survive')
    assert.strictEqual(afterFirst.match(/\[mcp_servers\.mio-intelligence\]/g).length, 1)
  })
})

test('json template compiler writes and repairs a nested server entry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-json-tpl-'))
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-json-cfg-'))
  try {
    const cfg = path.join(cfgDir, 'host.json')
    fs.writeFileSync(
      path.join(dir, 'demo.template.json'),
      JSON.stringify({
        hostLabel: 'Demo',
        configPath: cfg.replace(/\\/g, '/'),
        format: 'json',
        mcpKey: 'mcp.servers.mio',
        serverShape: { command: '{{node}}', args: ['{{serverScript}}'], env: { MIO_DATA_DIR: '{{home}}' } },
      })
    )
    fs.writeFileSync(cfg, JSON.stringify({ mcp: { servers: { keepme: { command: 'x' } } } }, null, 2) + '\n')

    const adapter = require('../adapters/loader.js').loadAdapter('demo', dir)
    assert.strictEqual(adapter.isInstalled(), false)

    const res = adapter.install(INSTALL_OPTS)
    assert.strictEqual(res.changed, true)
    assert.strictEqual(adapter.isInstalled(), true)

    const written = JSON.parse(fs.readFileSync(cfg, 'utf8'))
    assert.deepStrictEqual(written.mcp.servers.mio, {
      command: '/usr/bin/node',
      args: ['/opt/mio/server/mio-intelligence-mcp/index.js'],
      env: { MIO_DATA_DIR: '/data/mio-home' },
    })
    assert.ok(written.mcp.servers.keepme, 'sibling entries must survive')

    assert.strictEqual(adapter.configNeedsRepair(INSTALL_OPTS.serverScript), false)
    assert.strictEqual(adapter.configNeedsRepair('/elsewhere/index.js'), true)
    assert.strictEqual(adapter.install(INSTALL_OPTS).changed, false, 'second install must be a no-op')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(cfgDir, { recursive: true, force: true })
  }
})

test('loader falls back to the hand-written module when no template exists', () => {
  const { loadAdapter, listTemplateHosts } = require('../adapters/loader.js')
  const templated = listTemplateHosts()
  assert.ok(templated.includes('codex'), `expected codex template, got ${templated.join(', ')}`)

  // workbuddy has no template yet, so it must come from workbuddy.js unchanged.
  const workbuddy = loadAdapter('workbuddy')
  assert.strictEqual(typeof workbuddy.install, 'function')
  assert.strictEqual(typeof workbuddy.isHostPresent, 'function')
  assert.strictEqual(typeof workbuddy.isInstalled, 'function')
})

test('a malformed template fails loudly instead of silently falling back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-bad-tpl-'))
  try {
    fs.writeFileSync(path.join(dir, 'broken.template.json'), '{ not json')
    assert.throws(
      () => require('../adapters/loader.js').loadAdapter('broken', dir),
      /invalid template/
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an unsupported format is rejected rather than guessed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-fmt-tpl-'))
  try {
    fs.writeFileSync(
      path.join(dir, 'weird.template.json'),
      JSON.stringify({ configPath: '/tmp/x', format: 'yaml', mcpKey: 'a' })
    )
    assert.throws(
      () => require('../adapters/loader.js').loadAdapter('weird', dir),
      /unsupported format/
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
