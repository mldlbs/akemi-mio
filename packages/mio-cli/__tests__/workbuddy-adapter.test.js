'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mio-workbuddy-' + label + '-'))
}

test('workbuddy install writes host-qualified tool names and drops baked project context', () => {
  const configDir = tempDir('cfg')
  const workspace = tempDir('ws')
  process.env.WORKBUDDY_CONFIG_DIR = configDir
  const adapter = require('../adapters/workbuddy.js')

  try {
    assert.equal(adapter.isInstalled(), false)
    const result = adapter.install({
      node: process.execPath,
      serverScript: '/tmp/mio-server.js',
      home: '/tmp/mio-home',
      workspace,
    })
    assert.equal(result.changed, true)

    const config = JSON.parse(fs.readFileSync(path.join(configDir, 'mcp.json'), 'utf8'))
    const entry = config.mcpServers['mio-intelligence']
    assert.ok(entry, 'mio-intelligence entry written')
    assert.equal(entry.command, process.execPath)

    const context = JSON.parse(entry.env.MIO_CONTEXT)
    assert.equal(context.agentId, 'workbuddy')
    assert.equal(context.sessionId, 'workbuddy-session')
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

    const approvals = JSON.parse(fs.readFileSync(path.join(configDir, 'mcp-approvals.json'), 'utf8'))
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
    assert.equal(second.changed, false, 'rules already present -> no churn')
    assert.equal(adapter.isInstalled(), true)
  } finally {
    delete process.env.WORKBUDDY_CONFIG_DIR
  }
})
