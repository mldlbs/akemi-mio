#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')

const SERVER_SCRIPT = path.resolve(__dirname, '..', 'server', 'mio-intelligence-mcp', 'index.js')
const MIO_HOME = process.env.MIO_HOME || path.join(os.homedir(), '.mio-intelligence')
const CONFIG_FILE = path.join(MIO_HOME, 'config.json')

const adapters = {
  codex: require('../adapters/codex.js'),
  opencode: require('../adapters/opencode.js'),
  workbuddy: require('../adapters/workbuddy.js'),
  hermes: require('../adapters/hermes.js'),
  claude: require('../adapters/claude-code.js'),
}
const observer = require('../observe/observer.js')
const { getEvolutionStatus, formatEvolutionStatusText } = require('../server/runtime-modules.js')
const { createEvolutionCutoverTools } = require('../server/evolution-cutover.js')
const { createMemoryStore } = require('../server/memory-store.js')
const { createRetention } = require('../server/retention.js')
const { createDigest } = require('../server/digest.js')

function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8')
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

function projectName() {
  try {
    const commonDir = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    ).trim()
    if (commonDir) return path.basename(path.dirname(commonDir))
  } catch (_) {}
  return path.basename(process.cwd())
}

const evolutionCutover = createEvolutionCutoverTools({
  dataDir: MIO_HOME,
  appendJsonl,
  readJsonl,
  projectName,
})

function optionValue(args, name) {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  return args[index + 1]
}

function flagPresent(args, name) {
  return args.includes(name)
}

function parseJsonOption(args, name) {
  const raw = optionValue(args, name)
  if (raw === undefined) throw new Error(`${name} is required`)
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`${name} must be valid JSON`)
  }
}

