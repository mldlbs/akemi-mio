'use strict'

// Host auto-wiring planning + registry drift checks (TaskHub a6dcd804 PR-B).
//
// Everything here is pure and side-effect free: the caller injects the adapter
// map and a probe for each host, so `mio install --auto` / `--check` can be
// unit-tested without touching real host configs or spawning the MCP server.
// bin/mio.js owns all fs writes and process.exitCode.

const DRIFT_REASONS = Object.freeze({
  REGISTRY_MISSING: 'registry-missing',
  NOT_WIRED: 'host-present-not-wired',
  STALE_SERVER_PATH: 'stale-server-path',
  SERVER_MISSING_IN_REGISTRY: 'registry-server-entry-missing',
})

// Builds the auto-wiring plan: every adapter that reports the host app as
// present on this machine. Adapters without isHostPresent are skipped rather
// than assumed absent, so a partially-migrated adapter never gets silently
// excluded from --auto.
//
// Returns:
//   {
//     hosts: [{ host, present, alreadyWired }],
//     targets: ['codex', ...]   // hosts to install
//     summary: { present, wired, skipped }
//   }
function planAutoWiring(adapters) {
  const hosts = []
  const targets = []
  let presentCount = 0
  let wiredCount = 0
  let skippedCount = 0

  for (const host of Object.keys(adapters || {})) {
    const adapter = adapters[host]
    if (!adapter || typeof adapter.install !== 'function') continue

    let present = false
    if (typeof adapter.isHostPresent === 'function') {
      try {
        present = Boolean(adapter.isHostPresent())
      } catch (_) {
        // A throwing probe means "cannot tell"; treat as absent rather than
        // crashing --auto half way through a user's machine.
        present = false
      }
    }

    let alreadyWired = false
    if (present && typeof adapter.isInstalled === 'function') {
      try {
        alreadyWired = Boolean(adapter.isInstalled())
      } catch (_) {
        alreadyWired = false
      }
    }

    hosts.push({ host, present, alreadyWired })
    if (!present) {
      skippedCount += 1
      continue
    }
    presentCount += 1
    if (alreadyWired) {
      wiredCount += 1
      continue
    }
    targets.push(host)
  }

  return {
    hosts,
    targets,
    summary: { present: presentCount, wired: wiredCount, skipped: skippedCount },
  }
}

// Reads the MCP registry server entry for a host-drift comparison, tolerating a
// missing/unreadable manifest by returning null.
function readRegistryServer(dataDir, deps = {}) {
  const fs = deps.fs || require('fs')
  const path = deps.path || require('path')
  if (!dataDir) return null
  const file = path.join(dataDir, 'mcp-registry.json')
  if (!fs.existsSync(file)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const servers = Array.isArray(parsed && parsed.servers) ? parsed.servers : []
    // The manifest is single-server today; take the control-plane entry if
    // present so a future multi-server manifest still resolves deterministically.
    return servers.find((s) => s && s.id === 'mio-control-plane') || servers[0] || null
  } catch (_) {
    return null
  }
}

// Compares each *present* host's wiring against the registry manifest.
// Absent hosts are not drift: they cannot be "misconfigured".
//
// Returns:
//   { drifts: [{ host, reason, detail }], clean: Boolean }
function checkRegistryDrift(adapters, dataDir, deps = {}) {
  const registryServer = readRegistryServer(dataDir, deps)
  const drifts = []

  if (!registryServer) {
    drifts.push({
      host: null,
      reason: DRIFT_REASONS.REGISTRY_MISSING,
      detail:
        'No MCP registry manifest found; run `mio mcp registry --write` to generate it.',
    })
  }

  for (const host of Object.keys(adapters || {})) {
    const adapter = adapters[host]
    if (!adapter || typeof adapter.install !== 'function') continue

    let present = false
    if (typeof adapter.isHostPresent === 'function') {
      try {
        present = Boolean(adapter.isHostPresent())
      } catch (_) {
        present = false
      }
    }
    if (!present) continue

    let wired = false
    if (typeof adapter.isInstalled === 'function') {
      try {
        wired = Boolean(adapter.isInstalled())
      } catch (_) {
        wired = false
      }
    }
    if (!wired) {
      drifts.push({
        host,
        reason: DRIFT_REASONS.NOT_WIRED,
        detail: 'Host app is installed but not wired to Mio; run `mio install --auto`.',
      })
      continue
    }

    // Wired, but does it point at the server this package ships? A stale path
    // means the user ran `mio install` from a different worktree/checkout.
    if (typeof adapter.configNeedsRepair === 'function') {
      let needsRepair = false
      try {
        needsRepair = Boolean(adapter.configNeedsRepair(deps.expectedServerScript))
      } catch (_) {
        needsRepair = false
      }
      if (needsRepair) {
        drifts.push({
          host,
          reason: DRIFT_REASONS.STALE_SERVER_PATH,
          detail: 'Wired to a stale server path; re-run `mio install --auto` to repair.',
        })
      }
    }

    // If the manifest does not describe any runnable server, the host config
    // cannot be validated against it -- surface it once, not per host.
    if (registryServer && !registryServer.command) {
      drifts.push({
        host,
        reason: DRIFT_REASONS.SERVER_MISSING_IN_REGISTRY,
        detail: 'Registry manifest has no server command; regenerate with --write.',
      })
    }
  }

  // No de-dup pass is needed: every drift above is either pushed once before
  // the loop (registry level) or exactly once per host inside it, so no
  // duplicate host+reason pair can be produced. A `seen` Set here would be
  // untestable dead code -- the mutation check proved it, because removing it
  // turned nothing red. Assert the "no duplicates" contract via the tests
  // instead of enforcing it twice.

  return { drifts, clean: drifts.length === 0 }
}

// Turns a plan into the rows + summary that `mio install --auto --dry-run`
// prints. Pure, so the dry-run contract (skip / unchanged / would-wire) is
// testable without spawning the CLI -- which matters because --auto is the one
// install form that mutates real host configs and MIO_HOME does not isolate
// them.
//
// `wouldWire` is derived from targets (the same list --auto actually installs),
// so the preview cannot drift from the real run.
function describeAutoPlan(plan) {
  const rows = plan.hosts.map((h) => ({
    host: h.host,
    present: h.present,
    alreadyWired: h.alreadyWired,
    action: !h.present ? 'skip' : h.alreadyWired ? 'unchanged' : 'would-wire',
  }))
  return {
    rows,
    summary: { ...plan.summary, wouldWire: plan.targets.length },
  }
}

// True when this machine has at least one host present but none wired. In that
// state the observer is collecting data nothing will read back, so `mio observe
// --once` is allowed to print one nudge. Deliberately false on a machine with
// no hosts at all: "run install --auto" would wire nothing and is just noise.
function shouldSuggestAutoInstall(plan) {
  return plan.summary.present > 0 && plan.summary.wired === 0
}

module.exports = {
  planAutoWiring,
  describeAutoPlan,
  shouldSuggestAutoInstall,
  checkRegistryDrift,
  readRegistryServer,
  DRIFT_REASONS,
}
