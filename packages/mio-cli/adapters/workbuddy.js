'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

// WorkBuddy 5.x moved its config root from ~/.workbuddy (the CodeBuddy era
// path) to ~/.workbuddy-ai. Machines that upgraded keep both, and only the new
// root is read by the running app -- writing to the legacy root produced an
// install that reported success while the host never loaded the MCP server or
// the rules file. An explicit override still wins (tests and portable installs
// depend on it).
function configCandidates(home) {
  const override = process.env.WORKBUDDY_CONFIG_DIR || process.env.CODEBUDDY_CONFIG_DIR
  if (override) return [override]
  const root = home || os.homedir()
  const modern = path.join(root, '.workbuddy-ai')
  const legacy = path.join(root, '.workbuddy')
  const out = []
  if (fs.existsSync(modern)) out.push(modern)
  if (fs.existsSync(legacy)) out.push(legacy)
  // Fresh machine: neither root exists yet, so keep the historical path and
  // let install create it rather than inventing a third location.
  return out.length > 0 ? out : [legacy]
}

function configDir() {
  return configCandidates()[0]
}

function configPath() {
  return path.join(configDir(), 'mcp.json')
}

function settingsPath() {
  return path.join(configDir(), 'settings.json')
}

function hookScriptPath() {
  return path.resolve(__dirname, '..', 'hooks', 'workbuddy-hook.js')
}

// The MCP server entry is <pkg>/server/mio-intelligence-mcp/index.js, so the
// CLI entry is <pkg>/bin/mio.js.
function cliScriptPath(serverScript) {
  return path.resolve(path.dirname(serverScript), '..', '..', 'bin', 'mio.js')
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

- Before designing or implementing a solution, or when unsure about prior decisions, call \`mcp__mio-intelligence__mio.memory.query\` first. Omit \`project\` unless a specific project is required; Mio derives it from the current Git repository.
- After a decision affecting architecture, deployment, dependencies, or long-term behavior, call \`mcp__mio-intelligence__mio.memory.record\` with \`kind\`: \`decision\`, \`context\`, \`problem\`, or \`note\`.
- When a tool call fails, retries, or returns an error, call \`mcp__mio-intelligence__mio.observer.ingest\` with a stable \`trace_id\`, relevant \`event_type\`, \`payload\`, and \`outcome\`.
- Before a high-risk operation such as deletion, migration, credential change, or production change, call \`mcp__mio-intelligence__mio.policy.check\` and follow its suggestion when available.
- At the end of every task, before producing the final answer, call \`mcp__mio-intelligence__mio.observer.ingest\` with \`event_type\` = \`task_outcome\`, a stable \`trace_id\`, \`outcome\` = \`success\` / \`failure\` / \`aborted\`, and a brief non-sensitive \`payload\`. If Mio is unavailable, do not block the final answer.
- When you reuse a prior decision or experience returned by \`mcp__mio-intelligence__mio.memory.query\` and it changes your approach or outcome, call \`mcp__mio-intelligence__mio.experience.reuse\` with \`sourceAgent\`, \`targetAgent\`, \`experienceId\`, \`reuse\`, \`behaviorChanged\`, and \`outcomeImproved\`.
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
    memory.includes(MEMORY_END) &&
    // An install from before hooks existed is reported as incomplete so
    // `mio install workbuddy` repairs it instead of short-circuiting.
    hooksInstalled()
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

// --- hooks -----------------------------------------------------------------
//
// Rules files alone only make Mio *available*: retrieval and capture then hinge
// on the model deciding to call a tool. WorkBuddy implements the Claude Code
// hook contract (7 events, `hookSpecificOutput.additionalContext` is injected
// into the model context), which is the only channel that makes memory
// seamless. `UserPromptSubmit` injects recall results; `Stop`/`SessionEnd`
// push the finished transcript into the observer, whose payload already
// carries transcript_path / session_id / cwd.
const HOOK_EVENTS = ['UserPromptSubmit', 'Stop', 'SessionEnd']
// Identifies our own entries when merging, so re-install replaces them instead
// of appending duplicates and never disturbs hooks the user added.
const HOOK_MARKER = 'workbuddy-hook.js'

function quoteArg(value) {
  return `"${String(value).replace(/"/g, '')}"`
}

function isMioHookEntry(entry) {
  const hooks = entry && Array.isArray(entry.hooks) ? entry.hooks : []
  return hooks.some((hook) => hook && typeof hook.command === 'string' && hook.command.includes(HOOK_MARKER))
}

function hooksInstalled() {
  const settings = readJson(settingsPath()) || {}
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}
  return HOOK_EVENTS.every(
    (event) => Array.isArray(hooks[event]) && hooks[event].some(isMioHookEntry),
  )
}

function installHooks({ node, hookScript, cliScript, home }) {
  const target = settingsPath()
  const settings = readJson(target) || {}
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}
  const command = [node, hookScript, cliScript, home].map(quoteArg).join(' ')
  const entry = { matcher: '', hooks: [{ type: 'command', command }] }

  const before = JSON.stringify(hooks)
  for (const event of HOOK_EVENTS) {
    const list = Array.isArray(hooks[event]) ? hooks[event] : []
    hooks[event] = list.filter((item) => !isMioHookEntry(item)).concat([entry])
  }
  settings.hooks = hooks
  const changed = JSON.stringify(hooks) !== before
  if (!changed) return { changed: false, target, backup: null }

  const backup = `${target}.bak-mio-${Date.now()}`
  if (fs.existsSync(target)) fs.copyFileSync(target, backup)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  return { changed: true, target, backup }
}

function install({ node, serverScript, home, workspace }) {
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

  // No project/workspace here: the MCP server derives the project from its own
  // git cwd. A baked value from install-time cwd overrides that derivation and
  // mis-attributes every memory write for the host's lifetime.
  //
  // No sessionId either: MIO_CONTEXT is written once at install time, so any
  // value here is a constant shared by every future session. The MCP server
  // only reads agentId; the real session id arrives through the Stop hook
  // payload instead.
  const context = JSON.stringify({ agentId: 'workbuddy' })

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

  // Hook scripts live next to this package; the CLI entry sits two levels above
  // the MCP server entry (<pkg>/server/mio-intelligence-mcp/index.js ->
  // <pkg>/bin/mio.js). Both are baked into the command because hook configs
  // carry no environment of their own.
  const hooks = installHooks({
    node,
    hookScript: hookScriptPath(),
    cliScript: cliScriptPath(serverScript),
    home,
  })

  const changed =
    userRules.changed ||
    Boolean(projectRules && projectRules.changed) ||
    hooks.changed

  return {
    changed,
    configPath: target,
    approvalsPath: approvalsPath(),
    memoryRulesPath: userRules.target,
    projectInstructionsPath: projectRules ? projectRules.target : null,
    hooksPath: hooks.target,
    userRulesChanged: userRules.changed,
    projectRulesChanged: projectRules ? projectRules.changed : false,
    hooksChanged: hooks.changed,
    backup,
    message:
      'WorkBuddy Mio MCP installed, approved, Mio rules injected into CODEBUDDY.md and the workspace AGENTS.md, and hooks registered (UserPromptSubmit recall + Stop/SessionEnd transcript ingest). Fully quit WorkBuddy and relaunch to load them.',
  }
}

module.exports = {
  configDir,
  configCandidates,
  configPath,
  settingsPath,
  approvalsPath,
  memoryRulesPath,
  projectInstructionsPath,
  approvalKey,
  hooksInstalled,
  installHooks,
  isInstalled,
  install,
}
