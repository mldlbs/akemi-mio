'use strict'

// Cross-agent evolution report (ADR-017 Evolution plane).
//
// Shared by the MCP tool `mio.evolution.report` and the CLI `mio evolution report`
// so the two cannot drift. Dependencies are injected -- the MCP server resolves
// its data directory from MIO_DATA_DIR while the CLI uses MIO_HOME, and each has
// its own projectName() -- so this module owns no path or environment policy.

const fs = require('fs')
const path = require('path')

const REPORT_FILES = {
  memory: 'memory.jsonl',
  trace: 'traces.jsonl',
  reuse: 'experience_reuse.jsonl',
  agent: 'agents.jsonl',
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch (_) {
        return null
      }
    })
    .filter(Boolean)
}

const PERIOD_MS = {
  '24h': 86400000,
  '7d': 604800000,
  '30d': 2592000000,
}

function createEvolutionReport({ dataDir, projectName }) {
  const files = {
    memory: path.join(dataDir, REPORT_FILES.memory),
    trace: path.join(dataDir, REPORT_FILES.trace),
    reuse: path.join(dataDir, REPORT_FILES.reuse),
    agent: path.join(dataDir, REPORT_FILES.agent),
  }

  function report(args = {}) {
    const project = args.project || projectName()
    const period = String(args.period || 'all').trim()
    const now = Date.now()
    const periodMs = PERIOD_MS[period] === undefined ? Infinity : PERIOD_MS[period]
    const cutoff = periodMs === Infinity ? 0 : now - periodMs

    const memories = readJsonl(files.memory).filter((m) => !project || m.project === project || !m.project)
    const traces = readJsonl(files.trace).filter((t) => !project || t.project === project)
    const reuses = readJsonl(files.reuse).filter((r) => !project || r.project === project)
    const agents = readJsonl(files.agent).filter((a) => !project || a.project === project)

    const filteredTraces = cutoff ? traces.filter((t) => new Date(t.timestamp).getTime() >= cutoff) : traces
    const filteredMemories = cutoff ? memories.filter((m) => new Date(m.timestamp).getTime() >= cutoff) : memories

    // Ecosystem summary
    const agentIds = new Set()
    filteredTraces.forEach((t) => { if (t.agent) agentIds.add(t.agent) })
    agents.forEach((a) => agentIds.add(a.agentId))
    const outcomes = filteredTraces.filter((t) => t.event_type === 'task_outcome')
    const successes = outcomes.filter((t) => t.outcome === 'success').length
    const failures = outcomes.filter((t) => t.outcome === 'failure').length
    const verifiedReuses = reuses.filter((r) => r.confirmed && r.reuse && r.behaviorChanged && r.outcomeImproved)
    const pendingReuses = reuses.filter((r) => r.source === 'auto_claim' && !r.confirmed)

    const ecosystem = {
      agents: agentIds.size,
      totalTasks: outcomes.length,
      successRate: outcomes.length > 0 ? Math.round((successes / outcomes.length) * 100) : 0,
      totalMemories: filteredMemories.length,
      totalReuses: reuses.length,
      verifiedReuses: verifiedReuses.length,
      pendingReuses: pendingReuses.length,
    }

    // Agent performance comparison
    const agentPerf = []
    for (const agentId of agentIds) {
      const agentTraces = filteredTraces.filter((t) => t.agent === agentId)
      const agentOutcomes = agentTraces.filter((t) => t.event_type === 'task_outcome')
      const agentSuccesses = agentOutcomes.filter((t) => t.outcome === 'success').length
      const agentFailures = agentOutcomes.filter((t) => t.outcome === 'failure').length
      const agentMemories = filteredMemories.filter((m) => m.source === agentId)
      const agentVerified = reuses.filter((r) =>
        (r.sourceAgent === agentId || r.targetAgent === agentId) && r.confirmed && r.reuse && r.behaviorChanged && r.outcomeImproved
      )
      const reg = agents.find((a) => a.agentId === agentId)
      agentPerf.push({
        agentId,
        tasks: {
          total: agentOutcomes.length,
          success: agentSuccesses,
          failure: agentFailures,
          successRate: agentOutcomes.length > 0 ? Math.round((agentSuccesses / agentOutcomes.length) * 100) : 0,
        },
        memories: agentMemories.length,
        verifiedReuses: agentVerified.length,
        registered: !!reg,
        lastActive: reg ? reg.lastSeenAt : (agentTraces.length > 0 ? agentTraces[agentTraces.length - 1].timestamp : null),
      })
    }
    agentPerf.sort((a, b) => b.tasks.successRate - a.tasks.successRate || b.tasks.total - a.tasks.total)

    // Cross-agent patterns
    const crossPatterns = []
    const reuseByPair = {}
    for (const r of reuses) {
      const key = r.sourceAgent + '->' + r.targetAgent
      if (!reuseByPair[key]) reuseByPair[key] = { source: r.sourceAgent, target: r.targetAgent, total: 0, verified: 0, improved: 0 }
      reuseByPair[key].total++
      if (r.confirmed) reuseByPair[key].verified++
      if (r.outcomeImproved) reuseByPair[key].improved++
    }
    for (const [key, pair] of Object.entries(reuseByPair)) {
      if (pair.source !== pair.target) {
        crossPatterns.push({
          type: 'reuse_path',
          from: pair.source,
          to: pair.target,
          total: pair.total,
          verified: pair.verified,
          improved: pair.improved,
        })
      }
    }
    crossPatterns.sort((a, b) => b.verified - a.verified || b.total - a.total)

    // Memory health
    const byKind = {}
    let shortContent = 0
    let missingKind = 0
    for (const m of filteredMemories) {
      const kind = m.kind || 'unknown'
      byKind[kind] = (byKind[kind] || 0) + 1
      const content = String(m.content || '').trim()
      if (content.length < 20) shortContent++
      if (!m.kind) missingKind++
    }
    const memoryHealth = {
      total: filteredMemories.length,
      byKind,
      shortContent,
      missingKind,
      qualityScore: filteredMemories.length > 0
        ? Math.round(((filteredMemories.length - shortContent - missingKind) / filteredMemories.length) * 100)
        : 100,
    }

    // Suggestions engine
    const suggestions = []

    // Routing suggestion: compare agent success rates
    if (agentPerf.length >= 2) {
      const best = agentPerf[0]
      const worst = agentPerf[agentPerf.length - 1]
      if (best.tasks.total >= 5 && worst.tasks.total >= 5 && best.tasks.successRate - worst.tasks.successRate >= 15) {
        suggestions.push({
          category: 'routing',
          priority: 'high',
          description: best.agentId + ' has ' + best.tasks.successRate + '% success rate vs ' + worst.agentId + ' at ' + worst.tasks.successRate + '%; prefer routing to ' + best.agentId,
          basedOn: 'task_outcome comparison',
        })
      }
    }

    // Pending auto-claim suggestion
    if (pendingReuses.length >= 10) {
      suggestions.push({
        category: 'evidence',
        priority: 'medium',
        description: pendingReuses.length + ' pending auto-claims awaiting confirmation; review cross-agent claims to increase verified reuse count',
        basedOn: 'experience_reuse.jsonl',
      })
    }

    // Memory quality suggestion
    if (memoryHealth.qualityScore < 80 && filteredMemories.length > 10) {
      suggestions.push({
        category: 'memory',
        priority: 'medium',
        description: 'Memory quality score is ' + memoryHealth.qualityScore + '%; ' + shortContent + ' short records and ' + missingKind + ' missing kind fields found',
        basedOn: 'memory.jsonl quality analysis',
      })
    }

    // Cross-agent value suggestion
    if (crossPatterns.length === 0 && agentIds.size >= 2) {
      suggestions.push({
        category: 'interop',
        priority: 'high',
        description: 'Multiple agents registered but no cross-agent reuse patterns detected; ensure agents query shared memory',
        basedOn: 'experience_reuse.jsonl',
      })
    }

    // Active agent suggestion
    const inactiveAgents = agentPerf.filter((a) => {
      if (!a.lastActive) return false
      return (now - new Date(a.lastActive).getTime()) > 7 * 86400000
    })
    if (inactiveAgents.length > 0) {
      suggestions.push({
        category: 'coverage',
        priority: 'low',
        description: inactiveAgents.map((a) => a.agentId).join(', ') + ' inactive for >7 days; consider removal or reactivation',
        basedOn: 'agent registry lastSeenAt',
      })
    }

    suggestions.sort((a, b) => {
      const p = { high: 0, medium: 1, low: 2 }
      return (p[a.priority] || 2) - (p[b.priority] || 2)
    })

    return {
      project,
      generatedAt: new Date().toISOString(),
      period,
      ecosystem,
      agentPerformance: agentPerf,
      crossAgentPatterns: crossPatterns,
      memoryHealth,
      suggestions,
    }
  }

  return { report }
}

