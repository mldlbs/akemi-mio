'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mio-opencode-' + label + '-'))
}

// The opencode adapter resolves everything from os.homedir() with no env
// override, so the test swaps it for a temp root and restores it after.
function withHomedir(home, fn) {
  const real = os.homedir
  os.homedir = () => home
  try {
    return fn()
  } finally {
    os.homedir = real
  }
}

const installArgs = {
  node: process.execPath,
  serverScript: '/tmp/mio-server.js',
  home: '/tmp/mio-home',
}

test('opencode install drops baked project context and pins cwd to the workspace', () => {
  const home = tempDir('home')
  withHomedir(home, () => {
    const adapter = require('../adapters/opencode.js')
    assert.equal(adapter.isInstalled(), false)

    const result = adapter.install(installArgs)
    assert.equal(result.configChanged, true)

    const config = JSON.parse(fs.readFileSync(adapter.configPath(), 'utf8'))
    const entry = config.mcp['mio-intelligence']
    assert.ok(entry, 'mio-intelligence entry written')
    assert.equal(entry.cwd, '.', 'server must spawn in the workspace so git project derivation works')

    const context = JSON.parse(entry.environment.MIO_CONTEXT)
    assert.equal(context.agentId, 'opencode')
    assert.equal(context.sessionId, 'opencode-session')
    assert.ok(!('project' in context), 'context must not bake an install-time project')
    assert.ok(!('workspace' in context), 'context must not bake an install-time workspace')

    const instructions = fs.readFileSync(adapter.globalInstructionsPath(), 'utf8')
    assert.ok(instructions.includes('<!-- MIO_INTELLIGENCE_BEGIN -->'))
    assert.ok(instructions.includes('mio-intelligence_mio_memory_query'))
    assert.equal(adapter.isInstalled(), true)

    // Clean config -> reinstall must not churn it.
    const again = adapter.install(installArgs)
    assert.equal(again.configChanged, false)
    assert.equal(adapter.isInstalled(), true)
  })
})

test('opencode install repairs a legacy context that baked project/workspace', () => {
  const home = tempDir('home')
  withHomedir(home, () => {
    const adapter = require('../adapters/opencode.js')
    adapter.install(installArgs)

    const configPath = adapter.configPath()
    const legacy = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    legacy.mcp['mio-intelligence'].environment.MIO_CONTEXT = JSON.stringify({
      agentId: 'opencode',
      project: 'package',
      workspace: 'D:\\work\\code\\demo\\package',
      sessionId: 'opencode-session',
    })
    fs.writeFileSync(configPath, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8')
    assert.equal(adapter.contextNeedsRepair(), true)

    const repaired = adapter.install(installArgs)
    assert.equal(repaired.configChanged, true, 'legacy context must be rewritten')

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const entry = config.mcp['mio-intelligence']
    const context = JSON.parse(entry.environment.MIO_CONTEXT)
    assert.equal(context.agentId, 'opencode')
    assert.ok(!('project' in context), 'stale install-time project must be gone')
    assert.ok(!('workspace' in context), 'stale install-time workspace must be gone')
    assert.equal(entry.cwd, '.')
    assert.equal(adapter.contextNeedsRepair(), false)
  })
})
