'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { restartWarning } = require('./host-utils')

const SERVER_SECTION = '[mcp_servers.mio-intelligence]'
const ENV_SECTION = '[mcp_servers.mio-intelligence.env]'

function configPath() {
  return path.join(os.homedir(), '.codex', 'config.toml')
}

function isInstalled() {
  const target = configPath()
  if (!fs.existsSync(target)) return false
  return fs.readFileSync(target, 'utf8').includes(SERVER_SECTION)
}

// Legacy installs pointed args at the worktree copy of the server
// (server/mio-intelligence-mcp/index.js) instead of this package's copy
// (server/mio-intelligence-mcp/index.js). Detect staleness by comparing the
// configured args path with the server path this package ships.
function configNeedsRepair(serverScript) {
  const target = configPath()
  if (!fs.existsSync(target)) return false
  try {
    const src = fs.readFileSync(target, 'utf8')
    if (!src.includes(SERVER_SECTION)) return false
    const needle = serverScript.replace(/\\/g, '/').toLowerCase()
    return !src.replace(/\\/g, '/').toLowerCase().includes(needle)
  } catch (_) {
    return false
  }
}

function installMessage(installed, restartHint) {
  let message = installed
    ? 'Codex Mio MCP repaired (server path updated). Restart Codex to load it.'
    : 'Codex Mio MCP installed. Restart Codex to load it.'
  if (restartHint) message += ' ' + restartHint
  return message
}

function restartWarningMessage() {
  return restartWarning({
    hostLabel: 'Codex',
    exeName: 'codex.exe',
    exePathFragment: 'OpenAI.Codex',
    configPath: configPath(),
  })
}

function stripMioSection(toml) {
  const lines = toml.replace(/\r\n/g, '\n').split('\n')
  const out = []
  let skipping = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === SERVER_SECTION || trimmed === ENV_SECTION) {
      skipping = true
      continue
    }
    if (skipping && /^\[.*\]$/.test(trimmed)) {
      skipping = false
    }
    if (!skipping) out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

function install({ node, serverScript, home, workspace }) {
  const target = configPath()
  const backup = `${target}.bak-mio-${Date.now()}`
  const installed = isInstalled()
  if (installed && !configNeedsRepair(serverScript)) {
    return {
      changed: false,
      configPath: target,
      message: 'Codex Mio MCP already installed.',
    }
  }

  if (fs.existsSync(target)) {
    fs.copyFileSync(target, backup)
  }

  const context = JSON.stringify({
    agentId: 'codex',
    workspace: workspace || process.cwd(),
    sessionId: 'codex-session',
  })

  fs.mkdirSync(path.dirname(target), { recursive: true })
  let toml = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''
  toml = stripMioSection(toml)
  toml = toml.replace(/\n{3,}/g, '\n\n')
  if (!toml.endsWith('\n')) toml += '\n'
  const section = [
    '',
    SERVER_SECTION,
    `command = '${node}'`,
    `args = ['${serverScript}']`,
    'startup_timeout_sec = 30',
    '',
    ENV_SECTION,
    `MIO_DATA_DIR = '${home}'`,
    `MIO_CONTEXT = '${context}'`,
    '',
  ].join('\n')
  fs.writeFileSync(target, `${toml}${section}\n`, 'utf8')

  return {
    changed: true,
    configPath: target,
    backup,
    message: installMessage(installed, restartWarningMessage()),
  }
}

module.exports = { configPath, isInstalled, install, restartWarningMessage }