function formatEvolutionReportText(result) {
  const lines = []
  lines.push(`Evolution report -- project ${result.project || '(all)'}, period ${result.period}`)
  lines.push(`Generated ${result.generatedAt}`)

  const eco = result.ecosystem
  lines.push('')
  lines.push('Ecosystem')
  lines.push(`  agents           ${eco.agents}`)
  lines.push(`  tasks            ${eco.totalTasks}${eco.totalTasks > 0 ? ` (success rate ${eco.successRate}%)` : ''}`)
  lines.push(`  memories         ${eco.totalMemories}`)
  lines.push(`  reuses           ${eco.totalReuses} (verified ${eco.verifiedReuses}, pending ${eco.pendingReuses})`)

  lines.push('')
  lines.push('Agent performance')
  if (result.agentPerformance.length === 0) {
    lines.push('  (no agents seen in this window)')
  } else {
    for (const a of result.agentPerformance) {
      const reg = a.registered ? 'registered' : 'unregistered'
      lines.push(
        `  ${a.agentId.padEnd(12)} tasks ${String(a.tasks.total).padStart(3)}` +
        `  success ${String(a.tasks.successRate).padStart(3)}%` +
        `  memories ${String(a.memories).padStart(3)}` +
        `  verified reuses ${a.verifiedReuses}  (${reg})`
      )
    }
  }

  lines.push('')
  lines.push('Cross-agent patterns')
  if (result.crossAgentPatterns.length === 0) {
    lines.push('  (none)')
  } else {
    for (const p of result.crossAgentPatterns) {
      lines.push(`  ${p.from} -> ${p.to}   total ${p.total}  verified ${p.verified}  improved ${p.improved}`)
    }
  }

  const mh = result.memoryHealth
  lines.push('')
  lines.push('Memory health')
  lines.push(`  quality ${mh.qualityScore}%   total ${mh.total}   short ${mh.shortContent}   missing kind ${mh.missingKind}`)
  const kinds = Object.entries(mh.byKind)
  if (kinds.length > 0) {
    lines.push(`  by kind: ${kinds.map(([k, n]) => `${k} ${n}`).join(', ')}`)
  }

  lines.push('')
  lines.push('Suggestions')
  if (result.suggestions.length === 0) {
    lines.push('  (none)')
  } else {
    for (const s of result.suggestions) {
      lines.push(`  [${s.priority}] ${s.category}: ${s.description}`)
    }
  }

  return lines.join('\n')
}

module.exports = {
  createEvolutionReport,
  formatEvolutionReportText,
}
