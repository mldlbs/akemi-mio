#!/usr/bin/env node
'use strict'

// Doc/implementation drift check for the mio CLI.
//
// The README lists every command. When commands are added or renamed in bulk the
// list is easy to leave behind, and a stale README is worse than none -- it sends
// people to commands that no longer exist. So: extract every `mio ...` from the
// README's command block and actually run it, then flag anything the CLI reports
// as unknown.
//
// Two rules learned the hard way:
//   - MIO_HOME is pointed at a temp dir so commands that write (init, install)
//     cannot touch the real home directory.
//   - Nothing here is skipped without being probed another way. `mio mcp` and
//     `mio observe` do not exit on their own, but `mcp` answers a stdio
//     handshake and exits on stdin EOF, and `observe --status` exits normally,
//     so both are still exercised (see probeSpecial below).

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { crashMarker } = require('./lib/crash-messages.cjs')

const REPO = path.resolve(__dirname, '..')
const CLI = path.join(REPO, 'packages', 'mio-cli', 'bin', 'mio.js')
const README = path.join(REPO, 'packages', 'mio-cli', 'README.md')

// Commands that never exit when spawned plainly, so they get a bespoke probe.
const NEVER_EXITS = new Set(['mcp', 'observe'])

// Extra arguments that let a side-effecting command be probed for real instead
// of being skipped.
//
// Skipping these is exactly how `mio observer collect` stayed broken for every
// caller: it died on a bad ObserverService constructor argument, and the only
// gate that would have executed it skipped it as "side effecting". A skipped
// gate is not a gate -- the README advertised a command that crashed on contact.
//
// With these arguments each one reaches its own code path and returns in about
// two seconds, without becoming a network client or a config mutator:
//   - an unknown source name makes collect return before fetching anything
//   - ferment only probes a localhost LLM and fails fast
//   - insight generate refuses with "needs context" before any LLM call
//   - config llm with no flags writes nothing and reports "Nothing to set"
//
// If a new side-effecting command shows up in the README, give it safe
// arguments here rather than adding it to a skip list.
const SAFE_ARGS = {
  'observer:collect': ['--sources', '__doc_gate_unknown_source__'],
  'observer:ferment': [],
  'config:llm': [],
  'insight:generate': [],
}

// A minimal MCP handshake. `mio mcp` reads stdin until EOF and then exits, so
// spawnSync can drive it without a wait-and-kill dance.
const MCP_HANDSHAKE =
  [
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'doc-gate', version: '1' } },
    }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  ].join('\n') + '\n'
const TIMEOUT_MS = 20000

// A command that hits the timeout is retried once with a much longer budget.
//
// `mio status` shells out to git and probes five host configs, so it lands
// around 4-7s on an idle machine -- inside the budget, but with little headroom.
// On a loaded machine it blew past 20s and the gate reported it as "does not
// exist", which is both wrong and the most misleading thing this gate can say:
// the command is fine, the budget was too tight. Retrying separates "slow" from
// "broken", and a genuine hang still fails on the second attempt.
const RETRY_TIMEOUT_MS = 120000

function readmeCommandBlock() {
  const text = fs.readFileSync(README, 'utf8')
  const match = text.match(/```text\r?\n([\s\S]*?)```/)
  if (!match) throw new Error('no ```text command block found in README')
  return match[1]
}

// A subcommand token is lowercase-ish and not a placeholder. This matters:
// descriptions like "List installed host adapters" start with a capital and must
// NOT be mistaken for a subcommand of `mio agents`.
function isSubToken(token) {
  return /^[a-z][a-z0-9-]*$/.test(token)
}

function parseCommands(block) {
  const out = []
  for (const line of block.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('mio ')) continue
    const tokens = trimmed.replace(/"/g, ' ').split(/\s+/).filter(Boolean)
    const command = tokens[1]
    if (!command || command.startsWith('-') || command.startsWith('<')) continue
    const maybeSub = tokens[2]
    const sub = maybeSub && isSubToken(maybeSub) ? maybeSub : null
    out.push({ raw: trimmed, command, sub })
  }
  return out
}

function isUnknown(output) {
  return output.includes('Unknown command') || (output.includes('Unknown ') && output.includes('subcommand:'))
}

