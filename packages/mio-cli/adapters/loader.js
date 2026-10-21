'use strict'

// Declarative host onboarding (TaskHub a6dcd804 PR-C).
//
// A host whose only job is "write one server block into one config file" is now
// described by adapters/<host>.template.json instead of a hand-written module.
// The loader compiles that template into the exact adapter interface the CLI
// already consumes (configPath / isHostPresent / isInstalled / install /
// restartWarningMessage / configNeedsRepair), so bin/mio.js never learns
// whether a host is template-driven.
//
// Hosts whose install does more than write a server block keep their
// hand-written module and are reached through the fallback. That is deliberate:
// opencode also injects an AGENTS.md rule block, and pretending a template can
// express that would either lose the block or grow the template into a second
// programming language. "Thin shim" beats "config file that is secretly code".
//
// Adding a plain host = drop a .template.json. No core changes.

const fs = require('fs')
const path = require('path')
const os = require('os')

const { restartWarning, hostPresent } = require('./host-utils')

const TEMPLATE_SUFFIX = '.template.json'

// `~/x` is the only home shorthand the templates are allowed to use, so a
// template can never smuggle in a shell expansion or an env var read.
function expandHome(p) {
  if (typeof p !== 'string') return p
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2))
  }
  return p
}

function templatePath(host, dir) {
  return path.join(dir, `${host}${TEMPLATE_SUFFIX}`)
}

function readTemplate(host, dir = __dirname) {
  const file = templatePath(host, dir)
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    // A malformed template must fail loudly: silently falling back to the
    // hand-written module would hide the typo that was the whole point.
    throw new Error(`invalid template ${file}: ${err.message}`)
  }
}

function listTemplateHosts(dir = __dirname) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(TEMPLATE_SUFFIX))
    .map((f) => f.slice(0, -TEMPLATE_SUFFIX.length))
}

// Recursively substitutes {{var}} placeholders in strings, arrays and objects.
// Unknown placeholders are left verbatim on purpose: a typo shows up in the
// written config instead of becoming an empty string that looks valid.
function interpolate(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\{\{(\w+)\}\}/g, (whole, name) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
    )
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, vars)
    return out
  }
  return value
}

function tomlValue(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return `'${String(value)}'`
}

// Builds the `{{context}}` payload a host wants echoed back through
// MIO_CONTEXT. `workspace` falls back to cwd exactly like the hand-written
// adapters do, so the two paths stay byte-identical.
function buildContext(spec, vars) {
  if (!spec) return undefined
  return JSON.stringify(interpolate(spec, vars))
}

function installVars({ node, serverScript, home, workspace }) {
  const vars = {
    node,
    serverScript,
    home,
    workspace: workspace || process.cwd(),
  }
  vars.context = undefined
  return vars
}

function compileToml(template, host) {
  const markers = template.sectionMarkers || {}
  const open = markers.open
  const envOpen = markers.envOpen
  if (!open) throw new Error(`${host}.template.json: format "toml" requires sectionMarkers.open`)

  const target = () => expandHome(template.configPath)

  // Same section-stripping rule the hand-written codex adapter used: drop the
  // server block and its env block, stop skipping at the next table header.
  function stripMio(text) {
    const lines = text.replace(/\r\n/g, '\n').split('\n')
    const out = []
    let skipping = false
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed === open || (envOpen && trimmed === envOpen)) {
        skipping = true
        continue
      }
      if (skipping && /^\[.*\]$/.test(trimmed)) skipping = false
      if (!skipping) out.push(line)
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
  }

  function renderSection(vars) {
    const shape = template.serverShape || {}
    const lines = ['', open, `command = ${tomlValue(vars.node)}`]
    const args = (shape.args || []).map((a) => tomlValue(interpolate(a, vars)))
    lines.push(`args = [${args.join(', ')}]`)
    for (const [k, v] of Object.entries(shape.extra || {})) {
      lines.push(`${k} = ${tomlValue(interpolate(v, vars))}`)
    }
    if (envOpen) {
      lines.push('', envOpen)
      for (const [k, v] of Object.entries(shape.env || {})) {
        lines.push(`${k} = ${tomlValue(interpolate(v, vars))}`)
      }
    }
    lines.push('')
    return lines.join('\n')
  }

  function readText() {
    const file = target()
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  }

  function isInstalled() {
    return readText().includes(open)
  }

  function configNeedsRepair(serverScript) {
    const src = readText()
    if (!src.includes(open)) return false
    const needle = String(serverScript).replace(/\\/g, '/').toLowerCase()
    return !src.replace(/\\/g, '/').toLowerCase().includes(needle)
  }

  function install({ node, serverScript, home, workspace }) {
    const file = target()
    const vars = installVars({ node, serverScript, home, workspace })
    vars.context = buildContext(template.context, vars)
    const msgs = template.messages || {}

    const installed = isInstalled()
    if (installed && !configNeedsRepair(serverScript)) {
      return {
        changed: false,
        configPath: file,
        message: msgs.unchanged || `${host} Mio MCP already installed.`,
      }
    }

    const backup = `${file}.bak-mio-${Date.now()}`
    if (fs.existsSync(file)) fs.copyFileSync(file, backup)

    fs.mkdirSync(path.dirname(file), { recursive: true })
    let text = stripMio(readText())
    text = text.replace(/\n{3,}/g, '\n\n')
    if (!text.endsWith('\n')) text += '\n'
    fs.writeFileSync(file, `${text}${renderSection(vars)}\n`, 'utf8')

    const base = installed
      ? msgs.repaired || `${host} Mio MCP repaired (server path updated).`
      : msgs.installed || `${host} Mio MCP installed.`
    const hint = restartWarningMessage()
    return {
      changed: true,
      configPath: file,
      backup,
      message: hint ? `${base} ${hint}` : base,
    }
  }

  function restartWarningMessage() {
    const r = template.restart || {}
    return restartWarning({
      hostLabel: r.hostLabel || template.hostLabel || host,
      exeName: r.exeName,
      exePathFragment: r.exePathFragment,
      configPath: target(),
    })
  }

  return {
    configPath: target,
    isHostPresent: () => hostPresent({ configPath: target(), extraPaths: [path.dirname(target())] }),
    isInstalled,
    configNeedsRepair,
    install,
    restartWarningMessage,
  }
}

