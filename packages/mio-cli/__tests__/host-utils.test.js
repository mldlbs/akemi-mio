'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { earliestRunningSince } = require('../adapters/host-utils.js')

// Regression guard. earliestRunningSince() shells out to PowerShell to list
// running processes, and it used to call spawnSync with the default stdio --
// whose stdin is a pipe, which on Windows makes spawnSync fail with EBUSY
// before the child starts (status null, empty stderr). The helper swallows that
// with `if (res.error || res.status !== 0) return null`, so the probe looked
// like "the host app is not running" forever and the restart warning built on
// top of it never fired once. Nothing covered this file, which is how it stayed
// broken.
//
// The assertion is deterministic: this very process is a running `node`, so a
// fragment of our own executable path must match at least one process.
test('earliestRunningSince actually reaches the OS', () => {
  if (process.platform !== 'win32') {
    // By design: the helper returns null off Windows.
    assert.equal(earliestRunningSince('anything'), null)
    return
  }

  const fragment = path.basename(process.execPath)
  const since = earliestRunningSince(fragment)

  // Two branches on purpose. The first says the probe reached PowerShell at
  // all; without it a failure of the second would be indistinguishable from a
  // dead probe, and the message below would point at the wrong thing.
  assert.notEqual(
    since,
    null,
    `earliestRunningSince(${JSON.stringify(fragment)}) returned null, so the probe never reached ` +
      'PowerShell. The usual cause is spawnSync running with a piped stdin (see the stdio option ' +
      'in host-utils.js).'
  )
  assert.ok(
    Number.isFinite(since) && since > 0,
    `expected an epoch-ms timestamp, got ${since}`
  )
  assert.ok(
    since <= Date.now(),
    `a process cannot have started in the future (got ${since}, now ${Date.now()})`
  )
})
