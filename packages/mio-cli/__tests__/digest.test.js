'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const NOW = Date.now()
const DAY = 86400000
const iso = (ms) => new Date(ms).toISOString()

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mio-digest-' + label + '-'))
}

function seed(home) {
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true })
  const write = (name, values) =>
    fs.writeFileSync(path.join(home, name), values.map((v) => JSON.stringify(v)).join('\n') + '\n', 'utf8')

  write('traces.jsonl', [
    // codex: 6 success (last one 3 days old, outside a 1-day window), 2 error
    ...Array.from({ length: 5 }, (_, i) => ({
      id: 'c' + i, timestamp: iso(NOW - i * 3600000), trace_id: 'codex:' + i, event_type: 'task_outcome',
      outcome: 'success', agent: 'codex', project: 'proj-a', payload: { summary: 'codex finished task ' + i },
    })),
    { id: 'c5', timestamp: iso(NOW - 3 * DAY), trace_id: 'codex:5', event_type: 'task_outcome',
      outcome: 'success', agent: 'codex', project: 'proj-a', payload: { summary: 'codex finished task 5' } },
    { id: 'ce1', timestamp: iso(NOW - 2 * 3600000), trace_id: 'codex:e1', event_type: 'error', outcome: 'error', agent: 'codex', project: 'proj-a', payload: { tool: 'Bash' } },
    { id: 'ce2', timestamp: iso(NOW - 3 * 3600000), trace_id: 'codex:e2', event_type: 'error', outcome: 'error', agent: 'codex', project: 'proj-a', payload: { tool: 'Bash' } },
    // claude-code: 3 success, 3 failure (last failure 3 days old)
    ...Array.from({ length: 3 }, (_, i) => ({
      id: 'k' + i, timestamp: iso(NOW - i * 7200000), trace_id: 'claude:' + i, event_type: 'task_outcome',
      outcome: 'success', agent: 'claude-code', project: 'proj-b', payload: { summary: 'claude task ' + i },
    })),
    ...Array.from({ length: 2 }, (_, i) => ({
      id: 'kf' + i, timestamp: iso(NOW - i * 7200000 - 1800000), trace_id: 'claude:f' + i, event_type: 'task_outcome',
      outcome: 'failure', agent: 'claude-code', project: 'proj-b', payload: {},
    })),
    { id: 'kf2', timestamp: iso(NOW - 3 * DAY), trace_id: 'claude:f2', event_type: 'task_outcome',
      outcome: 'failure', agent: 'claude-code', project: 'proj-b', payload: {} },
    // old record outside the window
    { id: 'old', timestamp: iso(NOW - 30 * DAY), trace_id: 'x:old', event_type: 'task_outcome', outcome: 'success', agent: 'codex', project: 'proj-a', payload: {} },
  ])
  write('experience_reuse.jsonl', [
    { id: 'x1', timestamp: iso(NOW - DAY), sourceAgent: 'codex', targetAgent: 'claude-code', experienceId: 'mem_1', reuse: true, behaviorChanged: true, outcomeImproved: true, project: 'proj-a' },
    { id: 'x2', timestamp: iso(NOW - DAY), sourceAgent: 'codex', targetAgent: 'codex', experienceId: 'mem_2', reuse: true, behaviorChanged: false, outcomeImproved: false, confirmed: false, project: 'proj-a', source: 'auto_claim' },
    { id: 'x3', timestamp: iso(NOW - 20 * DAY), sourceAgent: 'a', targetAgent: 'b', experienceId: 'mem_3', reuse: true, behaviorChanged: true, outcomeImproved: true },
  ])
}

function makeDigest(home) {
  const { createDigest } = require('../server/digest.js')
  return createDigest({ home, now: () => NOW })
}

