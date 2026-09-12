'use strict'

// Digest: turn the accumulated MIO_HOME data (traces, memory, reuse evidence)
// into an actionable report. Deterministic aggregation only — no LLM. The
// report answers: what got done, where the errors are, which agent performs
// best, and what deserves attention next.

const fs = require('fs')
const path = require('path')

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

function isVerifiedReuse(record) {
  return (
    (record.reuse === true || record.reuse === 'true') &&
    (record.behaviorChanged === true || record.behaviorChanged === 'true') &&
    (record.outcomeImproved === true || record.outcomeImproved === 'true')
  )
}

function createDigest(options = {}) {
  const home = options.home
  const now = options.now || (() => Date.now())

  function generate(args = {}) {
    const days = Math.max(1, Number(args.days) || 7)
    const project = args.project ? String(args.project) : null
    const atTime = now()
    const cutoff = atTime - days * 86400000

    const traces = readJsonl(path.join(home, 'traces.jsonl')).filter((trace) => {
      if (!trace || typeof trace !== 'object') return false
      const ts = Date.parse(trace.timestamp || '')
      if (!(Number.isFinite(ts) && ts >= cutoff)) return false
      if (project && trace.project !== project) return false
      return true
    })

    const outcomes = traces.filter((t) => String(t.event_type || '').toLowerCase() === 'task_outcome')
    const errors = traces.filter((t) => String(t.event_type || '').toLowerCase() === 'error')

    // --- per-agent performance ---
    const agentMap = new Map()
    for (const outcome of outcomes) {
      const agent = String(outcome.agent || 'unknown')
      let entry = agentMap.get(agent)
      if (!entry) {
        entry = { agent, total: 0, success: 0, failure: 0, aborted: 0 }
        agentMap.set(agent, entry)
      }
      entry.total += 1
      const oc = String(outcome.outcome || 'none').toLowerCase()
      if (oc === 'success') entry.success += 1
      else if (oc === 'failure' || oc === 'error') entry.failure += 1
      else entry.aborted += 1
    }
    const agents = [...agentMap.values()]
      .map((entry) => ({
        ...entry,
        successRate: entry.total > 0 ? Math.round((entry.success / entry.total) * 100) : 0,
      }))
      .sort((a, b) => b.total - a.total)

    // --- error hotspots ---
    const errorByAgent = new Map()
    const errorByTool = new Map()
    for (const error of errors) {
      const agent = String(error.agent || 'unknown')
      errorByAgent.set(agent, (errorByAgent.get(agent) || 0) + 1)
      const tool =
        (error.payload && (error.payload.tool || error.payload.toolUseId || error.payload.status)) ||
        'unknown'
      const key = agent + ':' + String(tool)
      errorByTool.set(key, (errorByTool.get(key) || 0) + 1)
    }
    const errorHotspots = {
      total: errors.length,
      byAgent: [...errorByAgent.entries()]
        .map(([agent, count]) => ({ agent, count }))
        .sort((a, b) => b.count - a.count),
      byTool: [...errorByTool.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
    }

    // --- project activity ---
    const projectMap = new Map()
    for (const outcome of outcomes) {
      const name = String(outcome.project || 'unknown')
      let entry = projectMap.get(name)
      if (!entry) {
        entry = { project: name, tasks: 0, success: 0, lastAt: null, recent: [] }
        projectMap.set(name, entry)
      }
      entry.tasks += 1
      if (String(outcome.outcome || '').toLowerCase() === 'success') entry.success += 1
      const ts = Date.parse(outcome.timestamp || '')
      if (Number.isFinite(ts) && (!entry.lastAt || ts > entry.lastAt)) entry.lastAt = ts
      const summary = outcome.payload && outcome.payload.summary
      if (summary && entry.recent.length < 3) {
        entry.recent.push({
          at: outcome.timestamp,
          agent: outcome.agent,
          outcome: outcome.outcome,
          summary: String(summary).slice(0, 160),
        })
      }
    }
    const projects = [...projectMap.values()]
      .map((entry) => ({ ...entry, lastAt: entry.lastAt ? new Date(entry.lastAt).toISOString() : null }))
      .sort((a, b) => b.tasks - a.tasks)

    // --- reuse evidence ---
    const reuseRecords = readJsonl(path.join(home, 'experience_reuse.jsonl')).filter((record) => {
      if (!record || typeof record !== 'object') return false
      if (project && record.project !== project) return false
      const ts = Date.parse(record.timestamp || '')
      return Number.isFinite(ts) && ts >= cutoff
    })
    const reuse = {
      verified: reuseRecords.filter(isVerifiedReuse).length,
      pendingAutoClaims: reuseRecords.filter(
        (record) => record.source === 'auto_claim' && record.confirmed !== true
      ).length,
      total: reuseRecords.length,
    }

    // --- rule-based suggestions (facts first, thresholds conservative) ---
    const suggestions = []
    const reliable = agents.filter((a) => a.total >= 5)
    if (reliable.length >= 2) {
      const best = reliable.reduce((a, b) => (b.successRate > a.successRate ? b : a))
      const worst = reliable.reduce((a, b) => (b.successRate < a.successRate ? b : a))
      if (best.successRate - worst.successRate >= 20) {
        suggestions.push(
          `路由信号: ${best.agent} 成功率 ${best.successRate}% vs ${worst.agent} ${worst.successRate}%（近 ${days} 天），同类任务优先路由给 ${best.agent}。`
        )
      }
    }
    if (errorHotspots.total >= 5 && errorHotspots.byAgent.length > 0) {
      const top = errorHotspots.byAgent[0]
      suggestions.push(
        `错误热点: ${top.agent} 近 ${days} 天产生 ${top.count} 条 error trace${errorHotspots.byTool.length > 0 ? `（高发: ${errorHotspots.byTool[0].key} x${errorHotspots.byTool[0].count}）` : ''}，优先排查。`
      )
    }
    if (reuse.pendingAutoClaims >= 10) {
      suggestions.push(
        `待确认: ${reuse.pendingAutoClaims} 条 auto-claim 经验复用未确认，运行 mio.experience.confirm 提升证据质量。`
      )
    }

    const report = {
      generatedAt: new Date(atTime).toISOString(),
      periodDays: days,
      project: project || 'all',
      overview: {
        tasks: outcomes.length,
        byOutcome: outcomes.reduce((acc, t) => {
          const oc = String(t.outcome || 'none').toLowerCase()
          acc[oc] = (acc[oc] || 0) + 1
          return acc
        }, {}),
        errorTraces: errors.length,
        activeAgents: agents.length,
        activeProjects: projects.length,
      },
      agents,
      errorHotspots,
      projects,
      reuse,
      suggestions,
    }
    report.markdown = renderMarkdown(report)

    // Persist a machine-readable snapshot for consumers that should not
    // recompute the aggregation — notably mio.task.route's agent-health signal.
    try {
      const digestDir = path.join(home, 'digest')
      fs.mkdirSync(digestDir, { recursive: true })
      const snapshot = { ...report }
      delete snapshot.markdown
      fs.writeFileSync(path.join(digestDir, 'latest.json'), JSON.stringify(snapshot) + '\n', 'utf8')
    } catch (_) {
      // best-effort persistence; the in-memory report is still returned
    }
    return report
  }

  function renderMarkdown(report) {
    const lines = []
    const from = new Date(Date.parse(report.generatedAt) - report.periodDays * 86400000)
      .toISOString()
      .slice(0, 10)
    const to = report.generatedAt.slice(0, 10)
    lines.push(`# Mio Digest (${from} ~ ${to}, project=${report.project})`)
    lines.push('')
    const ov = report.overview
    const rate = ov.tasks > 0 ? Math.round(((ov.byOutcome.success || 0) / ov.tasks) * 100) : 0
    lines.push(
      `- 任务 ${ov.tasks} 条（success ${ov.byOutcome.success || 0} / failure ${ov.byOutcome.failure || 0} / aborted ${ov.byOutcome.aborted || 0}，成功率 ${rate}%），error trace ${ov.errorTraces} 条`
    )
    lines.push(`- 活跃 agent ${ov.activeAgents} 个，活跃项目 ${ov.activeProjects} 个`)
    lines.push('')

    if (report.agents.length > 0) {
      lines.push('## Agent 表现')
      lines.push('')
      lines.push('| agent | 任务 | 成功 | 失败 | 中止 | 成功率 |')
      lines.push('|---|---|---|---|---|---|')
      for (const a of report.agents) {
        lines.push(`| ${a.agent} | ${a.total} | ${a.success} | ${a.failure} | ${a.aborted} | ${a.successRate}% |`)
      }
      lines.push('')
    }

    if (report.projects.length > 0) {
      lines.push('## 项目动态')
      lines.push('')
      for (const p of report.projects) {
        const lastAt = p.lastAt ? p.lastAt.slice(0, 16).replace('T', ' ') : '-'
        lines.push(`### ${p.project}（${p.tasks} 任务，最近 ${lastAt}）`)
        for (const task of p.recent) {
          const at = task.at ? task.at.slice(5, 16).replace('T', ' ') : ''
          lines.push(`- [${task.outcome}] (${at} ${task.agent}) ${task.summary}`)
        }
        lines.push('')
      }
    }

    if (report.errorHotspots.total > 0) {
      lines.push('## 错误热点')
      lines.push('')
      for (const item of report.errorHotspots.byAgent) {
        lines.push(`- ${item.agent}: ${item.count} 条`)
      }
      const tools = report.errorHotspots.byTool.slice(0, 5)
      if (tools.length > 0) {
        lines.push(`- 高发位置: ${tools.map((t) => `${t.key} x${t.count}`).join(', ')}`)
      }
      lines.push('')
    }

    lines.push('## 经验复用')
    lines.push('')
    lines.push(`- verified ${report.reuse.verified} / pending auto-claim ${report.reuse.pendingAutoClaims} / total ${report.reuse.total}`)
    lines.push('')

    if (report.suggestions.length > 0) {
      lines.push('## 可行动建议')
      lines.push('')
      for (const suggestion of report.suggestions) {
        lines.push(`- ${suggestion}`)
      }
      lines.push('')
    }

    return lines.join('\n')
  }

  return { generate, renderMarkdown }
}

module.exports = { createDigest }
