#!/usr/bin/env node
'use strict'

// Syntax gate for mio-agent-runtime (`npm run check`, which prepack runs).
//
// This used to be a hand-written file list in package.json. That silently rotted:
// nine server modules -- including every store added later (policy, agent, task,
// query-log, llm-client, creativity-engine) -- were never syntax-checked, so a
// typo in any of them would have survived `npm run check` and only exploded at
// require time, i.e. inside the published package.
//
// So: discover files instead of listing them. New modules are covered
// automatically, and the gate can no longer fall behind the codebase.

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')

// Top-level dirs to walk. __tests__ is excluded: those are exercised by
// `node --test`, and a broken test file should fail the test run, not the
// package gate.
const INCLUDE_DIRS = ['bin', 'adapters', 'observe', 'server', 'scripts']
const EXCLUDE_DIRS = new Set(['node_modules', '__tests__', 'dist', 'out'])
const EXTENSIONS = new Set(['.js', '.cjs'])

function walk(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (_) {
    return out
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue
      walk(path.join(dir, entry.name), out)
    } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name))
    }
  }
  return out
}

const files = INCLUDE_DIRS.flatMap((dir) => walk(path.join(ROOT, dir))).sort()

if (files.length === 0) {
  console.error('check-syntax: no files discovered -- the gate is broken')
  process.exit(1)
}

const failures = []
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) {
    failures.push({ file, message: (result.stderr || '').trim().split('\n')[0] })
  }
}

const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/')
console.log(`checked ${files.length} file(s)`)

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL ${rel(failure.file)}: ${failure.message}`)
  }
  console.error(`\n${failures.length} file(s) failed syntax check`)
  process.exit(1)
}

console.log('all files parse')