// Probes a command that never exits on its own. Returns null when it behaved,
// or a message describing what went wrong.
function probeSpecial(command) {
  if (command === 'observe') {
    const r = spawnSync(process.execPath, [CLI, 'observe', '--status'], {
      encoding: 'utf8',
      env,
      timeout: TIMEOUT_MS,
    })
    if (r.error) return String(r.error.message || r.error)
    const out = `${r.stdout || ''}${r.stderr || ''}`
    if (isUnknown(out)) return 'mio observe --status reports an unknown command'
    return null
  }

  if (command === 'mcp') {
    const r = spawnSync(process.execPath, [CLI, 'mcp'], {
      encoding: 'utf8',
      env,
      timeout: TIMEOUT_MS,
      input: MCP_HANDSHAKE,
    })
    if (r.error) return String(r.error.message || r.error)
    const line = (r.stdout || '').split('\n').find((l) => l.trim().startsWith('{') && l.includes('"id":2'))
    if (!line) return 'mio mcp never answered tools/list'
    try {
      const tools = JSON.parse(line).result.tools
      if (!Array.isArray(tools) || tools.length === 0) return 'mio mcp offered no tools'
    } catch (err) {
      return 'mio mcp returned an unparseable tools/list: ' + err.message
    }
    return null
  }

  return null
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-doccheck-'))
const env = { ...process.env, MIO_HOME: home }

const commands = parseCommands(readmeCommandBlock())
const drift = []
const skipped = []
let checked = 0

for (const { raw, command, sub } of commands) {
  if (NEVER_EXITS.has(command)) {
    const problem = probeSpecial(command)
    if (problem) {
      drift.push({ raw, message: problem })
      continue
    }
    checked += 1
    continue
  }
  const safe = SAFE_ARGS[`${command}:${sub || ''}`]
  const args = [command, ...(sub ? [sub] : []), ...(safe || [])]
  const run = (timeout) =>
    spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env,
      timeout,
    })
  let result
  try {
    result = run(TIMEOUT_MS)
    // spawnSync does not throw on timeout; it sets `error` with code ETIMEDOUT.
    // Retry slowly before concluding anything: a command that is merely slow on
    // a loaded machine must not be reported as missing.
    if (result.error && result.error.code === 'ETIMEDOUT') {
      result = run(RETRY_TIMEOUT_MS)
    }
  } catch (err) {
    // spawnSync throws on timeout only when the child was killed; treat as drift
    // so a hanging command is reported rather than silently passing.
    drift.push({ raw, message: `timed out after ${RETRY_TIMEOUT_MS}ms` })
    continue
  }
  if (result.error) {
    const code = result.error.code
    drift.push({
      raw,
      message:
        code === 'ETIMEDOUT'
          ? `timed out after ${RETRY_TIMEOUT_MS}ms (twice) -- the command may hang`
          : String(result.error.message || result.error),
    })
    continue
  }
  checked += 1
  const output = `${result.stdout || ''}${result.stderr || ''}`
  if (isUnknown(output)) {
    // Prefer the line that actually says "Unknown ..."; the first line of the
    // output is usually the usage banner, which tells you nothing.
    const detail =
      output
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.includes('Unknown')) || output.trim().split('\n')[0]
    drift.push({ raw, message: detail })
    continue
  }

  // A command that exists can still be broken. This is what let
  // `mio observer collect` ship dead: the gate only asked "does the CLI know
  // this command?", never "does it work?", so a TypeError looked fine.
  const marker = crashMarker(output)
  if (marker) {
    drift.push({
      raw,
      message: `crashes instead of reporting a usage problem [${marker}]: ${output.trim().split('\n')[0].slice(0, 120)}`,
    })
  }
}

fs.rmSync(home, { recursive: true, force: true })

console.log(`README commands: ${commands.length} | probed: ${checked} | skipped: ${skipped.length}`)
if (skipped.length > 0) {
  for (const raw of skipped) console.log(`  skip ${raw}`)
}

if (drift.length > 0) {
  console.error(`\n${drift.length} command(s) in the README do not exist:`)
  for (const item of drift) console.error(`  - ${item.raw}\n      ${item.message}`)
  process.exit(1)
}

console.log('all README commands resolve')
