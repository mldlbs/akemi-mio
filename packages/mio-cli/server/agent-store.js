'use strict'

// Shared agent store: the single implementation behind mio.agent.list /
// register / report, consumed by both the MCP server and the CLI
// (`mio agents list` / `mio agents report`). It owns agents.jsonl plus the
// read-only cross-references the report needs (traces, memory, experience
// reuse). Extracted from mio-intelligence-mcp/index.js so the terminal and the
// MCP tool can never report different agent telemetry.
//
// Two distinct "agent" notions live in this repo and the CLI must not confuse
// them: `mio agents` (no subcommand) lists installed host adapters from
// config.json, while this store reports *observed* agents recorded in
// agents.jsonl. `mio agents list` / `report` are about the latter.

const path = require('path')
const { createId, readJsonlCached, appendJsonl, writeJsonl } = require('./memory-store.js')

function createAgentStore(options) {
  const dataDir = options.dataDir
  const projectName = options.projectName || (() => null)

  const agentsPath = path.join(dataDir, 'agents.jsonl')
  const tracePath = path.join(dataDir, 'traces.jsonl')
  const memoryPath = path.join(dataDir, 'memory.jsonl')
  const experienceReusePath = path.join(dataDir, 'experience_reuse.jsonl')

  function listAgents(args = {}) {
    const project = args.project || null
    let agents = readJsonlCached(agentsPath)
    if (project) agents = agents.filter((a) => a.project === project)
    return {
      count: agents.length,
      agents: agents.map((a) => ({
        id: a.id,
        agentId: a.agentId,
        hostType: a.hostType,
        capabilities: a.capabilities,
        registeredAt: a.registeredAt,
        lastSeenAt: a.lastSeenAt,
        sessionCount: a.sessionCount,
        taskCount: a.taskCount || 0,
        successCount: a.successCount || 0,
        failureCount: a.failureCount || 0,
        project: a.project,
      })),
    }
  }

  function reportAgent(args = {}) {
    const targetAgent = args.agentId || null
    const project = args.project || projectName()
    const agents = readJsonlCached(agentsPath)
    const filtered = agents.filter(
      (a) => (!targetAgent || a.agentId === targetAgent) && (!project || a.project === project)
    )
    const traces = readJsonlCached(tracePath)
    const memories = readJsonlCached(memoryPath)
    const reuses = readJsonlCached(experienceReusePath)
    const reports = filtered.map((agent) => {
      const agentTraces = traces.filter((t) => t.agent === agent.agentId)
      const outcomes = agentTraces.filter((t) => t.event_type === 'task_outcome')
      const successes = outcomes.filter((t) => t.outcome === 'success').length
      const failures = outcomes.filter((t) => t.outcome === 'failure').length
      const agentMemories = memories.filter((m) => m.source === agent.agentId)
      const agentReuses = reuses.filter(
        (r) => r.sourceAgent === agent.agentId || r.targetAgent === agent.agentId
      )
      const verified = agentReuses.filter(
        (r) => r.confirmed && r.reuse && r.behaviorChanged && r.outcomeImproved
      )
      const regTasks = agent.taskCount || 0
      const regSuccess = agent.successCount || 0
      const regFail = agent.failureCount || 0
      const taskTotal = regTasks > 0 ? regTasks : outcomes.length
      const taskSuccess = regTasks > 0 ? regSuccess : successes
      const taskFail = regTasks > 0 ? regFail : failures
      return {
        agentId: agent.agentId,
        hostType: agent.hostType,
        sessionCount: agent.sessionCount,
        registeredAt: agent.registeredAt,
        lastSeenAt: agent.lastSeenAt,
        taskOutcomes: {
          total: taskTotal,
          success: taskSuccess,
          failure: taskFail,
          successRate: taskTotal > 0 ? Math.round((taskSuccess / taskTotal) * 100) : 0,
        },
        memories: agentMemories.length,
        experienceReuses: { total: agentReuses.length, verified: verified.length },
        active: Date.now() - new Date(agent.lastSeenAt).getTime() < 24 * 60 * 60 * 1000,
      }
    })
    return { project, count: reports.length, reports }
  }

  function registerAgent(args = {}) {
    const agentId = String(args.agentId || '').trim()
    if (!agentId) throw new Error('agent.register requires a non-empty agentId')
    const project = args.project || projectName()
    const hostType = args.hostType || 'mcp'
    const capabilities = Array.isArray(args.capabilities) ? args.capabilities : []
    const now = new Date().toISOString()
    const agents = readJsonlCached(agentsPath)
    const existing = agents.find((a) => a.agentId === agentId && a.project === project)
    let result
    if (existing) {
      existing.lastSeenAt = now
      existing.sessionCount = (existing.sessionCount || 1) + 1
      existing.hostType = hostType
      if (capabilities.length > 0) existing.capabilities = capabilities
      result = existing
    } else {
      result = {
        id: createId('agent'),
        agentId,
        hostType,
        capabilities,
        registeredAt: now,
        lastSeenAt: now,
        sessionCount: 1,
        project,
      }
      agents.push(result)
    }
    writeJsonl(agentsPath, agents)
    return {
      id: result.id,
      agentId: result.agentId,
      registered: !existing,
      sessionCount: result.sessionCount,
      hostType: result.hostType,
      capabilities: result.capabilities,
    }
  }

  return { listAgents, reportAgent, registerAgent }
}

module.exports = { createAgentStore }
