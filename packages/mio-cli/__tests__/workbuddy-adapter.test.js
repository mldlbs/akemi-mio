'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mio-workbuddy-' + label + '-'))
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

test('configCandidates prefers ~/.workbuddy-ai and keeps ~/.workbuddy as a fallback', () => {
  const home = tempDir('home')
  delete process.env.WORKBUDDY_CONFIG_DIR
  delete process.env.CODEBUDDY_CONFIG_DIR
  const adapter = require('../adapters/workbuddy.js')

  assert.deepEqual(
    adapter.configCandidates(home).map((p) => path.basename(p)),
    ['.workbuddy'],
    'neither root exists yet -> historical default so install can create it',
  )

  fs.mkdirSync(path.join(home, '.workbuddy'), { recursive: true })
  assert.deepEqual(adapter.configCandidates(home).map((p) => path.basename(p)), ['.workbuddy'])

  fs.mkdirSync(path.join(home, '.workbuddy-ai'), { recursive: true })
  assert.deepEqual(
    adapter.configCandidates(home).map((p) => path.basename(p)),
    ['.workbuddy-ai', '.workbuddy'],
    'upgraded machine: the root WorkBuddy 5.x actually reads comes first',
  )
})

test('workbuddy install writes host-qualified tool names, hooks, and drops baked context', () => {
  const configDir = tempDir('cfg')
  const workspace = tempDir('ws')
  process.env.WORKBUDDY_CONFIG_DIR = configDir
  const adapter = require('../adapters/workbuddy.js')

  // A pre-existing user hook must survive the merge -- the adapter owns only
  // its own entries, identified by the hook script name.
  const userHook = {
    hooks: {
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: "bash '/c/Users/me/hook.sh'" }] }],
    },
  }
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(userHook, null, 2))

  try {
    assert.equal(adapter.isInstalled(), false)
    const result = adapter.install({
      node: process.execPath,
      serverScript: '/tmp/mio-server.js',
      home: '/tmp/mio-home',
      workspace,
    })
    assert.equal(result.changed, true)

    const config = readJson(path.join(configDir, 'mcp.json'))
    const entry = config.mcpServers['mio-intelligence']
    assert.ok(entry, 'mio-intelligence entry written')
    assert.equal(entry.command, process.execPath)

    const context = JSON.parse(entry.env.MIO_CONTEXT)
    assert.equal(context.agentId, 'workbuddy')
    assert.ok(!('sessionId' in context), 'a baked session id would be shared by every future session')
    assert.ok(!('project' in context), 'context must not bake an install-time project')
    assert.ok(!('workspace' in context), 'context must not bake an install-time workspace')

    const userRules = fs.readFileSync(path.join(configDir, 'CODEBUDDY.md'), 'utf8')
    const projectRules = fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8')
    for (const rules of [userRules, projectRules]) {
      assert.ok(rules.includes('<!-- MIO_INTELLIGENCE_BEGIN -->'))
      assert.ok(rules.includes('mcp__mio-intelligence__mio.memory.query'))
      assert.ok(rules.includes('mcp__mio-intelligence__mio.observer.ingest'))
      assert.ok(rules.includes('mcp__mio-intelligence__mio.experience.reuse'))
      assert.ok(
        !rules.includes('mio-intelligence_mio.'),
        'WorkBuddy resolves tools as mcp__<server>__<tool>, so the bare prefix must not ship'
      )
    }

    const settings = readJson(path.join(configDir, 'settings.json'))
    for (const event of ['UserPromptSubmit', 'Stop', 'SessionEnd']) {
      const entries = settings.hooks[event]
      assert.ok(Array.isArray(entries) && entries.length > 0, `${event} hook registered`)
      const mio = entries.find((item) => item.hooks.some((h) => h.command.includes('workbuddy-hook.js')))
      assert.ok(mio, `${event} hook points at the Mio hook script`)
      assert.ok(mio.hooks[0].command.includes('workbuddy-hook.js'))
      assert.ok(mio.hooks[0].command.includes('/tmp/mio-home'), 'MIO_HOME is baked into the command')
    }
    assert.equal(
      settings.hooks.Stop.length,
      2,
      'the user hook is preserved next to the Mio hook instead of being overwritten'
    )
    assert.ok(
      settings.hooks.Stop.some((item) => item.hooks.some((h) => h.command.includes('hook.sh'))),
      'user hook survived'
    )

    const approvals = readJson(path.join(configDir, 'mcp-approvals.json'))
    assert.ok(
      approvals[adapter.approvalKey('mio-intelligence', entry)],
      'approval written; key covers command/args/env keys only, so the context rewrite keeps it valid'
    )
    assert.equal(adapter.isInstalled(), true)

    const second = adapter.install({
      node: process.execPath,
      serverScript: '/tmp/mio-server.js',
      home: '/tmp/mio-home',
      workspace,
    })
    assert.equal(second.changed, false, 'rules and hooks already present -> no churn')
    assert.equal(adapter.isInstalled(), true)
    assert.equal(
      readJson(path.join(configDir, 'settings.json')).hooks.Stop.length,
      2,
      're-install replaces the Mio entry instead of appending a duplicate'
    )
  } finally {
    delete process.env.WORKBUDDY_CONFIG_DIR
  }
})

test('an install from before hooks existed is reported incomplete so it gets repaired', () => {
  const configDir = tempDir('cfg')
  const workspace = tempDir('ws')
  process.env.WORKBUDDY_CONFIG_DIR = configDir
  const adapter = require('../adapters/workbuddy.js')

  try {
    adapter.install({
      node: process.execPath,
      serverScript: '/tmp/mio-server.js',
      home: '/tmp/mio-home',
      workspace,
    })
    assert.equal(adapter.isInstalled(), true)

    // Simulate the legacy state: settings.json without any Mio hook.
    fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ hooks: {} }, null, 2))
    assert.equal(adapter.hooksInstalled(), false)
    assert.equal(adapter.isInstalled(), false)

    const repair = adapter.install({
      node: process.execPath,
      serverScript: '/tmp/mio-server.js',
      home: '/tmp/mio-home',
      workspace,
    })
    assert.equal(repair.changed, true, 'repair writes the missing hooks')
    assert.equal(adapter.isInstalled(), true)
  } finally {
    delete process.env.WORKBUDDY_CONFIG_DIR
  }
})
