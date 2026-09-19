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
//   - `mio mcp` (stdio server) and `mio observe` (foreground watcher) never exit,
//     so they are skipped rather than waited on. Every spawn has a timeout anyway.
//   - MIO_HOME is pointed at a temp dir so commands that write (init, install)
//     cannot touch the real home directory.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const REPO = path.resolve(__dirname, '..')
const CLI = path.join(REPO, 'packages', 'mio-cli', 'bin', 'mio.js')
const README = path.join(REPO, 'packages', 'mio-cli', 'README.md')

// Commands that start a server / run forever, so they cannot be probed.
const NON_EXITING = new Set(['mcp', 'observe'])

// Commands that exist but must not be *executed* by a doc linter: collect hits
// external sources over the network, ferment calls an LLM, and `config llm`
// writes to config.json. Probing them here would turn `npm run check:cli-docs`
// into a network client or a config mutator. Their existence is pinned by
// mio-cli's own tests instead (observer-command.test.js, config-command.test.js).
//
// (In practice the linter only replays `mio <command> <sub>` and drops the
// flags, so `config llm` would just print usage — but its whole purpose is
// writing state, so it does not belong in a probe list at all.)
const SIDE_EFFECTING = new Set(['observer:collect', 'observer:ferment', 'config:llm'])
const TIMEOUT_MS = 20000

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
  return (
    output.includes('Unknown command') ||
    (output.includes('Unknown ') && output.includes('subcommand:'))
  )
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-doccheck-'))
const env = { ...process.env, MIO_HOME: home }

const commands = parseCommands(readmeCommandBlock())
const drift = []
const skipped = []
let checked = 0

for (const { raw, command, sub } of commands) {
  if (NON_EXITING.has(command)) {
    skipped.push(`(never exits): ${raw}`)
    continue
  }
  if (sub && SIDE_EFFECTING.has(`${command}:${sub}`)) {
    skipped.push(`(side effecting): ${raw}`)
    continue
  }
  const args = sub ? [command, sub] : [command]
  let result
  try {
    result = spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env,
      timeout: TIMEOUT_MS,
    })
  } catch (err) {
    // spawnSync throws on timeout only when the child was killed; treat as drift
    // so a hanging command is reported rather than silently passing.
    drift.push({ raw, message: `timed out after ${TIMEOUT_MS}ms` })
    continue
  }
  if (result.error) {
    drift.push({ raw, message: String(result.error.message || result.error) })
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