test('digest aggregates agents, projects, errors, reuse, and suggestions', () => {
  const home = tempDir('agg')
  seed(home)
  const report = makeDigest(home).generate({ days: 7 })

  assert.equal(report.overview.tasks, 12) // 6 codex + 6 claude (old excluded)
  assert.equal(report.overview.byOutcome.success, 9)
  assert.equal(report.overview.byOutcome.failure, 3)
  assert.equal(report.overview.errorTraces, 2)

  const codex = report.agents.find((a) => a.agent === 'codex')
  assert.equal(codex.total, 6)
  assert.equal(codex.successRate, 100)
  const claude = report.agents.find((a) => a.agent === 'claude-code')
  assert.equal(claude.successRate, 50)

  const projA = report.projects.find((p) => p.project === 'proj-a')
  assert.equal(projA.tasks, 6)
  assert.ok(projA.recent.length >= 1 && projA.recent[0].summary.includes('codex finished task'))

  assert.equal(report.errorHotspots.total, 2)
  assert.equal(report.errorHotspots.byAgent[0].agent, 'codex')
  assert.ok(report.errorHotspots.byTool.some((t) => t.key === 'codex:Bash'))

  assert.equal(report.reuse.verified, 1)
  assert.equal(report.reuse.pendingAutoClaims, 1)

  // routing signal: claude-code 50% vs codex 100%, both >= 5 tasks
  assert.ok(report.suggestions.some((s) => s.includes('路由信号') && s.includes('codex')))

  // markdown is rendered with the sections
  assert.ok(report.markdown.includes('# Mio Digest'))
  assert.ok(report.markdown.includes('## Agent 表现'))
  assert.ok(report.markdown.includes('## 错误热点'))
  assert.ok(report.markdown.includes('## 可行动建议'))
})

test('digest respects project filter and window', () => {
  const home = tempDir('filter')
  seed(home)
  const engine = makeDigest(home)

  const projB = engine.generate({ days: 7, project: 'proj-b' })
  assert.equal(projB.overview.tasks, 6)
  assert.ok(projB.projects.every((p) => p.project === 'proj-b'))

  const tinyWindow = engine.generate({ days: 1 })
  assert.ok(tinyWindow.overview.tasks < 12, '1-day window must exclude older records')
})

test('MCP dispatch exposes mio.digest.generate', async () => {
  const dataDir = tempDir('mcp')
  process.env.MIO_DATA_DIR = dataDir
  process.env.MIO_CONTEXT = JSON.stringify({ agentId: 'digest-test', project: 'p' })
  const { TOOLS, callTool, rl } = require('../server/mio-intelligence-mcp/index.js')
  test.after(() => { rl.close() })

  assert.ok(TOOLS.some((tool) => tool.name === 'mio.digest.generate'))
  await callTool('mio.observer.ingest', {
    trace_id: 'd:1', event_type: 'task_outcome', outcome: 'success', project: 'p',
    payload: { summary: 'digest roundtrip' },
  })
  const result = await callTool('mio.digest.generate', { days: 7 })
  assert.equal(result.overview.tasks, 1)
  assert.ok(result.markdown.includes('digest roundtrip'))
})

test('CLI mio digest writes report file and --write-back feeds workspace contexts', () => {
  const home = tempDir('cli')
  seed(home)
  // Make the workspace basename match a real project in the digest ("proj-a").
  // Workspaces whose name is not in the digest must not be written to.
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-digest-ws-'))
  const workspaceA = path.join(wsRoot, 'proj-a')
  const workspaceUntracked = path.join(wsRoot, 'unrelated-repo')
  fs.mkdirSync(workspaceA, { recursive: true })
  fs.mkdirSync(workspaceUntracked, { recursive: true })
  fs.writeFileSync(
    path.join(home, 'observe-state.json'),
    JSON.stringify({
      version: 1,
      contexts: { [workspaceA]: [], [workspaceUntracked]: [] },
    }) + '\n',
    'utf8'
  )
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-digest-cwd-'))
  const mio = path.join(repoRoot, 'packages', 'mio-cli', 'bin', 'mio.js')
  const env = { ...process.env, MIO_HOME: home }

  const plain = spawnSync(process.execPath, [mio, 'digest', '--days', '7', '--json'], { cwd, encoding: 'utf8', env })
  assert.equal(plain.status, 0, plain.stderr)
  const payload = JSON.parse(plain.stdout)
  assert.ok(payload.reportFile && fs.existsSync(payload.reportFile), 'report persisted under MIO_HOME/digest')
  assert.ok(payload.reportFile.includes('digest-'))

  const wb = spawnSync(process.execPath, [mio, 'digest', '--days', '7', '--write-back'], { cwd, encoding: 'utf8', env })
  assert.equal(wb.status, 0, wb.stderr)
  assert.ok(wb.stdout.includes('Write-back: 1 workspace(s)'), wb.stdout)

  const agentsMd = fs.readFileSync(path.join(workspaceA, 'AGENTS.md'), 'utf8')
  assert.ok(agentsMd.includes('<!-- MIO_CONTEXT_BEGIN -->'))
  assert.ok(agentsMd.includes('digest(7d)'))
  assert.ok(agentsMd.includes('proj-a'), 'write-back line is project-scoped, not a global headline')
  const claudeMd = fs.readFileSync(path.join(workspaceA, 'CLAUDE.md'), 'utf8')
  assert.ok(claudeMd.includes('digest(7d)'))
})

