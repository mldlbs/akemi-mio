'use strict'

// Tests for the `mio memory` subcommand group (analyze / archive / restore /
// migrate). These cover the CLI layer on top of the shared memory store, so
// they deliberately exercise the real binary in a throwaway MIO_HOME.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const CLI = path.join(repoRoot, 'packages', 'mio-cli', 'bin', 'mio.js')

const DUP_CONTENT = '使用流式 JSON 解析处理大型 MCP 载荷以避免 token 尖峰并减少内存占用'
const SHORT_CONTENT = '太短'

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mio-memcmd-' + label + '-'))
}

function run(cwd, env, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env })
}

// A scratch workspace: its own MIO_HOME plus a cwd whose basename is the
// default project name.
function workspace(label) {
  const mioHome = tempDir(label)
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-memcmd-cwd-'))
  const env = { ...process.env, MIO_HOME: mioHome }
  return { mioHome, cwd, env, project: path.basename(cwd) }
}

function remember(ws, content, extra = []) {
  const result = run(ws.cwd, ws.env, ['remember', content, '--kind', 'decision', ...extra])
  assert.equal(result.status, 0, result.stderr)
  return result
}

function analyzeJson(ws, extra = []) {
  const result = run(ws.cwd, ws.env, ['memory', 'analyze', '--json', ...extra])
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('memory analyze reports duplicate groups and low-quality records', () => {
  const ws = workspace('analyze')
  remember(ws, DUP_CONTENT)
  remember(ws, DUP_CONTENT)
  remember(ws, SHORT_CONTENT, ['--kind', 'note'])

  const report = analyzeJson(ws)
  assert.equal(report.total, 3)
  assert.equal(report.archived, 0)

  assert.equal(report.duplicates.length, 1)
  assert.equal(report.duplicates[0].size, 2)
  assert.equal(report.duplicates[0].records.length, 2)

  assert.equal(report.issues.lowQuality, 1)
  assert.equal(report.issues.duplicatesSkipped, false)
  assert.match(report.lowQuality[0].issues.join(','), /content too short/)

  // Human-readable form should surface the same findings.
  const text = run(ws.cwd, ws.env, ['memory', 'analyze'])
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /Duplicate groups: 1/)
  assert.match(text.stdout, /Low quality: 1/)
})

test('memory analyze keeps project layers separated', () => {
  const ws = workspace('layers')
  remember(ws, '项目内决策：记忆检索默认按项目隔离', ['--project', 'proj-a'])
  remember(ws, '全局约定：所有发布包保持零外部依赖', ['--project', 'proj-b', '--scope', 'global'])

  const report = analyzeJson(ws, ['--project', 'proj-a'])
  assert.equal(report.layers.project, 1)
  assert.equal(report.layers.global, 1, 'global records are visible from any project')
  assert.equal(report.total, 2)
})

test('memory archive previews without --yes and writes nothing', () => {
  const ws = workspace('gate')
  remember(ws, DUP_CONTENT)
  const id = analyzeJson(ws).duplicates.length // no dupes yet; grab id from recall
  assert.equal(id, 0)

  const recorded = run(ws.cwd, ws.env, ['recall', '流式', '--json'])
  const recordId = JSON.parse(recorded.stdout).results[0].id

  const preview = run(ws.cwd, ws.env, ['memory', 'archive', '--ids', recordId])
  assert.equal(preview.status, 1, 'preview must not exit 0')
  assert.match(preview.stdout, /Archive preview/)
  assert.match(preview.stdout, /Re-run with --yes/)

  const after = analyzeJson(ws)
  assert.equal(after.archived, 0, 'nothing archived by the preview')

  // The same gate applies in --json mode so scripts cannot archive by accident.
  const jsonPreview = run(ws.cwd, ws.env, ['memory', 'archive', '--ids', recordId, '--json'])
  assert.equal(jsonPreview.status, 1)
  const payload = JSON.parse(jsonPreview.stdout)
  assert.equal(payload.applied, false)
  assert.deepEqual(payload.ids, [recordId])
  assert.equal(analyzeJson(ws).archived, 0)
})

