'use strict'

// Regression guard for projectFromDirName() in observe/observer.js.
//
// Hosts that munge a timestamped workspace path into a project-directory name
// end it with a numeric segment:
//
//   C:\Users\me\WorkBuddy\2026-08-27-17-37-10
//     -> directory name: c-Users-me-WorkBuddy-2026-08-27-17-37-10
//     -> split('-').pop(): "10"          <-- the *seconds* field
//
// The function is supposed to detect that and fall back to the whole directory
// name. The guard was written /^\\d+$/ instead of /^\d+$/, and since the former
// matches "a literal backslash followed by the letter d" -- never a digit -- it
// could not fire. Every such session was filed under a colliding 2-digit
// project bucket ("10", "46", ...) that recall never resolves to, because
// queries resolve the project from the current repo/dir.
//
// The bug survived several releases because *nothing tested this function*.
// /^\\d+$/ vs /^\d+$/ is a one-character difference that reads as correct, so
// the assertions below deliberately include a raw character-code check: if
// someone re-introduces the double backslash, the behavioural cases would
// already fail, but this makes the reason unmistakable in the failure output.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const OBSERVER_PATH = path.resolve(__dirname, '..', 'observe', 'observer.js')
const { projectFromDirName } = require(OBSERVER_PATH)

// ── the guard must actually be able to fire ────────────────────────────────

test('the numeric-segment guard uses a single-backslash \\d (not \\\\d)', () => {
  const src = fs.readFileSync(OBSERVER_PATH, 'utf8')
  const line = src
    .split('\n')
    .find((l) => l.includes('parts[parts.length - 1]') && l.includes('.test('))
  assert.ok(line, 'the guard line must still exist in observe/observer.js')

  const literal = line.match(/\/\^[^/]*\$\//)
  assert.ok(literal, 'could not find the regex literal on the guard line')

  // 47='/', 94='^', then the escape(s), 100='d', 43='+', 36='$', 47='/'
  const codes = [...literal[0]].map((c) => c.charCodeAt(0))
  assert.deepEqual(
    codes,
    [47, 94, 92, 100, 43, 36, 47],
    `expected /^\\d+$/ (codes 47,94,92,100,43,36,47) but got ${JSON.stringify(literal[0])} ` +
      `(codes ${codes.join(',')}) -- a doubled backslash makes the guard dead code`
  )

  // And prove the regex itself behaves, so this is not just a spelling check.
  const re = new RegExp(literal[0].slice(1, -1))
  assert.equal(re.test('46'), true, 'the guard must match a pure-numeric segment')
  assert.equal(re.test('10'), true)
  assert.equal(re.test('douyin_store'), false, 'the guard must not match a real name')
})

// ── behaviour: timestamped dirs keep their full name ───────────────────────

test('a trailing numeric segment falls back to the full directory name', () => {
  const dirs = [
    'c-Users-me-WorkBuddy-2026-08-27-17-37-10',
    'c-Users-me-WorkBuddy-2026-09-18-17-13-46',
    'd-work-code-project-07',
  ]
  for (const dir of dirs) {
    assert.equal(projectFromDirName(dir), dir, `${dir} must not collapse to its numeric tail`)
  }
})

test('the seconds field is never used as a project name', () => {
  // The exact failure reported in the wild: "46" and "10" as project values.
  assert.notEqual(projectFromDirName('c-Users-me-WorkBuddy-2026-09-18-17-13-46'), '46')
  assert.notEqual(projectFromDirName('c-Users-me-WorkBuddy-2026-08-27-17-37-10'), '10')
})

// ── behaviour: the intended shortening still works ─────────────────────────

test('a dashed path still shortens to its last meaningful segment', () => {
  assert.equal(projectFromDirName('d-work-code-douyin_store'), 'douyin_store')
  assert.equal(projectFromDirName('d-work-code-akemi-mio'), 'mio')
  assert.equal(projectFromDirName('d-work-code-sub2api'), 'sub2api')
})

// ── edges ──────────────────────────────────────────────────────────────────

test('a single-segment name is returned unchanged', () => {
  assert.equal(projectFromDirName('sub2api'), 'sub2api')
  assert.equal(projectFromDirName('mio'), 'mio')
})

test('empty / missing input falls back to unknown', () => {
  assert.equal(projectFromDirName(''), 'unknown')
  assert.equal(projectFromDirName(null), 'unknown')
  assert.equal(projectFromDirName(undefined), 'unknown')
})
