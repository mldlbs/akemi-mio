'use strict'

// Tests for `mio memory merge` (and the shared mergeMemory implementation it
// delegates to). Merge is archive-based, so the guarantees under test are:
// nothing is silently concatenated, the survivor carries an audit trail, and
// the whole thing is reversible with `mio memory restore`.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const CLI = path.join(repoRoot, 'packages', 'mio-cli', 'bin', 'mio.js')

const DUP_CONTENT = '使用流式 JSON 解析处理大型 MCP 载荷以避免 token 尖峰并减少内存占用'
const NEAR_A = '发布流程：先跑 verify pack install，通过后再 npm publish'
const NEAR_B = '发布流程：先跑 verify pack install，通过后再 npm publish 到 registry'

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mio-mrg-' + label + '-'))
}

function run(cwd, env, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env })
}

function workspace(label) {
  const mioHome = tempDir(label)
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-mrg-cwd-'))
  const env = { ...process.env, MIO_HOME: mioHome }
  return { mioHome, cwd, env, project: path.basename(cwd) }
}

function remember(ws, content, extra = []) {
  const result = run(ws.cwd, ws.env, ['remember', content, '--kind', 'decision', ...extra])
  assert.equal(result.status, 0, result.stderr)
  return result
}

// Fetch a record id by its own distinctive tokens: CJK matching is bigram-based,
// so a generic query will not reliably return a specific record.
function recallId(ws, token, extra = []) {
  const result = run(ws.cwd, ws.env, ['recall', token, '--json', ...extra])
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.ok(payload.results.length > 0, `recall "${token}" returned nothing`)
  return payload.results[0].id
}

