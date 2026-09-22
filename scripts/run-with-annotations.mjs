#!/usr/bin/env node

// Run a command; if it fails, re-emit the useful part of its output as GitHub
// Actions annotations.
//
// Why this exists
// ---------------
// The vitest jobs get real annotations for free: vitest detects GitHub Actions
// and emits `::error::` lines itself, so a check-run annotation carries the
// actual assertion failure (`Cannot find module ...`, `expected 0 to be ...`).
//
// `node --test` -- which is what packages/mio-cli uses -- does not do that. So
// when `mio-agent-runtime tests` failed in CI, the only annotation on the whole
// job was:
//
//   "Process completed with exit code 1."
//
// and the real error sat in the job log, which on a public repo still requires
// admin rights to read (only check-run annotations are readable without auth).
// That makes the failure undiagnosable for anyone without admin access -- a
// gate you cannot read the failure of is only half a gate.
//
// Exit code contract: this wrapper is transparent -- it exits with the wrapped
// command's exit code, and with 2 only if the shell itself could not be started.
//
// Note what is NOT covered: a *missing command* is reported by the shell, not by
// spawnSync, so on Windows it comes back as cmd.exe's exit code 1 with
// result.error === null. That path cannot be separated from a genuine exit 1
// without parsing the shell's own message, which is localised and
// GBK-encoded on a Chinese Windows runner -- so it is deliberately not
// attempted. The contract above is what this script can actually guarantee.

import { spawnSync } from 'node:child_process'

const MAX_ANNOTATIONS = 50
const TAIL_LINES = 30
const MAX_DIAGNOSTIC_LINES_PER_FAILURE = 20

function annotate(text) {
  // `%` must be escaped in the workflow-command format, otherwise a line
  // containing e.g. "50%" corrupts the annotation.
  return text.replace(/\r$/, '').replace(/%/g, '%25')
}

function emit(line) {
  process.stdout.write(`::error::${annotate(line)}\n`)
}

// `node --test` writes each failing test's diagnostic block immediately *after*
// its `not ok` line, and the block is indented YAML (duration, location, error,
// expected, actual, code). Grabbing the global tail instead is what made the
// first real CI failure unreadable: the run had 386 tests and the failing one
// was #357, so the tail was entirely #385's output and the annotation said only
// "not ok 357 - digest respects topic filter" with no reason. The reason
// (`expected 1, actual 0`) lives in the block, not in the tail.
function tapFailureBlocks(lines) {
  const blocks = []
  for (let i = 0; i < lines.length; i++) {
    if (!/^not ok /.test(lines[i])) continue
    const block = [lines[i]]
    let j = i + 1
    while (j < lines.length && /^\s/.test(lines[j])) {
      block.push(lines[j])
      j++
    }
    blocks.push(block)
    i = j - 1
  }
  return blocks
}

function emitFailure(text) {
  const lines = text.split(/\r?\n/)
  const picked = []
  const seen = new Set()
  const push = (line) => {
    if (seen.has(line)) return
    seen.add(line)
    picked.push(line)
  }

  // TAP summary -- tells you instantly whether it was 1 failure or 300.
  for (const line of lines) {
    if (/^# (tests|pass|fail|cancelled|skipped)\b/.test(line)) push(line)
  }

  // The diagnostic block of every failure: this is where the assertion message,
  // the expected/actual values and the stack live.
  const blocks = tapFailureBlocks(lines)
  for (const block of blocks) {
    for (const line of block.slice(0, MAX_DIAGNOSTIC_LINES_PER_FAILURE)) push(line)
    if (block.length > MAX_DIAGNOSTIC_LINES_PER_FAILURE) {
      push(`... ${block.length - MAX_DIAGNOSTIC_LINES_PER_FAILURE} more diagnostic line(s) for this failure`)
    }
  }

  // The tail is the fallback for a command that never produced TAP at all: a
  // crash, an npm error, or one of the plain node check scripts. When TAP
  // blocks exist they are strictly more informative, so the budget goes to them.
  if (blocks.length === 0) {
    push('----- last lines of output -----')
    for (const line of lines.slice(-TAIL_LINES)) push(line)
  }

  for (const line of picked.slice(0, MAX_ANNOTATIONS)) emit(line)
  if (picked.length > MAX_ANNOTATIONS) {
    emit(`... ${picked.length - MAX_ANNOTATIONS} more line(s) omitted; see the job log`)
  }
}

const argv = process.argv.slice(2)
if (argv.length === 0) {
  console.error('usage: node scripts/run-with-annotations.mjs <command> [args...]')
  process.exit(2)
}

// The whole argv is joined into one command string and handed to a shell.
//
// Passing an args array instead would lose quoting: spawnSync joins args with
// spaces and does not re-quote them, so `node -e "console.log('x')"` arrives at
// the shell as `node -e console.log('x')` and blows up. A shell is needed on
// Windows anyway, because `npm` is `npm.cmd` and Node refuses to spawn `.cmd`
// without one.
const commandLine = argv.join(' ')
const result = spawnSync(commandLine, {
  shell: true,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  stdio: ['inherit', 'pipe', 'pipe'],
})

// Pass everything through so the job log stays complete.
process.stdout.write(result.stdout ?? '')
process.stderr.write(result.stderr ?? '')

if (result.error) {
  emit(`could not run \`${commandLine}\`: ${result.error.code ?? ''} ${result.error.message}`)
  process.exit(2)
}

if (result.signal) {
  emit(`\`${commandLine}\` was killed by signal ${result.signal}`)
  process.exit(1)
}

const status = result.status ?? 1
if (status !== 0) emitFailure(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
process.exit(status)