test('memory archive --yes hides records from analyze and recall, restore brings them back', () => {
  const ws = workspace('roundtrip')
  remember(ws, DUP_CONTENT)
  const recordId = JSON.parse(run(ws.cwd, ws.env, ['recall', '流式', '--json']).stdout).results[0].id

  const archived = run(ws.cwd, ws.env, ['memory', 'archive', '--ids', recordId, '--yes', '--reason', 'duplicate'])
  assert.equal(archived.status, 0, archived.stderr)
  assert.match(archived.stdout, /Archived 1 record/)
  assert.match(archived.stdout, /Undo with: mio memory restore/)

  assert.equal(analyzeJson(ws).archived, 1)
  assert.equal(analyzeJson(ws).total, 0, 'archived records drop out of the active set')
  assert.equal(JSON.parse(run(ws.cwd, ws.env, ['recall', '流式', '--json']).stdout).count, 0)

  const restored = run(ws.cwd, ws.env, ['memory', 'restore', '--ids', recordId])
  assert.equal(restored.status, 0, restored.stderr)
  assert.match(restored.stdout, /Restored 1 record/)
  assert.equal(analyzeJson(ws).archived, 0)
  assert.equal(JSON.parse(run(ws.cwd, ws.env, ['recall', '流式', '--json']).stdout).count, 1)
})

test('memory archive is idempotent and reports unknown ids with a non-zero exit', () => {
  const ws = workspace('idem')
  remember(ws, DUP_CONTENT)
  const recordId = JSON.parse(run(ws.cwd, ws.env, ['recall', '流式', '--json']).stdout).results[0].id

  assert.equal(run(ws.cwd, ws.env, ['memory', 'archive', '--ids', recordId, '--yes']).status, 0)
  const again = run(ws.cwd, ws.env, ['memory', 'archive', '--ids', recordId, '--yes'])
  assert.equal(again.status, 1, 're-archiving an archived record is a no-op, not a success')
  assert.match(again.stdout, /already archived/, 'already-in-state ids are reported, not "not found"')

  const restoreAgain = run(ws.cwd, ws.env, ['memory', 'restore', '--ids', recordId])
  assert.equal(restoreAgain.status, 0)
  const restoreNoop = run(ws.cwd, ws.env, ['memory', 'restore', '--ids', recordId])
  assert.equal(restoreNoop.status, 1)
  assert.match(restoreNoop.stdout, /already restored/)

  const missing = run(ws.cwd, ws.env, ['memory', 'archive', '--ids', 'mem_nope', '--yes'])
  assert.equal(missing.status, 1)
  assert.match(missing.stdout, /not found: mem_nope/)
})

test('memory migrate moves records between project and global layers and back', () => {
  const ws = workspace('migrate')
  remember(ws, '可复用经验：发布前必须跑 verify pack install', ['--project', 'proj-a'])
  const recordId = JSON.parse(
    run(ws.cwd, ws.env, ['recall', '发布前', '--project', 'proj-a', '--json']).stdout
  ).results[0].id

  const toGlobal = run(ws.cwd, ws.env, [
    'memory', 'migrate', '--ids', recordId, '--scope', 'global', '--project', 'proj-a',
  ])
  assert.equal(toGlobal.status, 0, toGlobal.stderr)
  assert.match(toGlobal.stdout, /Migrated 1 record\(s\) to global/)
  assert.match(toGlobal.stdout, /Undo with: mio memory migrate/)

  const globalReport = analyzeJson(ws, ['--project', 'proj-a'])
  assert.equal(globalReport.layers.global, 1)
  assert.equal(globalReport.layers.project, 0)

  const back = run(ws.cwd, ws.env, [
    'memory', 'migrate', '--ids', recordId, '--scope', 'project', '--project', 'proj-a',
  ])
  assert.equal(back.status, 0, back.stderr)
  assert.equal(analyzeJson(ws, ['--project', 'proj-a']).layers.project, 1)
})

