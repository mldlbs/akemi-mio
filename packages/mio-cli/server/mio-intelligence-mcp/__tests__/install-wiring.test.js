'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { test } = require('node:test')

const {
  planAutoWiring,
  checkRegistryDrift,
  readRegistryServer,
  DRIFT_REASONS,
} = require('../../install-wiring.js')

// Fake adapter factory: `present` drives isHostPresent(), `wired` drives
// isInstalled(), `needsRepair` drives configNeedsRepair(). `installCalls`
// records invocations so tests can assert --auto touched the right hosts.
function fakeAdapter({ present = false, wired = false, needsRepair = false } = {}) {
  const calls = []
  return {
    calls,
    install() {
      calls.push('install')
      return { changed: !wired, configPath: '/tmp/host-config.json', message: 'installed' }
    },
    isHostPresent: () => present,
    isInstalled: () => wired,
    configNeedsRepair: () => needsRepair,
  }
}

test('planAutoWiring targets only present hosts and skips the rest', () => {
  const adapters = {
    codex: fakeAdapter({ present: true, wired: false }),
    opencode: fakeAdapter({ present: true, wired: false }),
    workbuddy: fakeAdapter({ present: false }),
  }
  const plan = planAutoWiring(adapters)
  assert.deepStrictEqual(plan.targets, ['codex', 'opencode'])
  assert.deepStrictEqual(plan.summary, { present: 2, wired: 0, skipped: 1 })
  // hosts[] must carry presence so the CLI can render "already wired" vs "wired now".
  assert.deepStrictEqual(
    plan.hosts.map((h) => ({ host: h.host, present: h.present, alreadyWired: h.alreadyWired })),
    [
      { host: 'codex', present: true, alreadyWired: false },
      { host: 'opencode', present: true, alreadyWired: false },
      { host: 'workbuddy', present: false, alreadyWired: false },
    ]
  )
})

test('planAutoWiring treats an already-wired host as present but not a target', () => {
  const plan = planAutoWiring({ codex: fakeAdapter({ present: true, wired: true }) })
  assert.deepStrictEqual(plan.targets, [])
  assert.deepStrictEqual(plan.summary, { present: 1, wired: 1, skipped: 0 })
})

test('planAutoWiring skips adapters without install() and survives a throwing probe', () => {
  const throwing = {
    install() {},
    isHostPresent() {
      throw new Error('probe blew up')
    },
    isInstalled: () => false,
  }
  const badShape = { isHostPresent: () => true }
  const plan = planAutoWiring({ codex: throwing, badShape, opencode: fakeAdapter({ present: true }) })
  assert.deepStrictEqual(plan.targets, ['opencode'])
  assert.deepStrictEqual(plan.summary, { present: 1, wired: 0, skipped: 1 })
})

test('checkRegistryDrift returns clean for a present+wired host with a valid manifest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-clean-'))
  try {
    fs.writeFileSync(
      path.join(dir, 'mcp-registry.json'),
      JSON.stringify({ version: 1, servers: [{ id: 'mio-control-plane', command: 'node' }] })
    )
    const { drifts, clean } = checkRegistryDrift(
      { codex: fakeAdapter({ present: true, wired: true }) },
      dir
    )
    assert.strictEqual(clean, true)
    assert.strictEqual(drifts.length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('checkRegistryDrift emits no duplicate host+reason pairs across hosts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-nodup-'))
  try {
    // 3 hosts, all present+wired, with a deliberately absent manifest. Each
    // must produce exactly one registry-level drift (not one per host) and no
    // other entry, and the whole set must be free of duplicate keys.
    const adapters = {
      codex: fakeAdapter({ present: true, wired: true }),
      opencode: fakeAdapter({ present: true, wired: true }),
      workbuddy: fakeAdapter({ present: true, wired: true }),
    }
    const { drifts } = checkRegistryDrift(adapters, dir)

    const registryLevel = drifts.filter((d) => d.host === null)
    assert.strictEqual(registryLevel.length, 1, `expected 1 registry-level drift, got ${JSON.stringify(drifts)}`)
    assert.strictEqual(registryLevel[0].reason, DRIFT_REASONS.REGISTRY_MISSING)

    // Duplicate-key contract: the same (host, reason) pair must never repeat.
    // This is what catches a regression that moves the registry push inside the
    // per-host loop -- it would emit one registry-missing per host.
    const keys = drifts.map((d) => `${d.host}|${d.reason}`)
    assert.strictEqual(new Set(keys).size, keys.length, `duplicate drift keys: ${keys.join(', ')}`)
    assert.strictEqual(drifts.length, 1, 'no host drift should appear when every host is wired')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('checkRegistryDrift ignores hosts that are not present, even when unwired', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-absent-'))
  try {
    fs.writeFileSync(
      path.join(dir, 'mcp-registry.json'),
      JSON.stringify({ servers: [{ id: 'mio-control-plane', command: 'node' }] })
    )
    const { drifts, clean } = checkRegistryDrift(
      { workbuddy: fakeAdapter({ present: false, wired: false }) },
      dir
    )
    assert.strictEqual(clean, true)
    assert.strictEqual(drifts.length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('checkRegistryDrift flags a wired host pointing at a stale server path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-stale-'))
  try {
    fs.writeFileSync(
      path.join(dir, 'mcp-registry.json'),
      JSON.stringify({ servers: [{ id: 'mio-control-plane', command: 'node' }] })
    )
    const { drifts } = checkRegistryDrift(
      { codex: fakeAdapter({ present: true, wired: true, needsRepair: true }) },
      dir,
      { expectedServerScript: '/opt/mio/server/index.js' }
    )
    assert.ok(
      drifts.some((d) => d.host === 'codex' && d.reason === DRIFT_REASONS.STALE_SERVER_PATH),
      `expected a stale-server-path drift for codex, got ${JSON.stringify(drifts)}`
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('checkRegistryDrift flags a present-but-unwired host as host-present-not-wired', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-unwired-'))
  try {
    fs.writeFileSync(
      path.join(dir, 'mcp-registry.json'),
      JSON.stringify({ servers: [{ id: 'mio-control-plane', command: 'node' }] })
    )
    const { drifts, clean } = checkRegistryDrift(
      { codex: fakeAdapter({ present: true, wired: false }) },
      dir
    )
    assert.strictEqual(clean, false)
    assert.ok(drifts.some((d) => d.reason === DRIFT_REASONS.NOT_WIRED && d.host === 'codex'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('readRegistryServer returns null for a missing or unparseable manifest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-read-'))
  try {
    assert.strictEqual(readRegistryServer(dir), null)
    fs.writeFileSync(path.join(dir, 'mcp-registry.json'), '{not json')
    assert.strictEqual(readRegistryServer(dir), null)
    fs.writeFileSync(
      path.join(dir, 'mcp-registry.json'),
      JSON.stringify({ servers: [{ id: 'other', command: 'x' }, { id: 'mio-control-plane', command: 'node' }] })
    )
    assert.strictEqual(readRegistryServer(dir).command, 'node', 'must prefer the control-plane entry')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('readRegistryServer falls back to the first server when no control-plane id exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-fallback-'))
  try {
    fs.writeFileSync(
      path.join(dir, 'mcp-registry.json'),
      JSON.stringify({ servers: [{ id: 'legacy', command: 'old' }] })
    )
    assert.strictEqual(readRegistryServer(dir).command, 'old')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
