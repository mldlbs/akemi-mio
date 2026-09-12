'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-mcp-evolution-status-'))
process.env.MIO_DATA_DIR = dataDir
process.env.MIO_CONTEXT = JSON.stringify({
  agentId: 'codex',
  project: 'test-evolution-status',
  workspace: '/tmp/test',
  sessionId: 'test-evolution-status',
})

const { TOOLS, callTool, rl } = require('../index.js')

test.after(() => { rl.close() })

test('mcp exposes evolution status tool backed by runtime modules', async () => {
  assert.ok(TOOLS.some((tool) => tool.name === 'mio.evolution.status'))

  const status = await callTool('mio.evolution.status', {})

  assert.equal(status.runtime, 'mio-agent-runtime')
  assert.equal(status.modules.length, 7)
  assert.deepEqual(status.modules.map((module) => module.name), [
    '@akemi-mio/runtime-contracts',
    '@akemi-mio/runtime-foundation',
    '@akemi-mio/experience-memory',
    '@akemi-mio/evolution-learning',
    '@akemi-mio/evolution-strategy',
    '@akemi-mio/evolution-safety',
    '@akemi-mio/evolution-scheduler',
  ])
  assert.ok(status.modules.every((module) => module.loaded === true))
  assert.ok(status.modules.every((module) => module.healthy === true))
})