test('digest --write-back never touches workspaces it has no data for', () => {
  const home = tempDir('nocross')
  seed(home)
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-digest-cross-'))
  // A workspace that appears in observe-state but has no matching digest project.
  const untracked = path.join(wsRoot, 'comfy-like-unrelated')
  fs.mkdirSync(untracked, { recursive: true })
  const preexisting = '# unrelated\n\nkeep me\n'
  fs.writeFileSync(path.join(untracked, 'AGENTS.md'), preexisting, 'utf8')
  fs.writeFileSync(
    path.join(home, 'observe-state.json'),
    JSON.stringify({ version: 1, contexts: { [untracked]: ['2026/1/1 | real history'] } }) + '\n',
    'utf8'
  )

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-digest-cwd2-'))
  const mio = path.join(repoRoot, 'packages', 'mio-cli', 'bin', 'mio.js')
  const env = { ...process.env, MIO_HOME: home }
  const wb = spawnSync(process.execPath, [mio, 'digest', '--days', '7', '--write-back'], { cwd, encoding: 'utf8', env })
  assert.equal(wb.status, 0, wb.stderr)
  assert.ok(wb.stdout.includes('0 workspace(s)'), wb.stdout)

  // The unrelated workspace file is byte-identical: no digest injected.
  assert.equal(fs.readFileSync(path.join(untracked, 'AGENTS.md'), 'utf8'), preexisting)
  assert.ok(!fs.existsSync(path.join(untracked, 'CLAUDE.md')))

  // Its recorded history also survives untouched.
  const state = JSON.parse(fs.readFileSync(path.join(home, 'observe-state.json'), 'utf8'))
  assert.deepEqual(state.contexts[untracked], ['2026/1/1 | real history'])
})

test('updateProjectContext de-duplicates repeated lines instead of filling all slots', () => {
  const observer = require('../observe/observer.js')
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-ctx-dedupe-'))
  const state = { contexts: {} }
  const same = '2026/9/12 08:56:43 | digest(7d): repeated headline'

  for (let i = 0; i < 10; i += 1) observer.updateProjectContext(state, ws, same, 'AGENTS.md')
  assert.deepEqual(state.contexts[ws], [same], 'the same line occupies exactly one slot')

  // Real history interleaved with repeats must all survive.
  observer.updateProjectContext(state, ws, '2026/9/12 09:00:00 | real task one', 'AGENTS.md')
  observer.updateProjectContext(state, ws, same, 'AGENTS.md')
  observer.updateProjectContext(state, ws, '2026/9/12 09:01:00 | real task two', 'AGENTS.md')

  const list = state.contexts[ws]
  assert.equal(new Set(list).size, list.length, 'no duplicates remain')
  assert.ok(list.includes('2026/9/12 09:00:00 | real task one'))
  assert.ok(list.includes('2026/9/12 09:01:00 | real task two'))

  const agentsMd = fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8')
  const occurrences = agentsMd.split(same).length - 1
  assert.equal(occurrences, 1, 'the repeated line is rendered once')
})

test('loadState heals duplicate context lines left by older builds', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const observer = require('../observe/observer.js')

  const home = tempDir('heal')
  fs.mkdirSync(home, { recursive: true })
  const dup = '2026/9/12 08:56:43 | digest(7d): 任务 209 条 成功率 93%, error 1'
  const rawKey = 'D:\\work\\code\\akemi-mio'
  fs.writeFileSync(
    path.join(home, 'observe-state.json'),
    JSON.stringify({
      version: 1,
      contexts: {
        [rawKey]: [dup, dup, '2026/8/30 14:02:56 | success | real history'],
      },
    }) + '\n',
    'utf8'
  )

  const state = observer.loadState(home)
  const key = observer.normalizeCwd(rawKey)
  const list = state.contexts[key]
  assert.ok(list, 'the normalised key is present')
  assert.equal(list.length, 2, 'the duplicated line collapses to one entry')
  assert.equal(new Set(list).size, list.length)
  assert.deepEqual(list, [dup, '2026/8/30 14:02:56 | success | real history'])
})