function compileJson(template, host) {
  const target = () => expandHome(template.configPath)
  const keyPath = String(template.mcpKey || '').split('.').filter(Boolean)
  if (keyPath.length === 0) throw new Error(`${host}.template.json: format "json" requires mcpKey`)

  function readConfig() {
    const file = target()
    if (!fs.existsSync(file)) return null
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }

  function getIn(obj, keys) {
    let cur = obj
    for (const k of keys) {
      if (!cur || typeof cur !== 'object') return undefined
      cur = cur[k]
    }
    return cur
  }

  function isInstalled() {
    const config = readConfig()
    return Boolean(config && getIn(config, keyPath))
  }

  function configNeedsRepair(serverScript) {
    const config = readConfig()
    const entry = config && getIn(config, keyPath)
    if (!entry) return false
    const needle = String(serverScript).replace(/\\/g, '/').toLowerCase()
    return !JSON.stringify(entry).replace(/\\/g, '/').toLowerCase().includes(needle)
  }

  function install({ node, serverScript, home, workspace }) {
    const file = target()
    const vars = installVars({ node, serverScript, home, workspace })
    vars.context = buildContext(template.context, vars)

    const config = readConfig() || {}
    const installed = isInstalled()
    if (installed && !configNeedsRepair(serverScript)) {
      return { changed: false, configPath: file, message: `${host} Mio MCP already installed.` }
    }

    const backup = `${file}.bak-mio-${Date.now()}`
    if (fs.existsSync(file)) fs.copyFileSync(file, backup)

    const next = JSON.parse(JSON.stringify(config))
    let cursor = next
    for (const k of keyPath.slice(0, -1)) {
      if (!cursor[k] || typeof cursor[k] !== 'object') cursor[k] = {}
      cursor = cursor[k]
    }
    cursor[keyPath[keyPath.length - 1]] = interpolate(template.serverShape, vars)

    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')

    const base = installed ? `${host} Mio MCP repaired (server path updated).` : `${host} Mio MCP installed.`
    const hint = restartWarningMessage()
    return {
      changed: true,
      configPath: file,
      backup,
      message: hint ? `${base} ${hint}` : base,
    }
  }

  function restartWarningMessage() {
    const r = template.restart || {}
    return restartWarning({
      hostLabel: r.hostLabel || template.hostLabel || host,
      exeName: r.exeName,
      exePathFragment: r.exePathFragment,
      configPath: target(),
    })
  }

  return {
    configPath: target,
    isHostPresent: () => hostPresent({ configPath: target(), extraPaths: [path.dirname(target())] }),
    isInstalled,
    configNeedsRepair,
    install,
    restartWarningMessage,
  }
}

function compileTemplate(template, host) {
  const format = String(template.format || '').toLowerCase()
  if (format === 'toml') return compileToml(template, host)
  if (format === 'json') return compileJson(template, host)
  throw new Error(`${host}.template.json: unsupported format "${template.format}" (use toml or json)`)
}

// Template first, hand-written module second. A host that ships both is a
// template-driven host mid-migration; the template wins so the declarative
// definition is the one under test.
//
// The CLI's host key is `claude` but the module file is claude-code.js. Keeping
// that one mismatch here means every call site can stay `loadAdapter(key)`.
const MODULE_ALIASES = { claude: 'claude-code' }

function loadAdapter(host, dir = __dirname) {
  const template = readTemplate(host, dir)
  if (template) return compileTemplate(template, host)
  const moduleName = MODULE_ALIASES[host] || host
  return require(path.join(dir, `${moduleName}.js`))
}

module.exports = {
  TEMPLATE_SUFFIX,
  expandHome,
  interpolate,
  readTemplate,
  listTemplateHosts,
  compileTemplate,
  loadAdapter,
}