test('memory migrate rejects the all scope and unknown ids', () => {
  const ws = workspace('migrate-err')
  remember(ws, DUP_CONTENT)

  const badScope = run(ws.cwd, ws.env, ['memory', 'migrate', '--ids', 'mem_x', '--scope', 'all'])
  assert.equal(badScope.status, 1)
  assert.match(badScope.stderr, /scope must be project or global/)

  const missing = run(ws.cwd, ws.env, ['memory', 'migrate', '--ids', 'mem_nope', '--scope', 'global'])
  assert.equal(missing.status, 1)
  assert.match(missing.stdout, /not found/)
})

test('memory archive and migrate accept bare positional ids', () => {
  const ws = workspace('positional')
  remember(ws, DUP_CONTENT)
  remember(ws, '另一条独立决策：优先级排序按最近使用时间')
  // Fetch each id by its own distinctive tokens rather than one shared query —
  // CJK bigram matching will not return both for a generic term.
  const idA = JSON.parse(run(ws.cwd, ws.env, ['recall', '流式', '--json']).stdout).results[0].id
  const idB = JSON.parse(run(ws.cwd, ws.env, ['recall', '优先级排序', '--json']).stdout).results[0].id
  const ids = [idA, idB]
  assert.notEqual(idA, idB)

  // comma-separated positional
  const comma = run(ws.cwd, ws.env, ['memory', 'archive', ids.join(','), '--yes'])
  assert.equal(comma.status, 0, comma.stderr)
  assert.equal(analyzeJson(ws).archived, ids.length)

  // space-separated positionals restore the same set
  const space = run(ws.cwd, ws.env, ['memory', 'restore', ...ids])
  assert.equal(space.status, 0, space.stderr)
  assert.equal(analyzeJson(ws).archived, 0)

  // a value-taking flag's own value must not be mistaken for an id
  const withReason = run(ws.cwd, ws.env, ['memory', 'archive', ...ids, '--reason', 'cleanup', '--yes'])
  assert.equal(withReason.status, 0, withReason.stderr)
  assert.equal(analyzeJson(ws).archived, ids.length)
})

test('memory archive respects project isolation', () => {
  const ws = workspace('isolation')
  remember(ws, '项目 A 的独立决策：采用双层记忆结构', ['--project', 'proj-a'])
  const idA = JSON.parse(
    run(ws.cwd, ws.env, ['recall', '双层记忆', '--project', 'proj-a', '--json']).stdout
  ).results[0].id

  // Archiving under a different project must not touch proj-a's record.
  const other = run(ws.cwd, ws.env, ['memory', 'archive', '--ids', idA, '--project', 'proj-b', '--yes'])
  assert.equal(other.status, 1, 'no record matched, so the command reports failure')
  assert.equal(analyzeJson(ws, ['--project', 'proj-a']).archived, 0)

  assert.equal(run(ws.cwd, ws.env, ['memory', 'archive', '--ids', idA, '--project', 'proj-a', '--yes']).status, 0)
  assert.equal(analyzeJson(ws, ['--project', 'proj-a']).archived, 1)
})

test('memory subcommand validates its arguments', () => {
  const ws = workspace('usage')

  const none = run(ws.cwd, ws.env, ['memory'])
  assert.equal(none.status, 1)
  assert.match(none.stdout, /Usage:/)

  const unknown = run(ws.cwd, ws.env, ['memory', 'bogus'])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /Unknown memory subcommand: bogus/)

  const noIds = run(ws.cwd, ws.env, ['memory', 'archive'])
  assert.equal(noIds.status, 1)
  assert.match(noIds.stderr, /requires --ids/)

  const help = run(ws.cwd, ws.env, ['memory', 'help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /mio memory analyze/)
})
