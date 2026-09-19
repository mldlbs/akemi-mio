'use strict'

// Shared by the two gates that actually execute mio: check-cli-docs.cjs (every
// README command) and check-mcp-tools-live.cjs (every MCP tool).
//
// Both need the same judgement: did this command reject its input, or did it
// crash? A command that validates tells you what is missing
// ("memory.record requires a non-empty content"). A command that crashes says
// something like "Cannot read properties of undefined", which names neither the
// command nor the field -- and that is exactly the failure that reaches users,
// because it looks like a bug report instead of a usage error.
//
// Kept in one place so the two gates cannot drift: if one of them starts
// tolerating a shape the other rejects, a bug slips through whichever gate is
// the laxer one.

// A tool that rejects empty arguments should say why in its own words. These are
// the shapes that mean the code crashed instead of validating.
const CRASH_MARKERS = [
  'is not a function',
  'Cannot read propert',
  'Cannot read properties',
  'is not defined',
  'ERR_INVALID_ARG_TYPE',
  'must be of type',
  'Cannot find module',
  'MODULE_NOT_FOUND',
  'TypeError',
  'ReferenceError',
  'SyntaxError',
]

// Returns the marker that makes `text` look like a crash, or null if it reads
// like an ordinary rejection.
function crashMarker(text) {
  const s = String(text || '')
  return CRASH_MARKERS.find((m) => s.includes(m)) || null
}

module.exports = { CRASH_MARKERS, crashMarker }
