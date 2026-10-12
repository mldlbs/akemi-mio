'use strict'

// Integration test for the mio.mechanism.* tools (registry, promote, rollback).
// Env must be set before require so MIO_DATA_DIR is the temp directory.

const test = require('node:test')
const { after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-mechanism-'))
process.env.MIO_DATA_DIR = dataDir
process.env.MIO_CONTEXT = JSON.stringify({
  agentId: 'codex',
  project: 'akemi-mio',
  workspace: 'D:/work/code/akemi-mio',
  sessionId: 'test-session',
})

const { callTool, TOOLS, rl } = require('../index.js')
const { mechanismRegistry, mechanismPromote, mechanismRollback, resetRegistryCache } = require('../../mechanism-registry.js')

after(() => {
  if (rl && typeof rl.close === 'function') rl.close()
})

test('mio.mechanism.* tools are registered in TOOLS', () => {
  const names = TOOLS.filter((t) => t.name.startsWith('mio.mechanism')).map((t) => t.name)
  assert.deepEqual(names, ['mio.mechanism.registry', 'mio.mechanism.promote', 'mio.mechanism.rollback'])
})

test('registry returns empty state for a fresh data dir', async () => {
  resetRegistryCache()
  const r = await callTool('mio.mechanism.registry', {})
  assert.equal(r.versions.length, 0)
  assert.equal(r.requests.length, 0)
})

test('promote submit with gateOverride creates a pending request', async () => {
  resetRegistryCache()
  const r = await callTool('mio.mechanism.promote', {
    action: 'submit',
    mechanismId: 'm-1',
    version: 1,
    submittedBy: 'agent-a',
    experimentRunIds: ['run-1', 'run-2', 'run-3'],
    gateOverride: { allowed: true, reason: 'manual gate' },
  })
  assert.equal(r.ok, true)
  assert.equal(r.request.id, 'pr-1')
  assert.equal(r.request.approvalStatus, 'pending')
  assert.equal(r.request.submittedBy, 'agent-a')
})

test('promote submit with no override and too few runs is blocked by the gate', async () => {
  resetRegistryCache()
  const r = await callTool('mio.mechanism.promote', {
    action: 'submit',
    mechanismId: 'm-gate',
    version: 1,
    submittedBy: 'agent-a',
    experimentRunIds: ['run-1', 'run-2'],
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'below_min_samples')
})

test('promote approve by a different agent succeeds (A5)', async () => {
  resetRegistryCache()
  const r = await callTool('mio.mechanism.promote', {
    action: 'approve',
    requestId: 'pr-1',
    approvedBy: 'agent-b',
  })
  assert.equal(r.ok, true)
  assert.equal(r.request.approvalStatus, 'approved')
  assert.equal(r.request.approvedBy, 'agent-b')
})

test('promote approve by the submitter is rejected (self-approval forbidden)', async () => {
  resetRegistryCache()
  await callTool('mio.mechanism.promote', {
    action: 'submit',
    mechanismId: 'm-2',
    version: 1,
    submittedBy: 'solo',
    gateOverride: { allowed: true, reason: 'ok' },
  })
  const r = await callTool('mio.mechanism.promote', {
    action: 'approve',
    requestId: 'pr-2',
    approvedBy: 'solo',
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'self_approval_forbidden')
})

test('promote reject marks the request rejected', async () => {
  resetRegistryCache()
  await callTool('mio.mechanism.promote', {
    action: 'submit',
    mechanismId: 'm-3',
    version: 1,
    submittedBy: 'agent-a',
    gateOverride: { allowed: true, reason: 'ok' },
  })
  const r = await callTool('mio.mechanism.promote', {
    action: 'reject',
    requestId: 'pr-3',
    approvedBy: 'reviewer',
    reason: 'insufficient evidence',
  })
  assert.equal(r.ok, true)
  assert.equal(r.request.approvalStatus, 'rejected')
})

test('registry filters by status', async () => {
  resetRegistryCache()
  await callTool('mio.mechanism.promote', {
    action: 'submit',
    mechanismId: 'm-filter',
    version: 1,
    submittedBy: 'agent-a',
    gateOverride: { allowed: true, reason: 'ok' },
  })
  const pending = await callTool('mio.mechanism.registry', { status: 'pending' })
  assert.ok(pending.requests.length >= 1)
  assert.ok(pending.requests.some((r) => r.mechanismId === 'm-filter' && r.approvalStatus === 'pending'))
})

test('rollback with no active version fails cleanly', async () => {
  resetRegistryCache()
  const r = await callTool('mio.mechanism.rollback', { mechanismId: 'nope' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no_active_version')
})

test('mechanism-registry module exposes the four shared functions', () => {
  assert.equal(typeof mechanismRegistry, 'function')
  assert.equal(typeof mechanismPromote, 'function')
  assert.equal(typeof mechanismRollback, 'function')
})

test('CLI command path: mechanismCommand is wired into the switch', () => {
  // Smoke: the CLI entry file contains the mechanism case.
  const cliPath = path.join(__dirname, '..', '..', '..', 'bin', 'mio.js')
  const src = fs.readFileSync(cliPath, 'utf8')
  assert.ok(src.includes("case 'mechanism':"))
  assert.ok(src.includes('mechanismCommand(args, useJson)'))
  assert.ok(src.includes('mechanismUsage'))
})
