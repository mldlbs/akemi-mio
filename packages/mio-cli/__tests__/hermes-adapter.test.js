'use strict'

// hermes adapter: hermes.js destructures spawnSync at module load, so the
// fakes must be installed on the shared child_process object BEFORE the
// fresh require (same trick as observer-opencode-spawns.test.js). HERMES_HOME
// and HERMES_BIN env vars isolate every filesystem/binary probe; os.homedir
// is patched too because the legacy candidate path reads it directly.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const HERMES_PATH = require.resolve('../adapters/hermes.js')

function tempDir(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-hermes-' + label + '-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function makeFakeSpawn(cfgPath) {
  const fake = (command, args) => {
    fake.calls.push({ command, args })
    if (command === 'where') return { status: 1, stdout: '', stderr: '' }
    if (args && args[0] === 'mcp' && args[1] === 'add') {
      fs.writeFileSync(
        cfgPath,
        ['mcp_servers:', '  mio-intelligence:', '    command: node', '    env:', '      MIO_DATA_DIR: /srv/mio-home', ''].join('\n'),
        'utf8',
      )
      return { status: 0, stdout: '', stderr: '' }
    }
    if (args && args[0] === 'mcp' && args[1] === 'remove') {
      if (fs.existsSync(cfgPath)) fs.writeFileSync(cfgPath, 'mcp_servers: {}\n', 'utf8')
      return { status: 0, stdout: '', stderr: '' }
    }
    return { status: 1, stdout: '', stderr: 'unexpected spawn: ' + command + ' ' + (args || []).join(' ') }
  }
  fake.calls = []
  return fake
}

function loadHermes(fakeSpawnSync) {
  const cp = require('child_process')
  const realSpawnSync = cp.spawnSync
  cp.spawnSync = fakeSpawnSync
  try {
    delete require.cache[HERMES_PATH]
    // eslint-disable-next-line global-require
    return require(HERMES_PATH)
  } finally {
    cp.spawnSync = realSpawnSync
  }
}

function setup(t, { withBin = true } = {}) {
  const home = tempDir(t, 'home')
  const realHomedir = os.homedir
  os.homedir = () => home
  const prevHome = process.env.HERMES_HOME
  const prevBin = process.env.HERMES_BIN
  process.env.HERMES_HOME = home
  if (withBin) {
    const bin = path.join(home, 'hermes.exe')
    fs.writeFileSync(bin, 'stub')
    process.env.HERMES_BIN = bin
  } else {
    delete process.env.HERMES_BIN
  }
  const cfgPath = path.join(home, 'config.yaml')
  const fake = makeFakeSpawn(cfgPath)
  const hermes = loadHermes(fake)
  t.after(() => {
    os.homedir = realHomedir
    if (prevHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = prevHome
    if (prevBin === undefined) delete process.env.HERMES_BIN
    else process.env.HERMES_BIN = prevBin
    delete require.cache[HERMES_PATH]
  })
  return { home, cfgPath, fake, hermes }
}

test('hermesBin prefers HERMES_BIN and falls back to null when nothing exists', (t) => {
  const { home, hermes } = setup(t)
  assert.equal(hermes.hermesBin(), process.env.HERMES_BIN)

  delete process.env.HERMES_BIN
  const empty = tempDir(t, 'empty')
  process.env.HERMES_HOME = empty
  os.homedir = () => empty
  assert.equal(hermes.hermesBin(), null, 'no candidate under an empty home')
  void home
})

test('isInstalled anchors on the YAML key, not a bare path mention', (t) => {
  const { cfgPath, hermes } = setup(t)

  assert.equal(hermes.isInstalled(), false, 'no config file')

  fs.writeFileSync(cfgPath, 'mcp_servers:\n  other:\n    command: node\n    args: ["/x/server/mio-intelligence-mcp/index.js"]\n')
  assert.equal(hermes.isInstalled(), false, 'a config that merely mentions the server path is not installed')

  fs.writeFileSync(cfgPath, 'mcp_servers:\n  mio-intelligence:\n    command: node\n')
  assert.equal(hermes.isInstalled(), true)
})

test('install runs mcp add through the resolved bin and is idempotent afterwards', (t) => {
  const { fake, hermes } = setup(t)

  const first = hermes.install({
    node: process.execPath,
    serverScript: '/srv/mio/server.js',
    home: '/srv/mio-home',
    workspace: '/srv/ws',
    project: 'akemi-mio',
  })
  assert.equal(first.changed, true)
  assert.match(first.message, /installed/)
  const addCall = fake.calls.find((c) => c.args && c.args[0] === 'mcp' && c.args[1] === 'add')
  assert.ok(addCall, 'mcp add invoked')
  assert.deepEqual(addCall.args.slice(0, 3), ['mcp', 'add', 'mio-intelligence'])
  assert.ok(addCall.args.includes('--env'), '--env precedes --args (Hermes swallows trailing flags otherwise)')
  assert.ok(addCall.args.indexOf('--env') < addCall.args.indexOf('--args'))
  assert.ok(addCall.args.some((a) => String(a).startsWith('MIO_DATA_DIR=/srv/mio-home')))
  assert.ok(addCall.args.some((a) => String(a).startsWith('MIO_CONTEXT=') && JSON.parse(String(a).slice('MIO_CONTEXT='.length)).agentId === 'hermes'))
  assert.equal(hermes.isInstalled(), true)

  const second = hermes.install({ node: process.execPath, serverScript: '/srv/mio/server.js', home: '/srv/mio-home' })
  assert.equal(second.changed, false)
  assert.match(second.message, /already installed/)
  const addCount = fake.calls.filter((c) => c.args && c.args[1] === 'add').length
  assert.equal(addCount, 1, 'no second add when already installed')
})

test('legacy arg-style env entries trigger a remove + add repair', (t) => {
  const { cfgPath, fake, hermes } = setup(t)
  fs.writeFileSync(
    cfgPath,
    ['mcp_servers:', '  mio-intelligence:', '    args:', '      - MIO_DATA_DIR=/old/home', '      - MIO_CONTEXT={}', ''].join('\n'),
    'utf8',
  )
  assert.equal(hermes.isInstalled(), true)

  const result = hermes.install({ node: process.execPath, serverScript: '/srv/mio/server.js', home: '/srv/mio-home' })
  assert.equal(result.changed, true, 'legacy env style must be repaired')
  const sequence = fake.calls.filter((c) => c.args && c.args[0] === 'mcp').map((c) => c.args[1])
  assert.deepEqual(sequence, ['remove', 'add'], 'repair removes the stale registration before re-adding')

  const config = fs.readFileSync(cfgPath, 'utf8')
  assert.ok(!/- MIO_DATA_DIR=/.test(config), 'legacy plain-args env entries gone')
  assert.equal(hermes.isInstalled(), true)
})

test('install refuses without a resolvable hermes binary', (t) => {
  const { fake, hermes } = setup(t, { withBin: false })
  process.env.HERMES_HOME = path.join(os.tmpdir(), 'mio-hermes-none-' + process.pid)
  os.homedir = () => path.join(os.tmpdir(), 'mio-hermes-none-' + process.pid)

  const result = hermes.install({ node: process.execPath, serverScript: '/srv/mio/server.js', home: '/srv/mio-home' })
  assert.equal(result.changed, false)
  assert.match(result.message, /binary not found/)
  assert.equal(fake.calls.length, 1, 'only the PATH probe runs, never mcp add')
  assert.equal(fake.calls[0].command, 'where')
})

test('a failing mcp add surfaces as a thrown error, not a silent success', (t) => {
  const { fake, hermes } = setup(t)
  const failing = (command, args) => {
    if (args && args[0] === 'mcp' && args[1] === 'add') {
      fake.calls.push({ command, args })
      return { status: 2, stdout: '', stderr: 'boom' }
    }
    return fake(command, args)
  }
  const hermes2 = loadHermes(failing)
  assert.throws(
    () => hermes2.install({ node: process.execPath, serverScript: '/srv/mio/server.js', home: '/srv/mio-home' }),
    /exited 2/,
  )
  void hermes
})
