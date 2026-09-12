'use strict'

// Integration test for mio.phase0.report format option (json / markdown).
// Env must be set before require.

const test = require('node:test')
const { after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-report-'))
process.env.MIO_DATA_DIR = dataDir
process.env.MIO_CONTEXT = JSON.stringify({
  agentId: 'codex',
  project: 'akemi-mio',
  workspace: 'D:/work/code/akemi-mio',
  sessionId: 'test-session',
})

const { callTool, rl } = require('../index.js')

test('phase0.report defaults to json structure', async () => {
  const result = await callTool('mio.phase0.report', { project: 'akemi-mio' })
  assert.equal(result.project, 'akemi-mio')
  assert.equal(result.status, 'not_started')
  assert.ok(Array.isArray(result.criteria))
  assert.ok(result.metrics)
})

test('phase0.report returns rendered markdown when format=markdown', async () => {
  const result = await callTool('mio.phase0.report', {
    project: 'akemi-mio',
    format: 'markdown',
  })
  assert.equal(result.format, 'markdown')
  assert.match(result.markdown, /# Mio Phase 0 Validation Report/)
  assert.match(result.markdown, /Status: \*\*not_started\*\*/)
  assert.ok(result.markdown.includes('Active hosts: 0/0'))
})

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
  rl.close()
})