test('normalizeCwd unifies drive-letter case and separators', () => {
  const observer = require('../observe/observer.js')
  const canonical = 'D:\\work\\code\\akemi-mio'
  assert.equal(observer.normalizeCwd('D:\\work\\code\\akemi-mio'), canonical)
  assert.equal(observer.normalizeCwd('d:\\work\\code\\akemi-mio'), canonical)
  assert.equal(observer.normalizeCwd('D:/work/code/akemi-mio'), canonical)
  assert.equal(observer.normalizeCwd('D:\\work\\\\code\\akemi-mio\\'), canonical)
  // Separators are unified even for paths without a drive letter.
  assert.equal(observer.normalizeCwd('/home/user/proj'), '\\home\\user\\proj')
  // Non-strings pass through untouched rather than throwing.
  assert.equal(observer.normalizeCwd(null), null)
})

test('loadState merges buckets split by path spelling', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const observer = require('../observe/observer.js')

  const home = tempDir('merge')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(
    path.join(home, 'observe-state.json'),
    JSON.stringify({
      version: 1,
      contexts: {
        'D:\\work\\code\\akemi-mio': ['2026/9/12 10:00:00 | success | upper drive history'],
        'd:\\work\\code\\akemi-mio': ['2026/9/12 09:00:00 | success | lower drive history'],
        'D:/work/code/akemi-mio': ['2026/9/12 08:00:00 | success | slash history'],
        'D:\\work\\code\\other': ['2026/9/12 07:00:00 | success | unrelated project'],
      },
    }) + '\n',
    'utf8'
  )

  const state = observer.loadState(home)
  const merged = state.contexts['D:\\work\\code\\akemi-mio']
  assert.ok(merged, 'the three spellings collapse into the canonical key')
  assert.equal(merged.length, 3, 'all three histories are preserved')
  assert.ok(merged.includes('2026/9/12 10:00:00 | success | upper drive history'))
  assert.ok(merged.includes('2026/9/12 09:00:00 | success | lower drive history'))
  assert.ok(merged.includes('2026/9/12 08:00:00 | success | slash history'))
  // No leftover split buckets.
  const spellings = new Set(Object.keys(state.contexts).map((k) => observer.normalizeCwd(k)))
  assert.equal(spellings.size, Object.keys(state.contexts).length, 'no two keys normalise to the same value')
  // The unrelated project is untouched.
  assert.ok(state.contexts['D:\\work\\code\\other'])
})

test('merging keeps the newest entries when the union overflows CONTEXT_MAX', () => {
  const observer = require('../observe/observer.js')
  // Two spellings of one project. The "older" bucket holds August, the "newer"
  // one holds September, so a positional merge would keep whichever bucket came
  // first in key order instead of the genuinely recent work.
  const older = [
    '2026/8/11 10:00:01 | success | older work 1',
    '2026/8/12 10:00:02 | success | older work 2',
    '2026/8/13 10:00:03 | success | older work 3',
    '2026/8/14 10:00:04 | success | older work 4',
    '2026/8/15 10:00:05 | success | older work 5',
    '2026/8/16 10:00:06 | success | older work 6',
  ]
  const newer = [
    '2026/9/21 10:00:01 | success | newer work 1',
    '2026/9/22 10:00:02 | success | newer work 2',
    '2026/9/23 10:00:03 | success | newer work 3',
    '2026/9/24 10:00:04 | success | newer work 4',
    '2026/9/25 10:00:05 | success | newer work 5',
    '2026/9/26 10:00:06 | success | newer work 6',
  ]
  const state = {
    contexts: {
      'D:\\work\\code\\trim': older,
      'd:\\work\\code\\trim': newer,
    },
  }

  observer.updateProjectContext(state, 'D:\\work\\code\\trim', '2026/9/30 12:00:00 | success | brand new', 'AGENTS.md')

  const list = state.contexts['D:\\work\\code\\trim']
  assert.equal(list.length, 6, 'trimmed to CONTEXT_MAX')
  assert.equal(list[0], '2026/9/30 12:00:00 | success | brand new', 'newest line first')

  // The five most recent September entries plus the fresh write survive.
  assert.deepEqual(list, [
    '2026/9/30 12:00:00 | success | brand new',
    '2026/9/26 10:00:06 | success | newer work 6',
    '2026/9/25 10:00:05 | success | newer work 5',
    '2026/9/24 10:00:04 | success | newer work 4',
    '2026/9/23 10:00:03 | success | newer work 3',
    '2026/9/22 10:00:02 | success | newer work 2',
  ])
  assert.ok(!list.some((l) => l.includes('older work')), 'stale August entries are dropped, not kept by bucket order')

  // Ordering is descending by the embedded timestamp.
  const stamps = list.map((l) => observer.contextTimestamp(l))
  assert.deepEqual(stamps, [...stamps].sort((a, b) => b - a))
})

