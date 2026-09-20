'use strict'

// Direct tests for the shared crash-vs-validation classifier.
//
// Why this file exists: `scripts/lib/crash-messages.cjs` is imported by two repo
// gates (`scripts/check-cli-docs.cjs`, `scripts/check-mcp-tools-live.cjs`) and by
// nothing else. Deleting a marker from CRASH_MARKERS used to leave BOTH gates green,
// because every tool currently rejects empty arguments with proper validation text --
// so no error string ever contains a crash marker, and the classifier is never
// exercised downstream. A marker removal would then stay invisible until the day a
// tool genuinely crashes, which is exactly the day the detector is needed.
//
// So the classifier is tested directly, with BOTH polarities. Positive controls
// prove it fires; negative controls prove it does not over-fire. A fixture with only
// one polarity cannot distinguish the predicate from its negation.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { crashMarker, CRASH_MARKERS } = require(
  path.resolve(__dirname, '..', '..', '..', 'scripts', 'lib', 'crash-messages.cjs')
)

// Every marker must actually be recognised. This is the assertion that goes red
// when a marker is deleted from the list.
//
// Note: assert "recognised", NOT "returns this exact literal". The list deliberately
// contains overlapping markers ('Cannot read propert' and 'Cannot read properties'),
// and `find()` returns whichever matches first, so pinning the literal would break on
// an order change that is harmless.
test('every marker in the exported list is recognised', () => {
  assert.ok(CRASH_MARKERS.length >= 11, 'marker list shrank unexpectedly')
  for (const marker of CRASH_MARKERS) {
    assert.notEqual(
      crashMarker('prefix ' + marker + ' suffix'),
      null,
      'marker not recognised by crashMarker(): ' + marker
    )
  }
})

test('crash shapes are classified as crashes (positive controls)', () => {
  const crashes = [
    'Cannot read properties of undefined (reading "x")',
    'Cannot read propert',
    'TypeError: foo is not a function',
    'x is not a function',
    'y is not defined',
    'ERR_INVALID_ARG_TYPE',
    'paths[0] must be of type string',
    'Cannot find module "@akemi-mio/observe"',
    'MODULE_NOT_FOUND',
    'ReferenceError: z is not defined',
    'SyntaxError: Unexpected token',
  ]
  for (const text of crashes) {
    assert.notEqual(crashMarker(text), null, 'should be a crash: ' + text)
  }
})

// The other polarity. A tool that validates its input names the tool and the field;
// that must NOT be reported as a crash, or the gate turns every usage error into a
// build failure and gets muted.
test('validation text is not classified as a crash (negative controls)', () => {
  const validations = [
    'mio.memory.record requires a non-empty content',
    'unknown flag --not-a-flag',
    'expected one of: a, b, c',
    'missing required argument <id>',
    '',
    'not installed: @akemi-mio/insight',
  ]
  for (const text of validations) {
    assert.equal(crashMarker(text), null, 'should NOT be a crash: ' + text)
  }
})

// Guards against a substring bug in the other direction: the marker must match, but
// an unrelated string containing a fragment of it must not.
test('returns the matched marker, not a boolean', () => {
  assert.equal(crashMarker('boom TypeError: nope'), 'TypeError')
  assert.equal(crashMarker(null), null)
  assert.equal(crashMarker(undefined), null)
  assert.equal(crashMarker(12345), null)
})
