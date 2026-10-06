'use strict'

// codex adapter: ~/.codex/config.toml is resolved from os.homedir() with no
// env override (same trick as opencode-adapter.test.js), so homedir is
// patched on the shared os module object.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const adapter = require('../adapters/codex.js')

const SERVER_SECTION = '[mcp_servers.mio-intelligence]'
const ENV_SECTION = '[mcp_servers.mio-intelligence.env]'

function withHomedir(home, fn) {
  const real = os.homedir
  os.homedir = () => home
  try {
    return fn()
  } finally {
    os.homedir = real
  }
}

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-codex-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

const INSTALL_ARGS = { node: process.execPath, serverScript: '/srv/mio/server.js', home: '/srv/mio-home', workspace: '/srv/ws' }

test('install writes the mcp server section once and is detected afterwards', (t) => {
  const home = tempHome(t)
  withHomedir(home, () => {
    assert.equal(adapter.isInstalled(), false)

    const result = adapter.install(INSTALL_ARGS)
    assert.equal(result.changed, true)

    const config = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')
    assert.ok(config.includes(SERVER_SECTION))
    assert.ok(config.includes(ENV_SECTION))
    assert.ok(config.includes(`command = '${process.execPath}'`))
    assert.ok(config.includes(`args = ['${INSTALL_ARGS.serverScript}']`))
    assert.ok(config.includes(`MIO_DATA_DIR = '${INSTALL_ARGS.home}'`))
    const context = config.match(/MIO_CONTEXT = '(.+?)'/)
    assert.ok(context, 'MIO_CONTEXT written')
    assert.equal(JSON.parse(context[1].replace(/\\'/g, "'")).agentId, 'codex')
    assert.equal(adapter.isInstalled(), true)

    const second = adapter.install(INSTALL_ARGS)
    assert.equal(second.changed, false)
    assert.match(second.message, /already installed/)
  })
})

test('install is a no-op detection-wise when the config exists without our section', (t) => {
  const home = tempHome(t)
  withHomedir(home, () => {
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), "[mcp_servers.other]\ncommand = 'node'\n")
    assert.equal(adapter.isInstalled(), false)

    const result = adapter.install(INSTALL_ARGS)
    assert.equal(result.changed, true)
    const config = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')
    assert.ok(config.includes('[mcp_servers.other]'), 'unrelated sections preserved')
    assert.ok(config.includes(SERVER_SECTION))
    assert.equal((config.match(/\[mcp_servers\.mio-intelligence\]/g) || []).length, 1)
  })
})

test('a stale server path triggers repair with a backup, and the old section is replaced not duplicated', (t) => {
  const home = tempHome(t)
  withHomedir(home, () => {
    adapter.install(INSTALL_ARGS)

    // Simulate a legacy install that pointed at a different server copy.
    const cfgPath = path.join(home, '.codex', 'config.toml')
    const stale = fs.readFileSync(cfgPath, 'utf8').replace(/\/srv\/mio\/server\.js/g, '/old/worktree/server.js')
    fs.writeFileSync(cfgPath, stale)
    assert.equal(adapter.isInstalled(), true)

    const result = adapter.install({ ...INSTALL_ARGS, serverScript: '/srv/mio/server.js' })
    assert.equal(result.changed, true, 'stale path must be repaired')
    assert.ok(result.backup, 'backup path returned')
    assert.ok(fs.existsSync(result.backup), 'backup file exists')

    const config = fs.readFileSync(cfgPath, 'utf8')
    assert.ok(config.includes(`args = ['${INSTALL_ARGS.serverScript}']`), 'points at the shipped server')
    assert.ok(!config.includes('/old/worktree/server.js'), 'stale path gone')
    assert.equal((config.match(/\[mcp_servers\.mio-intelligence\]/g) || []).length, 1, 'section replaced, never duplicated')
    assert.equal(adapter.isInstalled(), true)
  })
})
