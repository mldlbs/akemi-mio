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

const MAX_ANNOTATIONS = 40
const TAIL_LINES = 30

function annotate(text) {
  // `%` must be escaped in the workflow-command format, otherwise a line
  // containing e.g. "50%" corrupts the annotation.
  return text.replace(/\r$/, '').replace(/%/g, '%25')
}

function emit(line) {
  process.stdout.write(`::error::${annotate(line)}\n`)
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
  // Every failing test name, so you can jump straight to it.
  for (const line of lines) {
    if (/^not ok /.test(line)) push(line)
  }
  // TAP diagnostics are multi-line YAML, so the stack and the expected/actual
  // values only exist in the tail. This is also what catches a crash that never
  // produced TAP at all (a stack trace, an npm error).
  push('----- last lines of output -----')
  for (const line of lines.slice(-TAIL_LINES)) push(line)

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
