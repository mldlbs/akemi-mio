'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const rootCli = path.join(repoRoot, 'cli', 'mio.js')
const canonicalCli = path.join(repoRoot, 'packages', 'mio-cli', 'bin', 'mio.js')
const rootMcp = path.join(repoRoot, 'server', 'mio-intelligence-mcp', 'index.js')
const canonicalMcp = path.join(
  repoRoot,
  'packages',
  'mio-cli',
  'server',
  'mio-intelligence-mcp',
  'index.js',
)
const rootPhase0 = path.join(repoRoot, 'server', 'mio-intelligence-mcp', 'phase0.js')
const canonicalPhase0 = path.join(
  repoRoot,
  'packages',
  'mio-cli',
  'server',
  'mio-intelligence-mcp',
  'phase0.js',
)

test('root CLI exposes the same help command as the canonical CLI', () => {
  const env = { ...process.env, MIO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'mio-cli-help-')) }
  const rootResult = spawnSync(process.execPath, [rootCli, '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
  })
  const canonicalResult = spawnSync(process.execPath, [canonicalCli, '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
  })

  assert.equal(rootResult.status, 0, rootResult.stderr)
  assert.equal(canonicalResult.status, 0, canonicalResult.stderr)
  assert.equal(rootResult.stdout, canonicalResult.stdout)
  assert.equal(rootResult.stderr, canonicalResult.stderr)
})

test('root MCP entry delegates to the canonical MCP module', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-mcp-entry-'))
  process.env.MIO_DATA_DIR = dataDir
  process.env.MIO_CONTEXT = JSON.stringify({
    agentId: 'compatibility-test',
    project: 'akemi-mio',
    workspace: repoRoot,
    sessionId: 'entry-point-convergence',
  })

  const rootModule = require(rootMcp)
  const canonicalModule = require(canonicalMcp)

  assert.deepEqual(Object.keys(rootModule).sort(), Object.keys(canonicalModule).sort())
  assert.strictEqual(rootModule.callTool, canonicalModule.callTool)
  assert.strictEqual(rootModule.handleMessage, canonicalModule.handleMessage)

  rootModule.rl.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('root Phase 0 entry delegates to the canonical module', () => {
  const rootModule = require(rootPhase0)
  const canonicalModule = require(canonicalPhase0)

  assert.deepEqual(Object.keys(rootModule).sort(), Object.keys(canonicalModule).sort())
  assert.strictEqual(rootModule.analyzePhase0, canonicalModule.analyzePhase0)
  assert.strictEqual(rootModule.loadPhase0, canonicalModule.loadPhase0)
})

for (const adapterName of ['codex', 'opencode', 'workbuddy']) {
  test(`root ${adapterName} adapter delegates to the canonical adapter`, () => {
    const rootAdapter = require(path.join(repoRoot, 'adapters', `${adapterName}.js`))
    const canonicalAdapter = require(
      path.join(repoRoot, 'packages', 'mio-cli', 'adapters', `${adapterName}.js`),
    )

    assert.deepEqual(Object.keys(rootAdapter).sort(), Object.keys(canonicalAdapter).sort())
    for (const key of Object.keys(canonicalAdapter)) {
      assert.strictEqual(rootAdapter[key], canonicalAdapter[key], `${adapterName}.${key}`)
    }
  })
}