test('contextTimestamp parses the line stamp and rejects unstamped lines', () => {
  const observer = require('../observe/observer.js')
  assert.equal(observer.contextTimestamp('2026/9/12 21:30:05 | success | x'), new Date(2026, 8, 12, 21, 30, 5).getTime())
  assert.equal(observer.contextTimestamp('2026/12/1 09:05:00 | success | x'), new Date(2026, 11, 1, 9, 5, 0).getTime())
  assert.equal(observer.contextTimestamp('no stamp here'), null)
  assert.equal(observer.contextTimestamp(''), null)
  assert.equal(observer.contextTimestamp(null), null)
})

test('updateProjectContext heals stale duplicates present in a raw state object', () => {
  const observer = require('../observe/observer.js')
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-ctx-heal-'))
  const dup = '2026/9/12 08:56:43 | digest(7d): 任务 209 条 成功率 93%, error 1'
  // Simulates a state read straight off disk (bypassing loadState), which is
  // exactly how the digest write-back loads it.
  const state = {
    contexts: {
      [ws]: [dup, dup, dup, '2026/8/30 14:02:56 | success | real history one', '2026/8/30 12:43:14 | success | real history two'],
    },
  }

  observer.updateProjectContext(state, ws, '2026/9/12 21:00:00 | fresh line', 'AGENTS.md')

  const list = state.contexts[ws]
  assert.equal(new Set(list).size, list.length, 'no duplicates after a write')
  assert.equal(list[0], '2026/9/12 21:00:00 | fresh line')
  // Real history is preserved rather than being squeezed out by repeats.
  assert.ok(list.includes('2026/8/30 14:02:56 | success | real history one'))
  assert.ok(list.includes('2026/8/30 12:43:14 | success | real history two'))
})

test('updateProjectContext merges split buckets when writing through either spelling', () => {
  const observer = require('../observe/observer.js')
  const wsUpper = 'D:\\work\\code\\merged-proj'
  const wsLower = 'd:\\work\\code\\merged-proj'
  const wsSlash = 'D:/work/code/merged-proj'
  const state = {
    contexts: {
      [wsUpper]: ['2026/9/12 10:00:00 | success | from upper'],
      [wsLower]: ['2026/9/12 09:00:00 | success | from lower'],
      [wsSlash]: ['2026/9/12 08:00:00 | success | from slash'],
    },
  }

  // Write through the lower-case spelling; all three must collapse.
  observer.updateProjectContext(state, wsLower, '2026/9/12 11:00:00 | success | fresh', 'AGENTS.md')

  const keys = Object.keys(state.contexts)
  assert.equal(keys.length, 1, 'all spellings collapse to a single bucket')
  assert.equal(keys[0], wsUpper, 'the canonical spelling is used')
  const list = state.contexts[keys[0]]
  assert.equal(list.length, 4, 'every unique history line survives the merge')
  assert.equal(list[0], '2026/9/12 11:00:00 | success | fresh')
  assert.ok(list.includes('2026/9/12 10:00:00 | success | from upper'))
  assert.ok(list.includes('2026/9/12 09:00:00 | success | from lower'))
  assert.ok(list.includes('2026/9/12 08:00:00 | success | from slash'))
})
