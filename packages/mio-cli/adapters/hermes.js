'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

const SERVER_NAME = 'mio-intelligence'

function hermesHome() {
  return process.env.HERMES_HOME || path.join(os.homedir(), 'AppData', 'Local', 'hermes')
}

function hermesConfigPath() {
  return path.join(hermesHome(), 'config.yaml')
}

function configNeedsRepair() {
  const cfg = hermesConfigPath()
  if (!fs.existsSync(cfg)) return false
  try {
    const src = fs.readFileSync(cfg, 'utf8')
    // Legacy installs stored the env pairs as plain args (--env KEY=VALUE)
    // because --env came after --args; Hermes now stores them under env:.
    return /- MIO_DATA_DIR=/.test(src) || /- MIO_CONTEXT=/.test(src)
  } catch (_) {
    return false
  }
}

function hermesBin() {
  if (process.env.HERMES_BIN && fs.existsSync(process.env.HERMES_BIN)) return process.env.HERMES_BIN
  const home = hermesHome()
  const candidates = [
    // Official Windows native install: venv script registered on User PATH
    path.join(home, 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'),
    // Newer installer shim under <LocalAppData>/hermes/bin
    path.join(home, 'bin', 'hermes.cmd'),
    // Legacy layout
    path.join(home, 'hermes-agent', 'bin', 'hermes.exe'),
    path.join(os.homedir(), '.hermes', 'bin', 'hermes.exe'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return null
}

function runHermes(args) {
  const bin = hermesBin()
  // `hermes mcp add` asks to confirm tool enablement interactively; pre-answer
  // it so the install is non-interactive.
  const input = args[0] === 'mcp' && args[1] === 'add' ? 'Y\n' : undefined
  let res
  try {
    const isCmdShim = Boolean(bin && /\.(cmd|bat)$/i.test(bin))
    res = bin
      ? spawnSync(bin, args, { encoding: 'utf8', timeout: 60000, windowsHide: true, input: input, shell: isCmdShim })
      : spawnSync('hermes', args, { encoding: 'utf8', timeout: 60000, shell: true, windowsHide: true, input: input })
  } catch (_) {
    return null
  }
  if (res.error || res.status !== 0) return null
  return (res.stdout || '') + (res.stderr || '')
}

function isInstalled() {
  const out = runHermes(['mcp', 'list'])
  return Boolean(out && out.indexOf(SERVER_NAME) !== -1)
}

function install({ node, serverScript, home, workspace, project }) {
  if (!hermesBin() && !isHermesOnPath()) {
    return {
      changed: false,
      message: 'Hermes binary not found. Install hermes-agent first.',
      configPath: null,
    }
  }
  if (isInstalled()) {
    if (!configNeedsRepair()) {
      return { changed: false, message: 'Hermes Mio MCP already installed.', configPath: null }
    }
    runHermes(['mcp', 'remove', SERVER_NAME])
  }

  const context = JSON.stringify({
    agentId: 'hermes',
    project: project || path.basename(workspace || process.cwd()),
    workspace: workspace || process.cwd(),
    sessionId: 'hermes-session',
  })

  // Hermes requires --env before --args: --args swallows everything after it.
  const args = [
    'mcp', 'add', SERVER_NAME,
    '--command', node,
    '--env', 'MIO_DATA_DIR=' + home, 'MIO_CONTEXT=' + context,
    '--args', serverScript,
  ]
  const out = runHermes(args)
  const installed = isInstalled()

  let message
  if (installed) {
    message = 'Hermes Mio MCP installed (config: <LocalAppData>/hermes/config.yaml). Start a new Hermes session to load it.'
  } else {
    message = 'Hermes mcp add returned but Mio was not detected. Run `hermes mcp add ' + SERVER_NAME + ' --command ' + node + ' --args ' + serverScript + '` manually and answer Y to the prompt.'
  }
  return { changed: installed, configPath: null, message }
}

function isHermesOnPath() {
  try {
    const res = spawnSync('where', ['hermes'], { encoding: 'utf8', shell: true })
    return res.status === 0 && /hermes/.test(res.stdout || '')
  } catch (_) {
    return false
  }
}

module.exports = { hermesBin, isInstalled, install }
