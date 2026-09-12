'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { restartWarning } = require('./host-utils')

const INSTRUCTIONS_BEGIN = '<!-- MIO_INTELLIGENCE_BEGIN -->'
const INSTRUCTIONS_END = '<!-- MIO_INTELLIGENCE_END -->'
const INSTRUCTIONS_BLOCK = `${INSTRUCTIONS_BEGIN}
## Mio Intelligence Layer

Mio MCP tools are available. Treat these as mandatory runtime rules for every workspace.

- Before designing or implementing a solution, or when unsure about prior decisions, call \`mio-intelligence_mio_memory_query\` first. Omit \`project\` unless a specific project is required; Mio derives it from the current Git repository.
- After a decision affecting architecture, deployment, dependencies, or long-term behavior, call \`mio-intelligence_mio_memory_record\` with \`kind\`: \`decision\`, \`context\`, \`problem\`, or \`note\`.
- When a tool call fails, retries, or returns an error, call \`mio-intelligence_mio_observer_ingest\` with a stable \`trace_id\`, relevant \`event_type\`, \`payload\`, and \`outcome\`.
- Before a high-risk operation such as deletion, migration, credential change, or production change, call \`mio-intelligence_mio_policy_check\` and follow its suggestion when available.
- At the end of every task, before producing the final answer, call \`mio-intelligence_mio_observer_ingest\` with \`event_type\` = \`task_outcome\`, a stable \`trace_id\`, \`outcome\` = \`success\` / \`failure\` / \`aborted\`, and a brief non-sensitive \`payload\`. If Mio is unavailable, do not block the final answer.
- When you reuse a prior decision or experience returned by \`mio-intelligence_mio_memory_query\` and it changes your approach or outcome, call \`mio-intelligence_mio_experience_reuse\` with \`sourceAgent\`, \`targetAgent\`, \`experienceId\`, \`reuse\`, \`behaviorChanged\`, and \`outcomeImproved\`.
- If Mio MCP is unavailable, do not block the task. Continue normally and note the missed memory or observation.
- Do not store secrets, credentials, or raw sensitive content in Mio memory.
${INSTRUCTIONS_END}`

function configPath() {
  return path.join(os.homedir(), '.config', 'opencode', 'opencode.json')
}

function globalInstructionsPath() {
  return path.join(os.homedir(), '.config', 'opencode', 'AGENTS.md')
}

function readConfig() {
  const target = configPath()
  if (!fs.existsSync(target)) return null
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'))
  } catch (_) {
    return null
  }
}

function readGlobalInstructions() {
  const target = globalInstructionsPath()
  if (!fs.existsSync(target)) return ''
  try {
    return fs.readFileSync(target, 'utf8')
  } catch (_) {
    return ''
  }
}

function ensureGlobalInstructions() {
  const target = globalInstructionsPath()
  let content = readGlobalInstructions()
  const original = content
  const start = content.indexOf(INSTRUCTIONS_BEGIN)
  if (start !== -1) {
    const end = content.indexOf(INSTRUCTIONS_END, start)
    content = end === -1 ? content.slice(0, start) : content.slice(0, start) + content.slice(end + INSTRUCTIONS_END.length)
    content = content.trimEnd()
  }
  if (content) content += '\n\n'
  content += INSTRUCTIONS_BLOCK + '\n'
  if (content === original) {
    return { changed: false, target, backup: null }
  }

  const backup = `${target}.bak-mio-${Date.now()}`
  if (fs.existsSync(target)) {
    fs.copyFileSync(target, backup)
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, 'utf8')
  return { changed: true, target, backup }
}

function configNeedsRepair(serverScript) {
  const config = readConfig()
  const mcp = config && config.mcp && config.mcp['mio-intelligence']
  if (!mcp) return false
  const command = mcp.command
  if (!Array.isArray(command) || command.length < 2) return true
  const configured = String(command[1]).replace(/\\/g, '/').toLowerCase()
  const needle = String(serverScript).replace(/\\/g, '/').toLowerCase()
  return configured !== needle
}

function restartWarningMessage() {
  return restartWarning({
    hostLabel: 'OpenCode Desktop',
    exeName: 'OpenCode.exe',
    exePathFragment: '@opencode-aidesktop',
    configPath: configPath(),
  })
}

function isInstalled() {
  const config = readConfig()
  if (!config || !config.mcp || !config.mcp['mio-intelligence']) return false
  const instructions = readGlobalInstructions()
  return instructions.includes(INSTRUCTIONS_BEGIN) && instructions.includes(INSTRUCTIONS_END)
}

function install({ node, serverScript, home, workspace, project }) {
  const target = configPath()
  const config = readConfig() || {}
  const configInstalled = Boolean(config.mcp && config.mcp['mio-intelligence'])
  const needsRepair = configInstalled && configNeedsRepair(serverScript)

  let configChanged = false
  let backup = null

  if (!configInstalled || needsRepair) {
    backup = `${target}.bak-mio-${Date.now()}`
    if (fs.existsSync(target)) {
      fs.copyFileSync(target, backup)
    }

    const existingMcp = config.mcp && typeof config.mcp === 'object' ? config.mcp : {}
    const context = JSON.stringify({
      agentId: 'opencode',
      project: project || path.basename(workspace || process.cwd()),
      workspace: workspace || process.cwd(),
      sessionId: 'opencode-session',
    })
    const next = {
      ...config,
      mcp: {
        ...existingMcp,
        'mio-intelligence': {
          enabled: true,
          type: 'local',
          command: [node, serverScript],
          environment: {
            MIO_DATA_DIR: home,
            MIO_CONTEXT: context,
          },
        },
      },
    }

    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    configChanged = true
  }

  const instructionsResult = ensureGlobalInstructions()
  const changed = configChanged || instructionsResult.changed

  let message
  if (configChanged && instructionsResult.changed) {
    message = 'OpenCode Mio MCP installed and global Mio rules injected into AGENTS.md. Restart OpenCode to load them.'
  } else if (needsRepair && !instructionsResult.changed) {
    message = 'OpenCode Mio MCP repaired (server path updated). Restart OpenCode to load it.'
  } else if (instructionsResult.changed) {
    message = 'OpenCode Mio MCP already installed. Injected global Mio rules into AGENTS.md. Restart OpenCode to load them.'
  } else {
    message = 'OpenCode Mio MCP already installed.'
  }
  const restartHint = restartWarningMessage()
  if (restartHint) message += ' ' + restartHint

  return {
    changed,
    configPath: target,
    globalInstructionsPath: instructionsResult.target,
    configChanged,
    instructionsChanged: instructionsResult.changed,
    backup,
    backupInstructions: instructionsResult.backup,
    message,
  }
}

module.exports = { configPath, globalInstructionsPath, isInstalled, install, configNeedsRepair, restartWarningMessage }
