'use strict'

// mio evolution report -- the CLI entry point for mio.evolution.report.
//
// The report logic itself is covered by
// server/mio-intelligence-mcp/__tests__/evolution-report.test.js; these tests cover the
// CLI wiring: flag handling, --json shape, and the human-readable render.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const CLI = path.resolve(__dirname, '..', 'bin', 'mio.js')
const { formatEvolutionReportText } = require('../server/evolution-report.js')

const PROJECT = 'cli-report-proj'
const now = Date.now()
const iso = (msAgo) => new Date(now - msAgo).toISOString()

function writeJsonl(dir, name, records) {
  fs.writeFileSync(
    path.join(dir, name),
    records.length > 0 ? records.map((r) => JSON.stringify(r)).join('\n') + '\n' : '',
    'utf8'
  )
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-cli-report-'))
  writeJsonl(home, 'traces.jsonl', [
    { id: 't1', timestamp: iso(1000), trace_id: 'a:1', event_type: 'task_outcome', outcome: 'success', agent: 'codex', project: PROJECT },
    { id: 't2', timestamp: iso(2000), trace_id: 'a:2', event_type: 'task_outcome', outcome: 'failure', agent: 'codex', project: PROJECT },
    { id: 't3', timestamp: iso(3000), trace_id: 'b:1', event_type: 'task_outcome', outcome: 'success', agent: 'opencode', project: PROJECT },
  ])
  writeJsonl(home, 'memory.jsonl', [
    { id: 'm1', timestamp: iso(4000), kind: 'decision', content: 'A sufficiently long decision record for the quality check', project: PROJECT, source: 'codex' },
  ])
  writeJsonl(home, 'experience_reuse.jsonl', [
    { id: 'r1', timestamp: iso(5000), sourceAgent: 'codex', targetAgent: 'opencode', reuse: true, behaviorChanged: true, outcomeImproved: true, confirmed: true, project: PROJECT, source: 'agent_report' },
  ])
  writeJsonl(home, 'agents.jsonl', [
    { id: 'a1', agentId: 'codex', hostType: 'mcp', registeredAt: iso(6000), lastSeenAt: iso(7000), sessionCount: 2, project: PROJECT },
  ])
  return home
}

function runCli(args, home) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, MIO_HOME: home },
  })
}

test('mio evolution report --json returns the shared report shape', () => {
  const r = runCli(['--json', 'evolution', 'report', '--project', PROJECT], makeHome())
  assert.equal(r.status, 0, r.stderr)
  const payload = JSON.parse(r.stdout)
  assert.equal(payload.project, PROJECT)
  assert.equal(payload.period, 'all')
  assert.equal(payload.ecosystem.agents, 2)
  assert.equal(payload.ecosystem.totalTasks, 3)
  assert.equal(payload.ecosystem.successRate, 67)
  assert.equal(payload.ecosystem.verifiedReuses, 1)
  assert.ok(payload.generatedAt)
})

test('mio evolution report respects --period', () => {
  const home = makeHome()
  writeJsonl(home, 'traces.jsonl', [
    { id: 'old', timestamp: iso(10 * 86400000), trace_id: 'old:1', event_type: 'task_outcome', outcome: 'success', agent: 'codex', project: PROJECT },
    { id: 'new', timestamp: iso(1000), trace_id: 'new:1', event_type: 'task_outcome', outcome: 'success', agent: 'codex', project: PROJECT },
  ])
  const r = runCli(['--json', 'evolution', 'report', '--project', PROJECT, '--period', '24h'], home)
  assert.equal(r.status, 0, r.stderr)
  const payload = JSON.parse(r.stdout)
  assert.equal(payload.period, '24h')
  assert.equal(payload.ecosystem.totalTasks, 1)
})

test('mio evolution report rejects an unknown --period', () => {
  const r = runCli(['evolution', 'report', '--period', '5d'], makeHome())
  assert.equal(r.status, 1)
  assert.match(r.stderr, /--period must be one of/)
})

test('mio evolution report renders the same numbers it reports as JSON', () => {
  const home = makeHome()
  const text = runCli(['evolution', 'report', '--project', PROJECT], home)
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /Evolution report -- project cli-report-proj, period all/)
  assert.match(text.stdout, /success rate 67%/)
  // 必须锚定到 reuses 那一行：别的段落也含 "verified N"，宽泛匹配会假通过
  assert.match(text.stdout, /reuses\s+1 \(verified 1, pending 0\)/)
  assert.match(text.stdout, /codex/)
  // 渲染出的数字必须与 --json 一致（同一个 report() 产物）
  const json = JSON.parse(runCli(['--json', 'evolution', 'report', '--project', PROJECT], home).stdout)
  assert.match(text.stdout, new RegExp(`tasks\\s+${json.ecosystem.totalTasks}\\b`))
  assert.match(text.stdout, new RegExp(`agents\\s+${json.ecosystem.agents}\\b`))
})

test('formatEvolutionReportText handles the empty state without throwing', () => {
  const empty = formatEvolutionReportText({
    project: 'p',
    generatedAt: '2026-01-01T00:00:00.000Z',
    period: 'all',
    ecosystem: { agents: 0, totalTasks: 0, successRate: 0, totalMemories: 0, totalReuses: 0, verifiedReuses: 0, pendingReuses: 0 },
    agentPerformance: [],
    crossAgentPatterns: [],
    memoryHealth: { total: 0, byKind: {}, shortContent: 0, missingKind: 0, qualityScore: 100 },
    suggestions: [],
  })
  assert.match(empty, /\(no agents seen in this window\)/)
  assert.match(empty, /\(none\)/)
  assert.match(empty, /quality 100%/)
})