function parseNumberOption(args, name) {
  const raw = optionValue(args, name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`)
  return value
}

function evolutionStatus(useJson) {
  const payload = getEvolutionStatus()
  if (useJson) {
    jsonOrText(payload, true)
    return
  }
  console.log(formatEvolutionStatusText(payload))
}

function printCutoverReadiness(readiness, useJson) {
  if (useJson) return jsonOrText(readiness, true)
  console.log(`Cutover readiness for ${readiness.project}: ${readiness.status}`)
  console.log(`shadow=${readiness.shadowRuns} dual-write=${readiness.dualWriteRuns}`)
  if (readiness.reasons.length > 0) console.log(`reasons: ${readiness.reasons.join('; ')}`)
}

function printAuthorityPlan(plan, useJson) {
  if (useJson) return jsonOrText(plan, true)
  console.log(`Authority switch ${plan.from} -> ${plan.to}: ${plan.approved ? 'ready' : 'blocked'}`)
  for (const action of plan.actions) console.log(`- ${action.type}`)
  for (const blocker of plan.blockers) console.log(`blocked: ${blocker}`)
}

function printMigrationPlan(plan, useJson) {
  if (useJson) return jsonOrText(plan, true)
  console.log(`Migration plan: ${plan.ready ? 'ready' : 'conflicts'}`)
  console.log(
    `legacy=${plan.summary.legacy} modular=${plan.summary.modular} toCreate=${plan.summary.toCreate} conflicts=${plan.summary.conflicts}`
  )
}

function printCutoverDryRun(result, useJson) {
  if (useJson) return jsonOrText(result, true)
  console.log(`Cutover apply dry-run: ${result.status}`)
  console.log(`applied=${result.applied}`)
  for (const action of result.actions) console.log(`- ${action.type}`)
}

function printShadowRecord(record, useJson) {
  if (useJson) return jsonOrText(record, true)
  console.log(`Shadow comparison ${record.id}: ${record.matched ? 'matched' : 'mismatch'}`)
  if (record.diffs.length > 0) console.log(`diffs=${record.diffs.length}`)
}

function printDualWriteRecord(record, useJson) {
  if (useJson) return jsonOrText(record, true)
  console.log(`Dual-write sample ${record.id}: authoritative=${record.authoritative}`)
  console.log(`shadow=${record.shadow.matched ? 'matched' : 'mismatch'}`)
}

async function evolutionCommand(args, useJson) {
  if (args[1] === 'status') return evolutionStatus(useJson)
  try {
    if (args[1] === 'shadow' && args[2] === 'record') {
      return printShadowRecord(
        await evolutionCutover.recordShadowComparison({
          project: optionValue(args, '--project'),
          label: optionValue(args, '--label'),
          legacy: parseJsonOption(args, '--legacy'),
          modular: parseJsonOption(args, '--modular'),
          input: optionValue(args, '--input') === undefined ? undefined : parseJsonOption(args, '--input'),
        }),
        useJson,
      )
    }
    if (args[1] === 'dual-write' && args[2] === 'record') {
      return printDualWriteRecord(
        await evolutionCutover.recordDualWrite({
          project: optionValue(args, '--project'),
          label: optionValue(args, '--label'),
          authoritative: optionValue(args, '--authoritative'),
          legacyResult: parseJsonOption(args, '--legacy-result'),
          modularResult: parseJsonOption(args, '--modular-result'),
          record: optionValue(args, '--record') === undefined ? undefined : parseJsonOption(args, '--record'),
        }),
        useJson,
      )
    }
    if (args[1] === 'cutover' && args[2] === 'readiness') {
      return printCutoverReadiness(
        evolutionCutover.cutoverReadiness({
          project: optionValue(args, '--project'),
          minShadowRuns: parseNumberOption(args, '--min-shadow-runs'),
          maxMismatchRate: parseNumberOption(args, '--max-mismatch-rate'),
        }),
        useJson,
      )
    }
    if (args[1] === 'cutover' && args[2] === 'apply') {
      return printCutoverDryRun(
        evolutionCutover.applyCutover({
          dryRun: flagPresent(args, '--dry-run'),
          project: optionValue(args, '--project'),
          plan: parseJsonOption(args, '--plan'),
        }),
        useJson,
      )
    }
    if (args[1] === 'authority' && args[2] === 'plan') {
      return printAuthorityPlan(
        evolutionCutover.authorityPlan({
          readiness: parseJsonOption(args, '--readiness'),
          from: optionValue(args, '--from'),
          to: optionValue(args, '--to'),
        }),
        useJson,
      )
    }
    if (args[1] === 'migration' && args[2] === 'plan') {
      return printMigrationPlan(
        evolutionCutover.migrationPlan({
          legacyRecords: parseJsonOption(args, '--legacy-records'),
          modularRecords: parseJsonOption(args, '--modular-records'),
        }),
        useJson,
      )
    }
  } catch (error) {
    console.error(error.message || error)
    process.exitCode = 1
    return
  }
  console.error('Usage: mio evolution status|shadow record|dual-write record|cutover readiness|cutover apply|authority plan|migration plan')
  process.exitCode = 1
}

function ensureHome() {
  fs.mkdirSync(MIO_HOME, { recursive: true })
  fs.mkdirSync(path.join(MIO_HOME, 'logs'), { recursive: true })
}

// CLI memory store: same ranking/persistence as the MCP server, pointed at
// MIO_HOME. No recordQuery hook — a terminal command cannot be followed by a
// task_outcome, so a recorded query would only be phase-0 noise.
function cliMemoryStore() {
  return createMemoryStore({
    dataDir: MIO_HOME,
    projectName,
    agentId: () => 'cli',
  })
}

function splitTagsOption(args, name) {
  const raw = optionValue(args, name)
  if (raw === undefined) return []
  return raw
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
}

function recallCommand(args, useJson) {
  const query = args[1]
  if (!query) {
    console.error('Usage: mio recall "<query>" [--project name] [--scope project|global|all] [--kind kind] [--tags a,b] [--limit n] [--json]')
    process.exitCode = 1
    return
  }
  const flags = args.slice(2)
  const store = cliMemoryStore()
  let result
  try {
    result = store.queryMemory({
      query,
      project: optionValue(flags, '--project'),
      scope: optionValue(flags, '--scope'),
      kind: optionValue(flags, '--kind'),
      tags: splitTagsOption(flags, '--tags'),
      limit: parseNumberOption(flags, '--limit'),
    })
  } catch (error) {
    console.error(error.message || error)
    process.exitCode = 1
    return
  }
  if (useJson) return jsonOrText(result, true)
  console.log(
    `Mio memory: ${result.count} result(s) for "${result.query}" (project=${result.project}, scope=${result.scope})`
  )
  result.results.forEach((record, index) => {
    const date = (record.timestamp || '').slice(0, 10)
    console.log(`${index + 1}. [${record.kind || 'note'}] ${record.content}`)
    const meta = [
      (record.tags || []).length > 0 ? `tags: ${record.tags.join(', ')}` : null,
      record.source ? `source: ${record.source}` : null,
      date,
      record.id,
    ]
      .filter(Boolean)
      .join(' | ')
    console.log(`   ${meta}`)
  })
}

function tracesCommand(args, useJson) {
  const flags = args.slice(1)
  const store = cliMemoryStore()
  let result
  try {
    result = store.queryTraces({
      event_type: optionValue(flags, '--type'),
      outcome: optionValue(flags, '--outcome'),
      project: optionValue(flags, '--project'),
      agent: optionValue(flags, '--agent'),
      host: optionValue(flags, '--host'),
      since: optionValue(flags, '--since'),
      until: optionValue(flags, '--until'),
      limit: parseNumberOption(flags, '--limit'),
      include_payload: !flagPresent(flags, '--compact'),
    })
  } catch (error) {
    console.error(error.message || error)
    process.exitCode = 1
    return
  }
  if (useJson) return jsonOrText(result, true)
  const filters = Object.entries(result.filters)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ')
  console.log(
    `Mio traces: ${result.matched} matched / ${result.total} total${filters ? ' (' + filters + ')' : ''}`
  )
  const summary = Object.entries(result.summary.byOutcome)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')
  if (summary) console.log(`outcomes: ${summary}`)
  result.results.forEach((trace, index) => {
    const time = (trace.timestamp || '').replace('T', ' ').slice(0, 19)
    const brief = trace.payload && trace.payload.summary ? ' | ' + String(trace.payload.summary).slice(0, 100) : ''
    console.log(
      `${index + 1}. ${time} [${trace.event_type || '?'}${trace.outcome ? '/' + trace.outcome : ''}] ${trace.agent || '?'} @ ${trace.project || '?'}${brief}`
    )
    console.log(`   ${trace.id} trace_id=${trace.trace_id || '-'}`)
  })
}

function digestCommand(args, useJson) {
  const flags = args.slice(1)
  const days = parseNumberOption(flags, '--days') || 7
  const writeBack = flagPresent(flags, '--write-back')
  const outDir = path.join(MIO_HOME, 'digest')

  const report = createDigest({ home: MIO_HOME }).generate({
    days,
    project: optionValue(flags, '--project'),
  })

  if (writeBack) {
    // Feed the actionable lines back into each active workspace context file
    // (AGENTS.md / CLAUDE.md MIO_CONTEXT block), so every agent passively
    // receives the digest's value on its next session.
    const stateFile = path.join(MIO_HOME, 'observe-state.json')
    let state = {}
    try {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    } catch (_) {}
    state.contexts = state.contexts || {}
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false })
    const rate =
      report.overview.tasks > 0
        ? Math.round(((report.overview.byOutcome.success || 0) / report.overview.tasks) * 100)
        : 0
    const headline =
      `digest(${days}d): 任务 ${report.overview.tasks} 条 成功率 ${rate}%, error ${report.overview.errorTraces}` +
      (report.suggestions.length > 0 ? ' | ' + report.suggestions[0] : '')
    const targetCwds = optionValue(flags, '--cwd')
      ? [optionValue(flags, '--cwd')]
      : Object.keys(state.contexts)
    let written = 0
    for (const cwd of targetCwds) {
      try {
        observer.updateProjectContext(state, cwd, stamp + ' | ' + headline, 'CLAUDE.md')
        observer.updateProjectContext(state, cwd, stamp + ' | ' + headline, 'AGENTS.md')
        written += 1
      } catch (_) {}
    }
    fs.mkdirSync(MIO_HOME, { recursive: true })
    fs.writeFileSync(stateFile, JSON.stringify(state) + '\n', 'utf8')
    report.writeBack = { workspaces: written, headline }
  }

  // Persist the report so it becomes part of the data asset itself.
  fs.mkdirSync(outDir, { recursive: true })
  const reportFile = path.join(outDir, 'digest-' + report.generatedAt.slice(0, 10) + '.md')
  fs.writeFileSync(reportFile, report.markdown, 'utf8')
  report.reportFile = reportFile

  if (useJson) return jsonOrText(report, true)
  console.log(report.markdown)
  console.log(`Report saved: ${reportFile}`)
  if (report.writeBack) {
    console.log(`Write-back: ${report.writeBack.workspaces} workspace(s) <- "${report.writeBack.headline}"`)
  }
}

function pruneCommand(args, useJson) {
  const flags = args.slice(1)
  const days = parseNumberOption(flags, '--days') || 30
  const includeMemory = flagPresent(flags, '--memory')
  const dryRun = flagPresent(flags, '--dry-run')
  if (includeMemory && !dryRun && !flagPresent(flags, '--yes')) {
    console.error('Pruning memory.jsonl is destructive. Re-run with --yes to confirm (a .bak-prune-* backup is still written).')
    process.exitCode = 1
    return
  }
  const retention = createRetention({ home: MIO_HOME })
  let result
  try {
    result = retention.prune({ days, includeMemory, dryRun })
  } catch (error) {
    console.error(error.message || error)
    process.exitCode = 1
    return
  }
  if (useJson) return jsonOrText(result, true)
  console.log(
    `Prune ${dryRun ? 'plan (dry-run)' : 'result'}: cutoff ${result.cutoff}, days=${days}${includeMemory ? ', memory included' : ''}`
  )
  for (const file of result.files) {
    console.log(`- ${file.file}: ${file.total} total -> keep ${file.kept}, remove ${file.removed}`)
  }
  console.log(`Total removed: ${result.totalRemoved}`)
  if (dryRun) console.log('Dry run - nothing written. Re-run without --dry-run to apply.')
  else console.log('Backups written as <file>.bak-prune-<ts> before rewriting.')
}

function rememberCommand(args, useJson) {
  const content = args[1]
  if (!content) {
    console.error('Usage: mio remember "<content>" [--kind decision|context|problem|note] [--tags a,b] [--scope project|global] [--project name] [--json]')
    process.exitCode = 1
    return
  }
  const flags = args.slice(2)
  const store = cliMemoryStore()
  let record
  try {
    record = store.recordMemory({
      content,
      kind: optionValue(flags, '--kind'),
      tags: splitTagsOption(flags, '--tags'),
      scope: optionValue(flags, '--scope'),
      project: optionValue(flags, '--project'),
      source: 'cli',
    })
  } catch (error) {
    console.error(error.message || error)
    process.exitCode = 1
    return
  }
  if (useJson) return jsonOrText(record, true)
  console.log(`Recorded ${record.id} (kind=${record.kind}, project=${record.project || 'global'}, scope=${record.scope})`)
}

function readConfig() {
  const fallback = { version: 1, home: MIO_HOME, agents: {} }
  if (!fs.existsSync(CONFIG_FILE)) return fallback
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }
  } catch (_) {
    return fallback
  }
}

function writeConfig(config) {
  ensureHome()
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

function jsonOrText(payload, useJson) {
  if (useJson) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }
  return payload
}

function initCommand() {
  ensureHome()
  const config = readConfig()
  if (!config.createdAt) config.createdAt = new Date().toISOString()
  writeConfig(config)
  console.log(`MIO_HOME ready: ${MIO_HOME}`)
}

function statusCommand(useJson) {
  const config = readConfig()
  const codexRestart = adapters.codex.restartWarningMessage()
  const opencodeRestart = adapters.opencode.restartWarningMessage()
  const installed = {
    codex: adapters.codex.isInstalled(),
    opencode: adapters.opencode.isInstalled(),
    workbuddy: adapters.workbuddy.isInstalled(),
    hermes: adapters.hermes.isInstalled(),
    claude: adapters.claude.isInstalled(),
  }
  const payload = {
    version: config.version,
    home: MIO_HOME,
    serverScript: SERVER_SCRIPT,
    serverScriptExists: fs.existsSync(SERVER_SCRIPT),
    agents: config.agents || {},
    codexInstalled: installed.codex,
    opencodeInstalled: installed.opencode,
    workbuddyInstalled: installed.workbuddy,
    hermesInstalled: installed.hermes,
    claudeInstalled: installed.claude,
    codexNeedsRestart: Boolean(codexRestart),
    opencodeNeedsRestart: Boolean(opencodeRestart),
    codexRestartHint: codexRestart,
    opencodeRestartHint: opencodeRestart,
    hermesObserverReady: fs.existsSync(observer.hermesDbPath()),
    claudeObserverReady: fs.existsSync(observer.claudeProjectsDir()),
    opencodeObserverReady: fs.existsSync(observer.opencodeDbPath()),
    observerRunning: observer.isRunning(MIO_HOME),
    observerPid: observer.isRunning(MIO_HOME) ? observer.readPid(MIO_HOME) : null,
  }
  if (useJson) {
    jsonOrText(payload, true)
    return
  }
  console.log(`MIO_HOME: ${MIO_HOME}`)
  console.log(`MCP Server: ${SERVER_SCRIPT}`)
  console.log(`Codex MCP: ${installed.codex ? 'installed' : 'not installed'}`)
  if (codexRestart) console.log(`Codex app: running with an older Mio config - fully restart Codex to load it`)
  console.log(`OpenCode MCP: ${installed.opencode ? 'installed' : 'not installed'}`)
  if (opencodeRestart) console.log(`OpenCode Desktop: running with an older Mio config - restart it to load it`)
  console.log(`OpenCode observer: ${fs.existsSync(observer.opencodeDbPath()) ? 'ready' : 'no database'}`)
  console.log(`WorkBuddy MCP: ${installed.workbuddy ? 'installed' : 'not installed'}`)
  console.log(`Hermes MCP: ${installed.hermes ? 'installed' : 'not installed'}`)
  console.log(`Hermes observer: ${fs.existsSync(observer.hermesDbPath()) ? 'ready' : 'no database'}`)
  console.log(`Claude Code MCP: ${installed.claude ? 'installed' : 'not installed'}`)
  console.log(`Claude Code observer: ${fs.existsSync(observer.claudeProjectsDir()) ? 'ready' : 'no transcripts'}`)
  console.log(`Observer: ${observer.isRunning(MIO_HOME) ? 'running (pid ' + observer.readPid(MIO_HOME) + ')' : 'not running'}`)
}

function agentsCommand(useJson) {
  const config = readConfig()
  const agents = config.agents || {}
  if (useJson) {
    jsonOrText(agents, true)
    return
  }
  const names = Object.keys(agents)
  if (names.length === 0) {
    console.log('No agents installed.')
    return
  }
  for (const name of names) {
    console.log(`${name}\t${agents[name].installedAt || ''}`)
  }
}

function installCommand(host, useJson) {
  if (!host) {
    console.error('Usage: mio install <codex|opencode|workbuddy|hermes|claude>')
    process.exitCode = 1
    return
  }
  const adapter = adapters[host]
  if (!adapter) {
    console.error(`Unknown host: ${host}`)
    process.exitCode = 1
    return
  }
  ensureHome()
  const config = readConfig()
  let result
  try {
    result = adapter.install({
      node: process.execPath,
      serverScript: SERVER_SCRIPT,
      home: MIO_HOME,
      workspace: process.cwd(),
    })
  } catch (error) {
    console.error(`Failed to install ${host}: ${error.message || error}`)
    process.exitCode = 1
    return
  }
  if (result.changed) {
    config.agents = config.agents || {}
    config.agents[host] = {
      installedAt: new Date().toISOString(),
      configPath: result.configPath || null,
    }
    writeConfig(config)
  }
  try {
    observer.runCycle(MIO_HOME, observer.loadState(MIO_HOME), observer.createSinks(MIO_HOME))
  } catch (_) {}
  let observerStarted = false
  try {
    observerStarted = observer.startBackground(MIO_HOME).started
  } catch (_) {}
  if (useJson) {
    result.observer = {
      running: observer.isRunning(MIO_HOME),
      started: observerStarted,
    }
    jsonOrText(result, true)
    return
  }
  console.log(result.message || `${host} adapter completed.`)
  console.log(
    observer.isRunning(MIO_HOME)
      ? 'Observer daemon running.'
      : 'Observer daemon not running. Run `mio observe --start`.'
  )
}

function mcpCommand() {
  require(SERVER_SCRIPT)
}

function observeCommand(args) {
  const flags = args.slice(1)
  const useJson = flags.includes('--json')
  if (flags.includes('--start')) {
    const result = observer.startBackground(MIO_HOME)
    if (useJson) return jsonOrText(result, true)
    console.log(result.started ? 'Observer started.' : 'Observer already running.')
    return
  }
  if (flags.includes('--stop')) {
    const result = observer.stopBackground(MIO_HOME)
    if (useJson) return jsonOrText(result, true)
    console.log(result.stopped ? 'Observer stopped.' : 'Observer was not running.')
    return
  }
  if (flags.includes('--status')) {
    const running = observer.isRunning(MIO_HOME)
    const pid = observer.readPid(MIO_HOME)
    if (useJson) return jsonOrText({ running, pid }, true)
    console.log(running ? 'Observer: running (pid ' + pid + ')' : 'Observer: not running')
    return
  }
  if (flags.includes('--once')) {
    const res = observer.runCycle(
      MIO_HOME,
      observer.loadState(MIO_HOME),
      observer.createSinks(MIO_HOME)
    )
    if (useJson) return jsonOrText(res, true)
    console.log('Observed files=' + res.files + ' lines=' + res.lines + ' outcomes=' + res.outcomes)
    return
  }
  console.log('Observing WorkBuddy transcripts into ' + MIO_HOME + ' (Ctrl+C to stop)...')
  observer.startForeground(MIO_HOME)
}

function help() {
  console.log(`Mio Agent Runtime CLI

Usage:
  mio init                    Initialize MIO_HOME
  mio mcp                     Start Mio MCP server (stdio)
  mio install <host>          Install Mio into a host (codex|opencode|workbuddy|hermes|claude)
  mio status                  Show runtime and adapter status
  mio agents                  List installed agents
  mio evolution status        Show composed evolution module health
  mio evolution shadow record      Record a shadow comparison sample
  mio evolution dual-write record  Record a dual-write comparison sample
  mio evolution cutover readiness   Assess shadow/dual-write cutover readiness
  mio evolution authority plan      Preview a gated authority switch plan
  mio evolution migration plan      Preview state migration diffs
  mio evolution cutover apply --dry-run   Dry-run a cutover plan without switching authority
  mio observe                 Watch WorkBuddy transcripts and auto-ingest task outcomes
  mio observe --start|--stop|--status|--once   Manage the background observer daemon
  mio recall "<query>"        Search Mio memory from the terminal (same ranking as mio.memory.query)
  mio traces                  Show recent observer traces (--type/--outcome/--agent/--since/--limit/--compact)
  mio remember "<content>"    Write a memory record from the terminal (same schema as mio.memory.record)
  mio prune --days 30         Trim old traces/queries/reuse records and observe.log (--dry-run to preview; --memory needs --yes)
  mio digest --days 7         Aggregate traces/memory/reuse into an actionable report (--write-back feeds agent context files; --json)
  mio --json status           Machine-readable status
  mio --json agents           Machine-readable agents
  mio --json evolution status Machine-readable evolution module health
`)
}

async function main() {
  const args = process.argv.slice(2)
  const jsonIndex = args.indexOf('--json')
  const useJson = jsonIndex !== -1
  if (useJson) args.splice(jsonIndex, 1)
  const command = args[0] || 'help'

  switch (command) {
    case 'init':
      return initCommand()
    case 'mcp':
      return mcpCommand()
    case 'install':
      return installCommand(args[1], useJson)
    case 'status':
      return statusCommand(useJson)
    case 'agents':
      return agentsCommand(useJson)
    case 'observe':
      return observeCommand(args)
    case 'recall':
      return recallCommand(args, useJson)
    case 'traces':
      return tracesCommand(args, useJson)
    case 'remember':
      return rememberCommand(args, useJson)
    case 'prune':
      return pruneCommand(args, useJson)
    case 'digest':
      return digestCommand(args, useJson)
    case 'evolution':
      return evolutionCommand(args, useJson)
    case 'help':
    case '--help':
      return help()
    default:
      console.error(`Unknown command: ${command}`)
      help()
      process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error.message || error)
  process.exitCode = 1
})