function analyzeJson(ws, extra = []) {
  const result = run(ws.cwd, ws.env, ['memory', 'analyze', '--json', ...extra])
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('memory merge combines identical duplicates into one survivor', () => {
  const ws = workspace('exact')
  remember(ws, DUP_CONTENT)
  remember(ws, DUP_CONTENT)

  const ids = analyzeJson(ws).duplicates[0].records.map((r) => r.id)
  assert.equal(ids.length, 2)

  const merged = run(ws.cwd, ws.env, ['memory', 'merge', '--ids', ids.join(','), '--yes'])
  assert.equal(merged.status, 0, merged.stderr)
  assert.match(merged.stdout, /Merged 1 record\(s\) into mem_/)
  assert.match(merged.stdout, /supersedes: /)
  assert.match(merged.stdout, /Undo with: mio memory restore/)

  const report = analyzeJson(ws)
  assert.equal(report.archived, 1, 'the losing record is archived')
  assert.equal(report.total, 1, 'only the survivor stays active')
  assert.equal(report.duplicates.length, 0, 'the group is gone once merged')
})

test('memory merge keeps the newest record by default and unions tags', () => {
  const ws = workspace('newest')
  remember(ws, DUP_CONTENT, ['--tags', 'alpha'])
  remember(ws, DUP_CONTENT, ['--tags', 'beta'])

  const ids = analyzeJson(ws).duplicates[0].records.map((r) => r.id)
  const merged = run(ws.cwd, ws.env, ['memory', 'merge', '--ids', ids.join(','), '--yes'])
  assert.equal(merged.status, 0, merged.stderr)

  const survivorId = merged.stdout.match(/into (mem_\w+)/)[1]
  const rows = fs
    .readFileSync(path.join(ws.mioHome, 'memory.jsonl'), 'utf8')
    .split(/\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  const survivor = rows.find((r) => r.id === survivorId)

  assert.deepEqual([...survivor.tags].sort(), ['alpha', 'beta'], 'tags are unioned, not replaced')
  assert.equal(survivor.supersedes.length, 1)
  assert.equal(survivor.mergedCount, 1)
  assert.ok(survivor.mergedAt, 'merge is timestamped')
})

test('memory merge honours an explicit --keep survivor', () => {
  const ws = workspace('keep')
  remember(ws, DUP_CONTENT, ['--tags', 'first'])
  remember(ws, DUP_CONTENT, ['--tags', 'second'])

  const ids = analyzeJson(ws).duplicates[0].records.map((r) => r.id)
  // Keep the *older* one deliberately, to prove --keep beats the newest-wins default.
  const requested = ids[0]

  const merged = run(ws.cwd, ws.env, [
    'memory', 'merge', '--ids', ids.join(','), '--keep', requested, '--yes',
  ])
  assert.equal(merged.status, 0, merged.stderr)
  assert.match(merged.stdout, new RegExp(`into ${requested}`))

  const rows = fs
    .readFileSync(path.join(ws.mioHome, 'memory.jsonl'), 'utf8')
    .split(/\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  const survivor = rows.find((r) => r.id === requested)
  assert.equal(survivor.archived, undefined, 'the requested record is not archived')
  assert.deepEqual(survivor.supersedes, [ids[1]])
})

test('memory merge records the archive cause on the losing record', () => {
  const ws = workspace('audit')
  remember(ws, DUP_CONTENT)
  remember(ws, DUP_CONTENT)
  const ids = analyzeJson(ws).duplicates[0].records.map((r) => r.id)

  const merged = run(ws.cwd, ws.env, ['memory', 'merge', '--ids', ids.join(','), '--yes'])
  const survivorId = merged.stdout.match(/into (mem_\w+)/)[1]
  const loserId = ids.find((id) => id !== survivorId)

  const rows = fs
    .readFileSync(path.join(ws.mioHome, 'memory.jsonl'), 'utf8')
    .split(/\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  const loser = rows.find((r) => r.id === loserId)

  assert.equal(loser.archived, true)
  assert.equal(loser.mergedInto, survivorId)
  assert.equal(loser.archiveReason, `merged-into:${survivorId}`)
})

test('memory merge refuses divergent content and lists the candidates', () => {
  const ws = workspace('divergent')
  remember(ws, NEAR_A)
  remember(ws, NEAR_B)

  // The two bodies are similar enough to group but not identical.
  const groups = analyzeJson(ws).duplicates
  assert.equal(groups.length, 1, 'near-duplicates are grouped')
  const ids = groups[0].records.map((r) => r.id)

  const refused = run(ws.cwd, ws.env, ['memory', 'merge', '--ids', ids.join(','), '--yes'])
  assert.equal(refused.status, 1, 'refusing is not success')
  assert.match(refused.stdout, /refusing to concatenate/)
  assert.match(refused.stdout, /Divergent content/)
  // Both candidates are shown so the caller can choose.
  for (const id of ids) assert.match(refused.stdout, new RegExp(id))
  assert.match(refused.stdout, /--keep/)

  const report = analyzeJson(ws)
  assert.equal(report.archived, 0, 'refusal writes nothing')
  assert.equal(report.duplicates.length, 1, 'the group is untouched')
})

test('memory merge with --allow-divergent requires an explicit --keep', () => {
  const ws = workspace('divergent-ctx')
  remember(ws, NEAR_A)
  remember(ws, NEAR_B)
  const ids = analyzeJson(ws).duplicates[0].records.map((r) => r.id)

  // Without --keep the surviving body would be undefined, so this must fail.
  const noKeep = run(ws.cwd, ws.env, [
    'memory', 'merge', '--ids', ids.join(','), '--allow-divergent', '--yes',
  ])
  assert.equal(noKeep.status, 1)
  assert.match(noKeep.stderr, /requires keep/)
  assert.equal(analyzeJson(ws).archived, 0)

  const withKeep = run(ws.cwd, ws.env, [
    'memory', 'merge', '--ids', ids.join(','), '--keep', ids[1], '--allow-divergent', '--yes',
  ])
  assert.equal(withKeep.status, 0, withKeep.stderr)
  assert.match(withKeep.stdout, /content differed across members/)

  const rows = fs
    .readFileSync(path.join(ws.mioHome, 'memory.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  const survivor = rows.find((r) => r.id === ids[1])
  assert.equal(survivor.content, NEAR_B, 'the kept body is byte-identical to the original')
  assert.equal(survivor.mergeDivergent, true)
})

test('memory merge previews without --yes, in text and json modes', () => {
  const ws = workspace('gate')
  remember(ws, DUP_CONTENT)
  remember(ws, DUP_CONTENT)
  const ids = analyzeJson(ws).duplicates[0].records.map((r) => r.id)

  const preview = run(ws.cwd, ws.env, ['memory', 'merge', '--ids', ids.join(',')])
  assert.equal(preview.status, 1, 'preview must not exit 0')
  assert.match(preview.stdout, /merge preview/)
  assert.match(preview.stdout, /Re-run with --yes/)
  assert.equal(analyzeJson(ws).archived, 0, 'nothing archived by the preview')

  const jsonPreview = run(ws.cwd, ws.env, ['memory', 'merge', '--ids', ids.join(','), '--json'])
  assert.equal(jsonPreview.status, 1)
  const payload = JSON.parse(jsonPreview.stdout)
  assert.equal(payload.applied, false)
  assert.equal(payload.preview, true)
  assert.deepEqual(payload.ids, ids)
  assert.equal(analyzeJson(ws).archived, 0)
})

test('memory merge is reversible with restore', () => {
  const ws = workspace('undo')
  remember(ws, DUP_CONTENT)
  remember(ws, DUP_CONTENT)
  const ids = analyzeJson(ws).duplicates[0].records.map((r) => r.id)

  const merged = run(ws.cwd, ws.env, ['memory', 'merge', '--ids', ids.join(','), '--yes'])
  assert.equal(merged.status, 0, merged.stderr)
  const survivorId = merged.stdout.match(/into (mem_\w+)/)[1]
  const loserId = ids.find((id) => id !== survivorId)

  const restored = run(ws.cwd, ws.env, ['memory', 'restore', '--ids', loserId])
  assert.equal(restored.status, 0, restored.stderr)

  const report = analyzeJson(ws)
  assert.equal(report.archived, 0)
  assert.equal(report.total, 2, 'both records are active again')
  assert.equal(report.duplicates.length, 1, 'the duplicate group reappears')
})

test('memory merge is idempotent and validates its inputs', () => {
  const ws = workspace('idem')
  remember(ws, DUP_CONTENT)
  remember(ws, DUP_CONTENT)
  const ids = analyzeJson(ws).duplicates[0].records.map((r) => r.id)

  assert.equal(run(ws.cwd, ws.env, ['memory', 'merge', '--ids', ids.join(','), '--yes']).status, 0)
  const again = run(ws.cwd, ws.env, ['memory', 'merge', '--ids', ids.join(','), '--yes'])
  assert.equal(again.status, 1, 'a second merge has nothing left to do')
  assert.match(again.stdout, /nothing left to merge/)
  assert.match(again.stdout, /already archived/)
  // A no-op must not advertise an undo for records it did not archive.
  assert.doesNotMatch(again.stdout, /Undo with: mio memory restore --ids\s*$/)

  const one = run(ws.cwd, ws.env, ['memory', 'merge', '--ids', ids[0], '--yes'])
  assert.equal(one.status, 1)
  assert.match(one.stderr, /at least 2 ids/)

  const noIds = run(ws.cwd, ws.env, ['memory', 'merge'])
  assert.equal(noIds.status, 1)
  assert.match(noIds.stderr, /requires --ids/)

  // A bad --keep must be rejected rather than silently falling back.
  remember(ws, DUP_CONTENT + '另一个变体用于测试')
  const fresh = analyzeJson(ws).duplicates
  if (fresh.length > 0) {
    const freshIds = fresh[0].records.map((r) => r.id)
    const badKeep = run(ws.cwd, ws.env, [
      'memory', 'merge', '--ids', freshIds.join(','), '--keep', 'mem_nope', '--allow-divergent', '--yes',
    ])
    assert.equal(badKeep.status, 1)
    assert.match(badKeep.stderr, /keep id not in the merge set/)
  }
})

test('memory merge respects project isolation', () => {
  const ws = workspace('isolation')
  remember(ws, DUP_CONTENT, ['--project', 'proj-a'])
  remember(ws, DUP_CONTENT, ['--project', 'proj-a'])
  const ids = analyzeJson(ws, ['--project', 'proj-a']).duplicates[0].records.map((r) => r.id)

  const wrongProject = run(ws.cwd, ws.env, [
    'memory', 'merge', '--ids', ids.join(','), '--project', 'proj-b', '--yes',
  ])
  assert.equal(wrongProject.status, 1, 'no record matched, so nothing merged')
  assert.match(wrongProject.stdout, /belongs to another project/)
  assert.equal(analyzeJson(ws, ['--project', 'proj-a']).archived, 0)

  // Regression: applying the project filter only in the archive loop used to
  // still rewrite the survivor's `supersedes` list even though nothing was
  // archived, leaving audit metadata that pointed at no archived record.
  const untouched = fs
    .readFileSync(path.join(ws.mioHome, 'memory.jsonl'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => ids.includes(r.id))
  for (const record of untouched) {
    assert.equal(record.supersedes, undefined, 'a refused merge must not touch supersedes')
    assert.equal(record.mergedAt, undefined, 'a refused merge must not stamp mergedAt')
  }

  const right = run(ws.cwd, ws.env, [
    'memory', 'merge', '--ids', ids.join(','), '--project', 'proj-a', '--yes',
  ])
  assert.equal(right.status, 0, right.stderr)
  assert.equal(analyzeJson(ws, ['--project', 'proj-a']).archived, 1)
})

test('merge is exposed with the same semantics through the shared store', () => {
  // The CLI and the MCP server both delegate here, so this covers the half the
  // binary test cannot reach directly.
  const { createMemoryStore } = require('../server/memory-store.js')
  const ws = workspace('store')
  const store = createMemoryStore({
    dataDir: ws.mioHome,
    projectName: () => 'store-proj',
  })

  const a = store.recordMemory({ content: DUP_CONTENT, kind: 'decision', project: 'store-proj' })
  const b = store.recordMemory({ content: DUP_CONTENT, kind: 'decision', project: 'store-proj' })

  const merged = store.mergeMemory({ ids: [a.id, b.id], project: 'store-proj' })
  assert.equal(merged.merged, true)
  assert.equal(merged.survivor.id, b.id, 'newest wins')
  assert.deepEqual(merged.archived, [a.id])

  // Divergent content is refused rather than concatenated.
  const c = store.recordMemory({ content: NEAR_A, kind: 'decision', project: 'store-proj' })
  const d = store.recordMemory({ content: NEAR_B, kind: 'decision', project: 'store-proj' })
  const refused = store.mergeMemory({ ids: [c.id, d.id], project: 'store-proj' })
  assert.equal(refused.merged, false)
  assert.equal(refused.divergent.length, 2)
  assert.equal(refused.archivedCount, 0)

  // Too few ids is a programming error, not a silent no-op.
  assert.throws(() => store.mergeMemory({ ids: [c.id] }), /at least 2 ids/)
})
