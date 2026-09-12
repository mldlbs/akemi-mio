'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}

// Claude Code keeps user-scope MCP servers in the top-level ~/.claude.json
// (moved to $CLAUDE_CONFIG_DIR/.claude.json when CLAUDE_CONFIG_DIR is set).
// Project-scope .mcp.json files require interactive approval, so we install
// at user scope only.
function configPath() {
  if (process.env.CLAUDE_CONFIG_DIR) {
    return path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
  }
  return path.join(os.homedir(), '.claude.json')
}

// User-level memory file. Claude Code auto-loads ~/.claude/CLAUDE.md into
// every session, which gives the Mio usage rules a guaranteed retrieval path.
function memoryRulesPath() {
  return path.join(configDir(), 'CLAUDE.md')
}

// Project-level memory. Claude Code auto-loads <workspace>/CLAUDE.md.
function projectInstructionsPath(workspace) {
  return path.join(workspace || process.cwd(), 'CLAUDE.md')
}

function readJson(file) {
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (_) {
    return null
  }
}

const MEMORY_BEGIN = '<!-- MIO_INTELLIGENCE_BEGIN -->'
const MEMORY_END = '<!-- MIO_INTELLIGENCE_END -->'
const MEMORY_BLOCK = `${MEMORY_BEGIN}
## Mio Intelligence Layer

Mio MCP tools are available. Treat these as mandatory runtime rules for every workspace.

- Before designing or implementing a solution, or when unsure about prior decisions, call \`mio-intelligence_mio.memory.query\` first. Omit \`project\` unless a specific project is required; Mio derives it from the current Git repository.
- After a decision affecting architecture, deployment, dependencies, or long-term behavior, call \`mio-intelligence_mio.memory.record\` with \`kind\`: \`decision\`, \`context\`, \`problem\`, or \`note\`.
- When a tool call fails, retries, or returns an error, call \`mio-intelligence_mio.observer.ingest\` with a stable \`trace_id\`, relevant \`event_type\`, \`payload\`, and \`outcome\`.
- Before a high-risk operation such as deletion, migration, credential change, or production change, call \`mio-intelligence_mio.policy.check\` and follow its suggestion when available.
- At the end of every task, before producing the final answer, call \`mio-intelligence_mio.observer.ingest\` with \`event_type\` = \`task_outcome\`, a stable \`trace_id\`, \`outcome\` = \`success\` / \`failure\` / \`aborted\`, and a brief non-sensitive \`payload\`. If Mio is unavailable, do not block the final answer.
- When you reuse a prior decision or experience returned by \`mio-intelligence_mio.memory.query\` and it changes your approach or outcome, call \`mio-intelligence_mio.experience.reuse\` with \`sourceAgent\`, \`targetAgent\`, \`experienceId\`, \`reuse\`, \`behaviorChanged\`, and \`outcomeImproved\`.
- If Mio MCP is unavailable, do not block the task. Continue normally and note the missed memory or observation.
- Do not store secrets, credentials, or raw sensitive content in Mio memory.
${MEMORY_END}`

function ensureBlock(target) {
  let content = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''
  const original = content
  const start = content.indexOf(MEMORY_BEGIN)
  if (start !== -1) {
    const end = content.indexOf(MEMORY_END, start)
    content = end === -1 ? content.slice(0, start) : content.slice(0, start) + content.slice(end + MEMORY_END.length)
    content = content.trimEnd()
  }
  if (content) content += '\n\n'
  content += MEMORY_BLOCK + '\n'
  if (content === original) return { changed: false, target, backup: null }
  const backup = `${target}.bak-mio-${Date.now()}`
  if (fs.existsSync(target)) fs.copyFileSync(target, backup)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, 'utf8')
  return { changed: true, target, backup }
}

function isInstalled() {
  const config = readJson(configPath())
  const entry = config && config.mcpServers && config.mcpServers['mio-intelligence']
  if (!entry) return false
  const memory = fs.existsSync(memoryRulesPath()) ? fs.readFileSync(memoryRulesPath(), 'utf8') : ''
  return Boolean(memory.includes(MEMORY_BEGIN) && memory.includes(MEMORY_END))
}

function install({ node, serverScript, home, workspace, project }) {
  const target = configPath()
  const config = readJson(target) || {}
  const servers =
    config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {}

  const context = JSON.stringify({
    agentId: 'claude-code',
    project: project || path.basename(workspace || process.cwd()),
    workspace: workspace || process.cwd(),
    sessionId: 'claude-code-session',
  })

  config.mcpServers = {
    ...servers,
    'mio-intelligence': {
      command: node,
      args: [serverScript],
      env: {
        MIO_DATA_DIR: home,
        MIO_CONTEXT: context,
      },
    },
  }

  const backup = `${target}.bak-mio-${Date.now()}`
  if (fs.existsSync(target)) {
    fs.copyFileSync(target, backup)
  }

  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

  const userRules = ensureBlock(memoryRulesPath())
  let projectRules = null
  const workspaceDir = workspace || process.cwd()
  if (workspaceDir && path.isAbsolute(workspaceDir)) {
    projectRules = ensureBlock(projectInstructionsPath(workspaceDir))
  }

  const changed = userRules.changed || Boolean(projectRules && projectRules.changed)

  return {
    changed,
    configPath: target,
    memoryRulesPath: userRules.target,
    projectInstructionsPath: projectRules ? projectRules.target : null,
    userRulesChanged: userRules.changed,
    projectRulesChanged: projectRules ? projectRules.changed : false,
    backup,
    message:
      'Claude Code Mio MCP installed at user scope and Mio rules injected into ~/.claude/CLAUDE.md (auto-loaded user memory) and the workspace CLAUDE.md. Restart Claude Code sessions to load them.',
  }
}

module.exports = { configDir, configPath, memoryRulesPath, projectInstructionsPath, isInstalled, install }
