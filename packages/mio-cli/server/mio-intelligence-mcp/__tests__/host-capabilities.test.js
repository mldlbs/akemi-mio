'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-mcp-host-capabilities-'))
process.env.MIO_DATA_DIR = dataDir

const { TOOLS, callTool, rl } = require('../index.js')

test.after(() => { rl.close() })

test('mcp exposes host capabilities for desktop adapter plugins', async () => {
  assert.ok(TOOLS.some((tool) => tool.name === 'mio.host.capabilities'))

  const result = await callTool('mio.host.capabilities', {})

  assert.equal(result.schemaVersion, 1)
  assert.deepEqual(result.hosts.map((host) => host.name), ['codex', 'opencode', 'workbuddy', 'hermes', 'claude'])
  for (const host of result.hosts) {
    assert.equal(typeof host.installed, 'boolean')
    assert.ok(host.capabilities.includes('mcp-tools'))
    assert.ok(host.capabilities.includes('runtime-status'))
    assert.equal(host.mutationMode, 'host-capability')
  }
})
