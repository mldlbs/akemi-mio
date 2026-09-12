'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

function configDir() {
  return (
    process.env.WORKBUDDY_CONFIG_DIR ||
    process.env.CODEBUDDY_CONFIG_DIR ||
    path.join(os.homedir(), '.workbuddy')
  )
}

function configPath() {
  return path.join(configDir(), 'mcp.json')
}

function legacyConfigPath() {
  return path.join(configDir(), '.mcp.json')
}

function approvalsPath() {
  return path.join(configDir(), 'mcp-approvals.json')
}

// User-level memory rules file. WorkBuddy's codebuddy CLI (a CodeBuddy fork)
// auto-loads CODEBUDDY.md (or CODEBUDDY.mdc) from the config dir into every
// session (MemoryLoader user scope -> system-reminder-md / prompt context).
// Note: PRODUCT_UPPERCASE_NAME in the CLI bundle is "CODEBUDDY", not "WORKBUDDY".
function memoryRulesPath() {
  return path.join(configDir(), 'CODEBUDDY.md')
}

// Project-level memory rules. WorkBuddy walks up from the workspace dir and
// auto-loads CODEBUDDY.md / AGENTS.md (project scope) into every session.
function projectInstructionsPath(workspace) {
  return path.join(workspace || process.cwd(), 'AGENTS.md')
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

  const approvals = readJson(approvalsPath()) || {}
  const memory = fs.existsSync(memoryRulesPath()) ? fs.readFileSync(memoryRulesPath(), 'utf8') : ''
  return Boolean(
    approvals[approvalKey('mio-intelligence', entry)] &&
    memory.includes(MEMORY_BEGIN) &&
    memory.includes(MEMORY_END)
  )
}

function approvalKey(name, entry) {
  let input
  if (entry.command) {
    input = `${entry.command || ''}|${(entry.args || []).map(String).sort().join(',')}|${Object.keys(entry.env || {}).sort().join(',')}`
  } else if (entry.url) {
    try {
      input = new URL(entry.url).origin
    } catch (_) {
      input = entry.url
    }
  } else {
    input = JSON.stringify(entry)
  }

  const hash = crypto.createHash('sha256').update(input).digest('hex')
  return `${hash}::${name}`
}

function writeApproval(name, entry) {
  const target = approvalsPath()
  const approvals = readJson(target) || {}
  approvals[approvalKey(name, entry)] = Date.now()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${JSON.stringify(approvals, null, 2)}\n`, 'utf8')
}

function install({ node, serverScript, home, workspace, project }) {
  const target = configPath()
  const canonical = readJson(target) || {}
  const legacy = readJson(legacyConfigPath()) || {}
  const canonicalServers =
    canonical.mcpServers && typeof canonical.mcpServers === 'object' ? canonical.mcpServers : {}
  const legacyServers =
    legacy.mcpServers && typeof legacy.mcpServers === 'object' ? legacy.mcpServers : {}

  const config = {
    ...legacy,
    ...canonical,
    mcpServers: {
      ...legacyServers,
      ...canonicalServers,
    },
  }

  const context = JSON.stringify({
    agentId: 'workbuddy',
    project: project || path.basename(workspace || process.cwd()),
    workspace: workspace || process.cwd(),
    sessionId: 'workbuddy-session',
  })

  config.mcpServers = {
    ...config.mcpServers,
    'mio-intelligence': {
      command: node,
      args: [serverScript],
      env: {
        MIO_DATA_DIR: home,
        MIO_CONTEXT: context,
      },
    },
  }

  writeApproval('mio-intelligence', config.mcpServers['mio-intelligence'])

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
    approvalsPath: approvalsPath(),
    memoryRulesPath: userRules.target,
    projectInstructionsPath: projectRules ? projectRules.target : null,
    userRulesChanged: userRules.changed,
    projectRulesChanged: projectRules ? projectRules.changed : false,
    backup,
    message: 'WorkBuddy Mio MCP installed, approved, and Mio rules injected into CODEBUDDY.md (auto-loaded user memory) and the workspace AGENTS.md. Restart WorkBuddy to load them.',
  }
}

module.exports = { configDir, configPath, approvalsPath, memoryRulesPath, projectInstructionsPath, approvalKey, isInstalled, install }
