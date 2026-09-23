'use strict'

// Tests for `mio host capabilities`. The capability table is static; `installed`
// is probed live from each adapter, so assertions must not depend on which hosts
// happen to be installed on this machine.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const CLI = path.join(repoRoot, 'packages', 'mio-cli', 'bin', 'mio.js')

function workspace() {
  const mioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-host-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-host-cwd-'))
  return { mioHome, cwd, env: { ...process.env, MIO_HOME: mioHome } }
}

function run(ws, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ws.cwd, encoding: 'utf8', env: ws.env })
}

function capabilitiesJson(ws) {
  const result = run(ws, ['host', 'capabilities', '--json'])
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('host capabilities lists every host with its capabilities', () => {
  // Calls the module directly rather than spawning the CLI: this asserts the
  // capability table itself, and spawning costs a full Node start plus a live
  // probe of all five adapters (seconds each on Windows). The CLI layer is
  // covered by the render/validation/agreement tests below.
  const { listHostCapabilities } = require('../server/host-capabilities.js')
  const result = listHostCapabilities()

  assert.equal(result.schemaVersion, 1)
  assert.ok(Array.isArray(result.hosts))
  assert.equal(result.hosts.length, 5)

  const names = result.hosts.map((h) => h.name).sort()
  assert.deepEqual(names, ['claude', 'codex', 'hermes', 'opencode', 'workbuddy'])

  for (const host of result.hosts) {
    assert.ok(Array.isArray(host.capabilities), `${host.name} has a capability list`)
    assert.ok(host.capabilities.length > 0, `${host.name} has at least one capability`)
    // Probed live, so only the type is stable across machines.
    assert.equal(typeof host.installed, 'boolean', `${host.name}.installed is a boolean`)
  }

  // Transcript-capable hosts are exactly the ones that expose observer-transcript.
  const withTranscript = result.hosts
    .filter((h) => h.capabilities.includes('observer-transcript'))
    .map((h) => h.name)
    .sort()
  assert.deepEqual(withTranscript, ['claude', 'hermes', 'workbuddy'])
})

test('host capabilities prints a readable table', () => {
  const ws = workspace()
  const result = run(ws, ['host', 'capabilities'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Host capabilities: 5 host\(s\)/)
  for (const name of ['codex', 'opencode', 'workbuddy', 'hermes', 'claude']) {
    assert.match(result.stdout, new RegExp(name))
  }
  assert.match(result.stdout, /mcp-tools/)
})

test('host subcommand validates its arguments', () => {
  const ws = workspace()

  const none = run(ws, ['host'])
  assert.equal(none.status, 1)
  assert.match(none.stdout, /Usage:/)

  const unknown = run(ws, ['host', 'bogus'])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /Unknown host subcommand: bogus/)
  // Naming the bad subcommand is not enough: with no usage block there is
  // nothing left to find the right one in. It goes to stderr, so stdout stays
  // empty and a `--json` caller never receives usage text where it expects JSON.
  assert.match(unknown.stderr, /Usage:/)
  assert.match(unknown.stderr, /mio host capabilities/)
  assert.equal(unknown.stdout, '')

  const help = run(ws, ['host', 'help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /mio host capabilities/)
})

test('the CLI and the shared host-capabilities module agree', () => {
  // Both the CLI and mio.host.capabilities call the same listHostCapabilities,
  // so the capability table can never drift between entry points.
  const { listHostCapabilities, HOST_CAPABILITIES } = require('../server/host-capabilities.js')
  const ws = workspace()

  const viaCli = capabilitiesJson(ws)
  assert.deepEqual(
    viaCli.hosts.map((h) => h.name),
    HOST_CAPABILITIES.map((h) => h.name),
    'host order and names match the static table'
  )

  const direct = listHostCapabilities()
  assert.deepEqual(
    viaCli.hosts.map((h) => ({
      name: h.name,
      capabilities: h.capabilities,
    })),
    direct.hosts.map((h) => ({ name: h.name, capabilities: h.capabilities })),
    'capability lists are identical to the direct call'
  )
})
