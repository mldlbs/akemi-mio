'use strict'

// Tests for `mio memory forget` -- the only irreversible memory operation.
// archive is reversible (archived: true), merge is archive-based, prune --memory
// is age-based; forget removes the record outright. So the important guarantees
// are: preview deletes nothing, out-of-project ids are never touched, a total
// miss is an error (a typo must not read as success), and an audit entry is
// written before the record disappears.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const CLI = path.join(repoRoot, 'packages', 'mio-cli', 'bin', 'mio.js')

function workspace(label) {
  const mioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-forget-' + label + '-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-forget-cwd-'))
  return { mioHome, cwd, env: { ...process.env, MIO_HOME: mioHome } }
}

function run(ws, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ws.cwd, encoding: 'utf8', env: ws.env })
}

function memoryFile(ws) {
  return path.join(ws.mioHome, 'memory.jsonl')
}

function auditFile(ws) {
  return path.join(ws.mioHome, 'memory-forget-audit.jsonl')
}

function seed(ws, records) {
  fs.mkdirSync(ws.mioHome, { recursive: true })
  fs.writeFileSync(
    memoryFile(ws),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8'
  )
}

function readMemory(ws) {
  if (!fs.existsSync(memoryFile(ws))) return []
  return fs
    .readFileSync(memoryFile(ws), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function readAudit(ws) {
  if (!fs.existsSync(auditFile(ws))) return []
  return fs
    .readFileSync(auditFile(ws), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function seedTwo(ws) {
  seed(ws, [
    { id: 'mem_secret', kind: 'note', content: 'secret token abc123', project: 'demo' },
    { id: 'mem_keep', kind: 'note', content: 'keep this one', project: 'demo' },
  ])
}

test('forget previews without deleting and warns it is permanent', () => {
  const ws = workspace('preview')
  seedTwo(ws)

  const result = run(ws, ['memory', 'forget', '--ids', 'mem_secret', '--project', 'demo'])
  assert.equal(result.status, 1, 'preview exits non-zero')
  assert.match(result.stdout, /Forget preview: 1 id\(s\)/)
  // The preview shows what is about to vanish, not just the id.
  assert.match(result.stdout, /mem_secret/)
  assert.match(result.stdout, /secret token abc123/)
  assert.match(result.stdout, /cannot be undone/)
  assert.match(result.stdout, /memory-forget-audit\.jsonl/)
  assert.match(result.stdout, /mio memory archive --ids mem_secret --yes/, 'points at the reversible option')

  const records = readMemory(ws)
  assert.equal(records.length, 2, 'nothing deleted by the preview')
  assert.equal(fs.existsSync(auditFile(ws)), false, 'no audit entry for a preview')
})

test('forget --yes deletes the record and writes an audit entry', () => {
  const ws = workspace('apply')
  seedTwo(ws)

  const result = run(ws, [
    'memory', 'forget', '--ids', 'mem_secret', '--project', 'demo',
    '--reason', 'contains a secret', '--yes',
  ])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Forgot 1 record\(s\) permanently/)
  assert.match(result.stdout, /deleted: mem_secret/)
  assert.match(result.stdout, /This cannot be undone/)

  const records = readMemory(ws)
  assert.equal(records.length, 1)
  assert.equal(records[0].id, 'mem_keep', 'only the requested record is gone')

  const audit = readAudit(ws)
  assert.equal(audit.length, 1)
  assert.equal(audit[0].forgottenId, 'mem_secret')
  assert.equal(audit[0].project, 'demo')
  assert.equal(audit[0].reason, 'contains a secret')
  assert.equal(audit[0].kind, 'note')
  assert.equal(audit[0].contentLength, 'secret token abc123'.length)
  // An excerpt, so "what was removed" is answerable -- but not the full body.
  assert.equal(audit[0].excerpt, 'secret token abc123')
  assert.equal(audit[0].by, 'cli')
  assert.equal(typeof audit[0].timestamp, 'string')
})

test('forget never touches ids from another project', () => {
  const ws = workspace('scope')
  seed(ws, [
    { id: 'mem_a', kind: 'note', content: 'belongs to demo', project: 'demo' },
    { id: 'mem_b', kind: 'note', content: 'belongs to other', project: 'other' },
  ])

  const result = run(ws, ['memory', 'forget', '--ids', 'mem_a', '--project', 'other', '--yes'])
  // Every requested id missed -> reported, and nothing was deleted.
  assert.equal(result.status, 1, 'a total miss is an error, not a silent no-op')
  assert.match(result.stdout, /not found: mem_a/)

  const records = readMemory(ws)
  assert.equal(records.length, 2, 'both records survive')
  assert.equal(readAudit(ws).length, 0, 'no audit entry for a record that was not deleted')
})

test('forget exits non-zero when nothing matched', () => {
  const ws = workspace('missing')
  seedTwo(ws)

  const result = run(ws, ['memory', 'forget', '--ids', 'mem_typo', '--project', 'demo', '--yes'])
  assert.equal(result.status, 1)
  assert.match(result.stdout, /Forgot 0 record\(s\)/)
  assert.match(result.stdout, /not found: mem_typo/)
  assert.equal(readMemory(ws).length, 2)
})

test('forget requires ids', () => {
  const ws = workspace('noids')
  seedTwo(ws)
  const result = run(ws, ['memory', 'forget', '--yes'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /requires --ids/)
  assert.equal(readMemory(ws).length, 2)
})

test('forget accepts bare positional ids and --json previews', () => {
  const ws = workspace('forms')
  seedTwo(ws)

  // json preview is gated the same way as the text one
  const preview = run(ws, ['memory', 'forget', 'mem_secret', '--project', 'demo', '--json'])
  assert.equal(preview.status, 1)
  const previewJson = JSON.parse(preview.stdout)
  assert.equal(previewJson.preview, true)
  assert.equal(previewJson.applied, false)
  assert.equal(previewJson.reversible, false, 'forget is flagged as not reversible')
  assert.match(previewJson.hint, /PERMANENT/)
  assert.equal(readMemory(ws).length, 2, 'json preview does not delete either')

  // bare positional id + --yes applies
  const applied = run(ws, ['memory', 'forget', 'mem_secret', '--project', 'demo', '--json', '--yes'])
  assert.equal(applied.status, 0, applied.stderr)
  const appliedJson = JSON.parse(applied.stdout)
  assert.equal(appliedJson.forgottenCount, 1)
  assert.deepEqual(appliedJson.forgotten, ['mem_secret'])
  assert.equal(readMemory(ws).length, 1)
})

test('forget is exposed as an MCP tool', () => {
  // Source-text assertion, not a require: loading the MCP index creates a
  // readline interface on stdin, which keeps the test process alive.
  const source = fs.readFileSync(
    path.join(repoRoot, 'packages', 'mio-cli', 'server', 'mio-intelligence-mcp', 'index.js'),
    'utf8'
  )
  assert.match(source, /name: 'mio\.memory\.forget'/, 'tool is registered')
  assert.match(source, /case 'mio\.memory\.forget':\s*\n\s*return forgetMemory\(args\)/, 'call is dispatched')
  assert.match(source, /forgetMemory,/, 'store method is destructured')
})

test('the store refuses to forget without ids', () => {
  const { createMemoryStore } = require('../server/memory-store.js')
  const ws = workspace('store')
  seedTwo(ws)
  const store = createMemoryStore({ dataDir: ws.mioHome, projectName: () => 'demo' })
  assert.throws(() => store.forgetMemory({}), /requires ids/)
  assert.throws(() => store.forgetMemory({ ids: [] }), /requires ids/)
  assert.equal(readMemory(ws).length, 2)
})
