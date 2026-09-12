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
  const workspaceA = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-digest-ws-'))
  // observe-state records workspaceA as an active context cwd
  fs.writeFileSync(
    path.join(home, 'observe-state.json'),
    JSON.stringify({ version: 1, contexts: { [workspaceA]: [] } }) + '\n',
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
  assert.ok(wb.stdout.includes('Write-back: 1 workspace(s)'))

  const agentsMd = fs.readFileSync(path.join(workspaceA, 'AGENTS.md'), 'utf8')
  assert.ok(agentsMd.includes('<!-- MIO_CONTEXT_BEGIN -->'))
  assert.ok(agentsMd.includes('digest(7d)'))
  const claudeMd = fs.readFileSync(path.join(workspaceA, 'CLAUDE.md'), 'utf8')
  assert.ok(claudeMd.includes('digest(7d)'))
})
