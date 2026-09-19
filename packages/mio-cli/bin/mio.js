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
const { createExperienceStore } = require('../server/experience-store.js')
const { createPolicyStore } = require('../server/policy-store.js')
const { CreativityEngine } = require('../server/creativity-engine.js')
const { createAgentStore } = require('../server/agent-store.js')
const { createInsightStore } = require('../server/insight-store.js')
const { createObserverStore } = require('../server/observer-store.js')
const { loadPhase0, renderPhase0Markdown } = require('../server/mio-intelligence-mcp/phase0.js')
const { listHostCapabilities } = require('../server/host-capabilities.js')
const { createTaskStore } = require('../server/task-store.js')
const { chatJson, llmConfig, isLlmConfigured } = require('../server/llm-client.js')
const { createQueryLog } = require('../server/query-log.js')
const { createSubscriptionStore, subscribeKey } = require('../server/subscription-store.js')
const { createRetention } = require('../server/retention.js')
const { createDigest } = require('../server/digest.js')
const { createEvolutionReport, formatEvolutionReportText } = require('../server/evolution-report.js')

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

// mio evolution report shares one implementation with mio.evolution.report
// (see ../server/evolution-report.js), so CLI and MCP cannot report different numbers.
function cliEvolutionReport() {
  return createEvolutionReport({ dataDir: MIO_HOME, projectName })
}

const EVOLUTION_REPORT_PERIODS = new Set(['24h', '7d', '30d', 'all'])

function evolutionReportCommand(args, useJson) {
  const flags = args.slice(2)
  const period = optionValue(flags, '--period')
  if (period !== undefined && !EVOLUTION_REPORT_PERIODS.has(period)) {
    console.error(`--period must be one of: ${[...EVOLUTION_REPORT_PERIODS].join(', ')}`)
    process.exitCode = 1
    return
  }

  let result
  try {
    result = cliEvolutionReport().report({
      project: optionValue(flags, '--project'),
      period,
    })
  } catch (error) {
    console.error(error.message || error)
    process.exitCode = 1
    return
  }

  if (useJson) return jsonOrText(result, true)
  console.log(formatEvolutionReportText(result))
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
  if (args[1] === 'report') return evolutionReportCommand(args, useJson)
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
  console.error('Usage: mio evolution status|report|shadow record|dual-write record|cutover readiness|cutover apply|authority plan|migration plan')
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

// policy.check deliberately reads the *global* MIO_HOME rather than a
// per-project directory, so its history matches `mio recall` and `mio traces`.
// It shares the memory store's tokenizer and scoring, so risk evidence and
// related-memory ranking line up with `mio.memory.query`.
function cliPolicyStore() {
  const memoryStore = cliMemoryStore()
  return createPolicyStore({
    dataDir: MIO_HOME,
    projectName,
    memoryStore,
  })
}

// The creativity engine is the single implementation behind mio.creativity.*;
// the CLI points it at the global MIO_HOME so a terminal `mio creativity list`
// sees the same hypotheses the MCP server would. generate/ferment need an LLM,
// so they use the shared client -- configured with LLM_API_URL / LLM_KEY /
// LLM_CHAT_MODEL, the same environment the MCP server reads. A local Ollama
// works: LLM_API_URL=http://localhost:11434/v1/chat/completions
function cliCreativityEngine() {
  const creativityDir = path.join(MIO_HOME, 'creativity')
  return new CreativityEngine(creativityDir, chatJson)
}

// Observed-agent telemetry (agents.jsonl + traces/memory/reuse cross-reference)
// shares one store with the MCP server, so CLI and MCP report identical agents.
function cliAgentStore() {
  return createAgentStore({ dataDir: MIO_HOME, projectName })
}

// Task routing shares one store with mio.task.route. persistQuery stays false:
// the MCP call feeds the query log for auto-claim, but a terminal inspection
// must not write to queries.jsonl every time it runs.
function cliTaskStore() {
  // Shares one query-log instance with nothing else here, but created from the
  // same module the MCP server uses, so queries.jsonl has a single reader/writer
  // implementation. cliMemoryStore deliberately does NOT get one: a terminal
  // recall is never followed by a task_outcome, so recording those queries
  // would only add noise.
  return createTaskStore({
    dataDir: MIO_HOME,
    projectName,
    memoryStore: cliMemoryStore(),
    queryLog: createQueryLog({ dataDir: MIO_HOME }),
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
    //
    // Targets are resolved per project, never broadcast. An earlier version
    // wrote one global headline into Object.keys(state.contexts) -- every
    // workspace ever observed -- so unrelated repos (ComfyUI, douyin_store)
    // received the same line and their real history was pushed out of the
    // six-slot block. Write only where the digest actually has data for that
    // project, or where the caller explicitly asked with --cwd/--project.
    const stateFile = path.join(MIO_HOME, 'observe-state.json')
    let state = {}
    try {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    } catch (_) {}
    state.contexts = state.contexts || {}
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false })

    // Project name -> per-project digest line.
    const projectLine = new Map()
    for (const entry of report.projects || []) {
      if (!entry || !entry.project) continue
      const rate = entry.tasks > 0 ? Math.round(((entry.success || 0) / entry.tasks) * 100) : 0
      projectLine.set(String(entry.project).toLowerCase(), `digest(${days}d): ${entry.project} ${entry.tasks} 任务 ${rate}% 成功`)
    }

    const explicitCwd = optionValue(flags, '--cwd')
    const explicitProject = optionValue(flags, '--project')
    let targetCwds = []
    if (explicitCwd) {
      targetCwds = [explicitCwd]
    } else if (explicitProject) {
      const wanted = String(explicitProject).toLowerCase()
      targetCwds = Object.keys(state.contexts).filter(
        (cwd) => path.basename(cwd).toLowerCase() === wanted,
      )
    } else {
      // No explicit target: only write to workspaces this digest has data for.
      // A workspace with no matching project gets nothing.
      targetCwds = Object.keys(state.contexts).filter((cwd) =>
        projectLine.has(path.basename(cwd).toLowerCase()),
      )
    }

    let written = 0
    for (const cwd of targetCwds) {
      const line = projectLine.get(path.basename(cwd).toLowerCase())
      if (!line) continue
      try {
        observer.updateProjectContext(state, cwd, stamp + ' | ' + line, 'CLAUDE.md')
        observer.updateProjectContext(state, cwd, stamp + ' | ' + line, 'AGENTS.md')
        written += 1
      } catch (_) {}
    }
    fs.mkdirSync(MIO_HOME, { recursive: true })
    fs.writeFileSync(stateFile, JSON.stringify(state) + '\n', 'utf8')
    report.writeBack = {
      workspaces: written,
      skipped: Object.keys(state.contexts).length - written,
      projects: [...projectLine.values()],
    }
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
    console.log(
      `Write-back: ${report.writeBack.workspaces} workspace(s), ${report.writeBack.skipped} skipped (no digest data)`,
    )
    for (const line of report.writeBack.projects) console.log(`  - ${line}`)
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

// Every flag that consumes the next token. A positional directly after one of
// these is that flag's value, not an id.
const VALUE_FLAGS = new Set([
  '--ids', '--reason', '--project', '--limit', '--scope', '--keep',
  '--by', '--notes', '--source-agent', '--target-agent', '--experience-id', '--status',
])

// Accept ids both as `--ids a,b,c` and as bare positionals
// (`mio memory archive mem_a mem_b`).
function collectIds(flags) {
  const ids = []
  for (let i = 0; i < flags.length; i += 1) {
    const token = flags[i]
    if (token.startsWith('--')) continue
    const previous = flags[i - 1]
    if (previous && VALUE_FLAGS.has(previous)) continue
    // Ids never contain commas, so a comma-separated positional is unambiguous.
    for (const id of token.split(',')) {
      const trimmed = id.trim()
      if (trimmed) ids.push(trimmed)
    }
  }
  const raw = optionValue(flags, '--ids')
  if (raw !== undefined) {
    for (const id of raw.split(',')) {
      const trimmed = id.trim()
      if (trimmed) ids.push(trimmed)
    }
  }
  return [...new Set(ids)]
}

function printMemoryAnalyze(result) {
  const project = result.project || 'all'
  console.log(
    `Memory analyze: ${result.total} active, ${result.archived} archived (project=${project})`,
  )
  console.log(`layers: project=${result.layers.project} global=${result.layers.global}`)
  const kinds = Object.entries(result.byKind)
  if (kinds.length > 0) {
    console.log(`by kind: ${kinds.map(([kind, count]) => `${kind}=${count}`).join(', ')}`)
  }

  if (result.duplicates.length > 0) {
    console.log(`\nDuplicate groups: ${result.duplicates.length}`)
    for (const group of result.duplicates) {
      console.log(`- ${group.size} record(s): ${group.records.map((record) => record.id).join(', ')}`)
      const preview = String(group.records[0].content || '')
      if (preview) {
        console.log(`  ${preview.length > 80 ? `${preview.slice(0, 80)}...` : preview}`)
      }
    }
  }

  if (result.lowQuality.length > 0) {
    console.log(`\nLow quality: ${result.issues.lowQuality} record(s)`)
    for (const record of result.lowQuality) {
      console.log(`- ${record.id} [${record.kind || 'note'}] ${record.issues.join(', ')}`)
    }
  }

  if (result.issues.duplicatesSkipped) {
    console.log('\nDuplicate scan skipped: too many active records to compare pairwise.')
  }

  if (result.suggestions.length > 0) {
    console.log('')
    for (const suggestion of result.suggestions) console.log(`suggestion: ${suggestion}`)
  }
}

// Merging divergent content is refused by default; when that happens the
// caller needs to see *what* differs before deciding, so print the candidates.
function printMemoryMerge(result) {
  if (!result.merged) {
    console.log(`No merge applied (project=${result.project || 'current'}): ${result.reason}`)
    if (result.divergent.length > 0) {
      console.log('\nDivergent content — inspect before choosing a survivor:')
      for (const record of result.divergent) {
        console.log(`- ${record.id} (${record.contentLength} chars, ${record.timestamp || 'no timestamp'})`)
        console.log(`    ${record.content.split('\n')[0].slice(0, 110)}`)
      }
    }
    if (result.notFound.length > 0) console.log(`\nnot found: ${result.notFound.join(', ')}`)
    if (result.outOfScope && result.outOfScope.length > 0) {
      console.log(`\nbelongs to another project: ${result.outOfScope.join(', ')}`)
    }
    if (result.hint) console.log(`\n${result.hint}`)
    process.exitCode = 1
    return
  }

  // A merge that archived nothing is a no-op: every requested id was already
  // archived (i.e. these were merged before). Report it as failure the same way
  // archive does, so scripts do not read success out of an idempotent re-run.
  if (result.archivedCount === 0) {
    console.log(`No merge applied (project=${result.project || 'current'}): nothing left to merge`)
    if (result.skipped.length > 0) {
      console.log(`already archived (previously merged): ${result.skipped.join(', ')}`)
      console.log(`superseded by: ${result.survivor.id}`)
    }
    if (result.notFound.length > 0) console.log(`not found: ${result.notFound.join(', ')}`)
    process.exitCode = 1
    return
  }

  console.log(
    `Merged ${result.archivedCount} record(s) into ${result.survivor.id} (project=${result.project || 'current'})`,
  )
  console.log(`survivor: ${result.survivor.contentLength} chars, ${result.survivor.timestamp || 'no timestamp'}`)
  if (result.divergentContent) console.log('note: content differed across members; the survivor body was chosen explicitly')
  console.log(`supersedes: ${result.survivor.supersedes.join(', ')}`)
  if (result.skipped.length > 0) console.log(`already archived: ${result.skipped.join(', ')}`)
  if (result.notFound.length > 0) console.log(`not found: ${result.notFound.join(', ')}`)
  console.log(`Undo with: mio memory restore --ids ${result.archived.join(',')}`)
}

function memoryUsage() {
  console.log(`Usage:
  mio memory analyze                        Report duplicates, low-quality records and kind histogram
  mio memory archive --ids a,b              Archive records (soft delete; hidden from recall/analyze)
  mio memory restore --ids a,b              Un-archive previously archived records
  mio memory forget --ids a,b               PERMANENTLY delete records (--yes required; writes an audit entry)
  mio memory merge --ids a,b                Merge duplicates: one survives, the rest are archived
  mio memory migrate --ids a,b --scope global   Move records between project and global layers

Options:
  --ids a,b,c        Memory record ids (also accepted as bare positionals)
  --keep id          Merge: which record's content survives (default: newest)
  --allow-divergent  Merge: permit merging records whose content differs (requires --keep)
  --scope global|project   Target layer for migrate
  --project name     Project filter (defaults to current directory name)
  --reason text      Optional note stored on the record
  --limit n          Max duplicate groups / low-quality rows to show (analyze, 1-20)
  --yes              Apply archive/merge (without it they only preview)
  --json             Machine-readable output
`)
}

function memoryCommand(args, useJson) {
  const sub = args[1]
  const flags = args.slice(2)

  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    memoryUsage()
    if (!sub) process.exitCode = 1
    return
  }
  if (!['analyze', 'archive', 'restore', 'forget', 'merge', 'migrate'].includes(sub)) {
    console.error(`Unknown memory subcommand: ${sub}`)
    memoryUsage()
    process.exitCode = 1
    return
  }

  const store = cliMemoryStore()

  if (sub === 'analyze') {
    let result
    try {
      result = store.analyzeMemory({
        project: optionValue(flags, '--project'),
        limit: parseNumberOption(flags, '--limit'),
      })
    } catch (error) {
      console.error(error.message || error)
      process.exitCode = 1
      return
    }
    if (useJson) return jsonOrText(result, true)
    return printMemoryAnalyze(result)
  }

  const ids = collectIds(flags)
  if (ids.length === 0) {
    console.error(`mio memory ${sub} requires --ids <id,id,...> (or bare ids)`)
    process.exitCode = 1
    return
  }
  if (sub === 'merge' && ids.length < 2) {
    console.error('mio memory merge requires at least 2 ids (nothing to merge otherwise)')
    process.exitCode = 1
    return
  }

  if ((sub === 'archive' || sub === 'merge' || sub === 'forget') && !flagPresent(flags, '--yes')) {
    // Archiving hides records from recall, merging additionally rewrites the
    // survivor's supersedes list, and forgetting deletes outright. Preview first
    // so a mistyped id cannot silently destroy data.
    const previewProject = optionValue(flags, '--project') || projectName() || 'current'
    if (useJson) {
      jsonOrText(
        {
          preview: true,
          applied: false,
          project: previewProject,
          ids,
          keep: optionValue(flags, '--keep') || null,
          reversible: sub !== 'forget',
          hint:
            sub === 'forget'
              ? 'PERMANENT: re-run with --yes to delete. Consider mio memory archive instead.'
              : 'Re-run with --yes to apply.',
        },
        true,
      )
    } else if (sub === 'forget') {
      // Show *what* is about to disappear, not just the ids: this is the one
      // memory operation that cannot be undone.
      const all = readJsonl(cliMemoryStore().memoryPath)
      const idSet = new Set(ids)
      const matched = all.filter((r) => idSet.has(r.id))
      console.log(`Forget preview: ${ids.length} id(s) (project=${previewProject})`)
      for (const record of matched) {
        console.log(`  ${record.id}  ${String(record.content || '').replace(/\s+/g, ' ').slice(0, 80)}`)
      }
      for (const id of ids) {
        if (!matched.some((r) => r.id === id)) console.log(`  ${id}  (not found)`)
      }
      console.log('')
      console.log('WARNING: this permanently deletes the record(s) and cannot be undone.')
      console.log('An audit entry (excerpt only) is written to memory-forget-audit.jsonl.')
      console.log(`Reversible alternative: mio memory archive --ids ${ids.join(',')} --yes`)
      console.log('Re-run with --yes to delete permanently.')
    } else {
      // Archive keeps its historical "Archive preview" wording; merge is newer
      // and uses a lowercase verb to read naturally mid-sentence.
      const label = sub === 'merge' ? 'merge preview' : 'Archive preview'
      console.log(`${label}: ${ids.length} id(s) (project=${previewProject})`)
      console.log(`  ${ids.join(', ')}`)
      if (sub === 'merge') {
        const keep = optionValue(flags, '--keep')
        console.log(`  survivor: ${keep || 'newest by timestamp (default)'}`)
      }
      console.log(`Re-run with --yes to apply. Undo with: mio memory restore --ids <ids>`)
    }
    process.exitCode = 1
    return
  }

  let result
  try {
    if (sub === 'archive' || sub === 'restore') {
      result = store.archiveMemory({
        ids,
        project: optionValue(flags, '--project'),
        restore: sub === 'restore',
        reason: optionValue(flags, '--reason'),
      })
    } else if (sub === 'merge') {
      result = store.mergeMemory({
        ids,
        project: optionValue(flags, '--project'),
        keep: optionValue(flags, '--keep'),
        allowDivergent: flagPresent(flags, '--allow-divergent'),
        reason: optionValue(flags, '--reason'),
      })
    } else if (sub === 'forget') {
      result = store.forgetMemory({
        ids,
        project: optionValue(flags, '--project'),
        reason: optionValue(flags, '--reason'),
        by: 'cli',
      })
    } else {
      result = store.migrateMemory({
        ids,
        scope: optionValue(flags, '--scope'),
        project: optionValue(flags, '--project'),
        reason: optionValue(flags, '--reason'),
      })
    }
  } catch (error) {
    console.error(error.message || error)
    process.exitCode = 1
    return
  }

  if (useJson) return jsonOrText(result, true)

  if (sub === 'merge') return printMemoryMerge(result)

  if (sub === 'forget') {
    console.log(`Forgot ${result.forgottenCount} record(s) permanently (project=${result.project || 'current'})`)
    if (result.forgotten.length > 0) console.log(`deleted: ${result.forgotten.join(', ')}`)
    if (result.notFound.length > 0) console.log(`not found: ${result.notFound.join(', ')}`)
    console.log(`audit: ${result.auditPath}`)
    // Everything missing is a typo; do not let a no-op read as success.
    if (result.forgottenCount === 0) {
      process.exitCode = 1
      return
    }
    // No undo is possible -- say so, and point at what should have been used.
    console.log('This cannot be undone. (Next time consider `mio memory archive`, which is reversible.)')
    return
  }

  if (sub === 'migrate') {
    const target = result.scope === 'global' ? 'global' : `project=${result.project || 'current'}`
    console.log(`Migrated ${result.updatedCount} record(s) to ${target}`)
    if (result.updated.length > 0) console.log(`updated: ${result.updated.join(', ')}`)
    if (result.unchanged.length > 0) console.log(`already ${result.scope}: ${result.unchanged.join(', ')}`)
    if (result.notFound.length > 0) console.log(`not found: ${result.notFound.join(', ')}`)
    // Every requested id missing is almost certainly a typo; signal it so
    // scripts do not treat a no-op as success.
    if (result.updatedCount === 0 && result.unchanged.length === 0) {
      process.exitCode = 1
      return
    }
    if (result.updated.length > 0) {
      const back = result.scope === 'global' ? 'project' : 'global'
      console.log(`Undo with: mio memory migrate --ids ${result.updated.join(',')} --scope ${back}`)
    }
    return
  }

  const verb = sub === 'restore' ? 'Restored' : 'Archived'
  console.log(`${verb} ${result.archivedCount} record(s) (project=${result.project || 'current'})`)
  if (result.archived.length > 0) console.log(`${sub}d: ${result.archived.join(', ')}`)
  if (result.skipped.length > 0) console.log(`already ${sub}d: ${result.skipped.join(', ')}`)
  if (result.notFound.length > 0) console.log(`not found: ${result.notFound.join(', ')}`)
  if (result.archivedCount === 0) {
    // Nothing changed: either the ids do not exist or they were already in the
    // target state. Either way the caller's intent was not fulfilled, so say so
    // instead of silently exiting 0.
    console.error(`No records ${sub}d. Check the ids, or run: mio memory analyze`)
    process.exitCode = 1
    return
  }
  if (sub === 'archive' && result.archived.length > 0) {
    console.log(`Undo with: mio memory restore --ids ${result.archived.join(',')}`)
  }
}

// The observer auto-claims experience reuse, but an unconfirmed auto_claim
// never counts as `verified` and so never feeds memory ranking or task
// routing. In practice most claims sat unconfirmed forever because confirming
// was only possible through the MCP server.
function cliExperienceStore() {
  return createExperienceStore({
    dataDir: MIO_HOME,
    projectName,
  })
}

function experienceUsage() {
  console.log(`Usage:
  mio experience list                            List reuse records (--status/--target-agent/--project/--limit)
  mio experience confirm --ids a,b               Confirm auto-claimed reuse (bulk supported)
  mio experience reuse --source-agent A --target-agent B --experience-id X   Record a reuse manually

Options:
  --ids a,b,c            Record ids (also accepted as bare positionals; confirm only)
  --status pending|confirmed|verified|auto_claim|agent_report|all   Filter for list (default all)
  --target-agent name    Only records reused by this agent
  --experience-id id     The memory/experience that was reused
  --source-agent name    Agent the experience came from
  --reuse --behavior-changed --outcome-improved   Booleans describing the reuse
  --outcome-improved     Confirm: accept the claim (--no-improved rejects it)
  --by name              Who is confirming (default: cli)
  --notes text           Optional note
  --force                Re-confirm records that are already confirmed
  --project name         Project filter (defaults to current directory name)
  --json                 Machine-readable output
`)
}

function printExperienceList(result) {
  console.log(
    `Experience reuse: ${result.count} shown of ${result.total} (project=${result.project || 'all'}, status=${result.status})`,
  )
  if (result.count === 0) {
    console.log('No reuse records match.')
    return
  }
  result.records.forEach((record, index) => {
    const state = record.confirmed ? 'confirmed' : 'pending'
    const badge = record.reuse && record.behaviorChanged && record.outcomeImproved ? 'verified' : state
    const arrow = `${record.sourceAgent || '?'} -> ${record.targetAgent || '?'}`
    const flags = [
      record.reuse ? 'reused' : null,
      record.behaviorChanged ? 'changed' : null,
      record.outcomeImproved ? 'improved' : null,
    ]
      .filter(Boolean)
      .join(',')
    console.log(`${index + 1}. [${badge}] ${record.experienceId}  ${arrow}`)
    console.log(
      `   ${flags || 'no effect flags'} | ${(record.timestamp || '').slice(0, 19)} | ${record.id}`,
    )
    if (record.notes) console.log(`   note: ${record.notes}`)
  })
  // Only auto_claims are confirmable — experience.confirm rejects anything else.
  const pending = result.records
    .filter((record) => record.source === 'auto_claim' && !record.confirmed)
    .map((record) => record.id)
  if (pending.length > 0) {
    console.log('')
    console.log(
      `${pending.length} unconfirmed auto-claim(s) shown. Unconfirmed auto-claims never count as verified, so they do not affect ranking or routing.`,
    )
    console.log(`Confirm with: mio experience confirm --ids ${pending.join(',')}`)
  }
}

function experienceCommand(args, useJson) {
  const sub = args[1]
  const flags = args.slice(2)

  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    experienceUsage()
    if (!sub) process.exitCode = 1
    return
  }
  if (!['list', 'confirm', 'reuse'].includes(sub)) {
    console.error(`Unknown experience subcommand: ${sub}`)
    experienceUsage()
    process.exitCode = 1
    return
  }

  const store = cliExperienceStore()

  if (sub === 'list') {
    let result
    try {
      result = store.listReuse({
        status: optionValue(flags, '--status'),
        targetAgent: optionValue(flags, '--target-agent'),
        project: optionValue(flags, '--project'),
        limit: parseNumberOption(flags, '--limit'),
      })
    } catch (error) {
      console.error(error.message || error)
      process.exitCode = 1
      return
    }
    if (useJson) return jsonOrText(result, true)
    return printExperienceList(result)
  }

  let result
  try {
    if (sub === 'confirm') {
      const ids = collectIds(flags)
      if (ids.length === 0) {
        console.error('mio experience confirm requires --ids <id,id,...> (or bare ids)')
        process.exitCode = 1
        return
      }
      // Absent = keep whatever the auto-claim recorded; --no-improved rejects it.
      const improved = flagPresent(flags, '--no-improved')
        ? false
        : flagPresent(flags, '--outcome-improved')
          ? true
          : undefined
      result = store.confirmReuse({
        ids,
        outcomeImproved: improved,
        confirmedBy: optionValue(flags, '--by') || 'cli',
        notes: optionValue(flags, '--notes'),
        force: flagPresent(flags, '--force'),
      })
    } else {
      result = store.recordReuse({
        sourceAgent: optionValue(flags, '--source-agent'),
        targetAgent: optionValue(flags, '--target-agent'),
        experienceId: optionValue(flags, '--experience-id'),
        reuse: flagPresent(flags, '--reuse'),
        behaviorChanged: flagPresent(flags, '--behavior-changed'),
        outcomeImproved: flagPresent(flags, '--outcome-improved'),
        project: optionValue(flags, '--project'),
        notes: optionValue(flags, '--notes'),
      })
    }
  } catch (error) {
    console.error(error.message || error)
    process.exitCode = 1
    return
  }

  if (useJson) return jsonOrText(result, true)

  if (sub === 'reuse') {
    console.log(
      `Recorded reuse ${result.evidence.id}: ${result.evidence.sourceAgent} -> ${result.evidence.targetAgent} (${result.evidence.experienceId})`,
    )
    return
  }

  console.log(`Confirmed ${result.confirmedCount} reuse record(s)`)
  if (result.confirmedIds.length > 0) console.log(`confirmed: ${result.confirmedIds.join(', ')}`)
  if (result.rejected.length > 0) {
    console.log(`skipped (not auto_claim): ${result.rejected.join(', ')}`)
  }
  if (result.alreadyConfirmed.length > 0) {
    console.log(`already confirmed: ${result.alreadyConfirmed.join(', ')} (use --force to redo)`)
  }
  if (result.notFound.length > 0) console.log(`not found: ${result.notFound.join(', ')}`)
  if (result.confirmedCount === 0) {
    console.error('Nothing confirmed. Check the ids, or run: mio experience list --status pending')
    process.exitCode = 1
  }
}

// mio.policy.check has always been able to answer "has this action failed
// before?", but only from inside an MCP session -- so in practice nobody asked
// before running the command. This gives it a terminal entry point.
function policyUsage() {
  console.log(`Usage:
  mio policy check "<action>"     Historical risk for an action, from trace + memory evidence

Options:
  --project name     Project filter (defaults to current directory name)
  --json             Machine-readable output (same shape as mio.policy.check)

Examples:
  mio policy check "npm publish"
  mio policy check "git reset --hard" --project akemi-mio

Reading the result:
  unknown   no history for this action; treat as normal risk
  low       history exists and is mostly clean
  moderate  add verification before proceeding
  low/high  driven by the failure share of matching traces`)
}

function printPolicyCheck(result) {
  const level = result.riskLevel.toUpperCase()
  console.log(`Policy check: "${result.action}" (project=${result.project || 'all'})`)
  console.log(`risk: ${level}${result.risk === null ? '' : ` (${result.risk})`}`)
  if (result.total === 0) {
    console.log('evidence: no matching traces')
  } else {
    console.log(`evidence: ${result.total} matching trace(s), ${result.failures} failure(s)`)
    const outcomes = Object.entries(result.outcomeCounts)
    if (outcomes.length > 0) {
      console.log(`outcomes: ${outcomes.map(([k, v]) => `${k}=${v}`).join(', ')}`)
    }
  }

  // A risk level derived from tokens that match most of the corpus looks
  // authoritative but means nothing. Say so instead of letting it stand.
  const diag = result.diagnostics
  if (diag && diag.lowSignal) {
    console.log('')
    console.log(
      `WARNING: low-signal match. Every token in this action (${diag.genericTokens.join(', ')}) ` +
        'appears in most traces regardless of subject, so the level above is not meaningful.',
    )
    console.log('Try a more specific action, e.g. mio policy check "npm publish".')
  } else if (diag && diag.lowSample) {
    console.log('')
    console.log(
      `NOTE: only ${diag.sampleSize} matching trace(s); treat the level above as a weak signal.`,
    )
  }

  console.log(`\n${result.suggestion}`)

  if (result.failureExamples.length > 0) {
    console.log('\nRecent failures:')
    for (const example of result.failureExamples) {
      const when = example.timestamp ? example.timestamp.slice(0, 19).replace('T', ' ') : 'unknown time'
      console.log(`- [${example.outcome || 'failure'}] ${when}`)
      console.log(`    ${example.summary}`)
      if (example.trace_id) console.log(`    trace: ${example.trace_id}`)
    }
  }

  if (result.guidance.level !== 'none') {
    console.log(`\nGuidance (${result.guidance.level}): ${result.guidance.rationale}`)
    if (result.guidance.avoid.length > 0) {
      console.log('avoid repeating:')
      for (const item of result.guidance.avoid) console.log(`- ${item}`)
    }
    for (const step of result.guidance.verificationSteps) console.log(`- ${step}`)
  }

  if (result.related_memories.length > 0) {
    console.log('\nRelated memory:')
    for (const record of result.related_memories) {
      const badge = record.evidence ? ` [verified x${record.evidence.reuseCount}]` : ''
      console.log(`- ${record.id}${badge} ${String(record.content).replace(/\s+/g, ' ').slice(0, 110)}`)
    }
  }
}

function policyCommand(args, useJson) {
  const sub = args[1]

  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    policyUsage()
    if (!sub) process.exitCode = 1
    return
  }
  if (sub !== 'check') {
    console.error(`Unknown policy subcommand: ${sub}`)
    policyUsage()
    process.exitCode = 1
    return
  }

  const flags = args.slice(2)
  // The action is a positional, and may be quoted as one argument or passed as
  // several words (`mio policy check npm publish`). Only flags this command
  // actually understands are treated as options -- anything else, including
  // `--hard` in `git reset --hard`, belongs to the action being described.
  const POLICY_KNOWN_FLAGS = new Set(['--project', '--json'])
  const actionParts = []
  for (let i = 0; i < flags.length; i += 1) {
    const token = flags[i]
    if (POLICY_KNOWN_FLAGS.has(token)) continue
    if (i > 0 && POLICY_KNOWN_FLAGS.has(flags[i - 1])) continue
    actionParts.push(token)
  }
  const action = actionParts.join(' ').trim()

  if (!action) {
    console.error('mio policy check requires an action, e.g. mio policy check "npm publish"')
    process.exitCode = 1
    return
  }

  let result
  try {
    result = cliPolicyStore().policyCheck({
      action,
      project: optionValue(flags, '--project'),
    })
  } catch (error) {
    console.error(error.message || error)
    process.exitCode = 1
    return
  }

  if (useJson) return jsonOrText(result, true)
  printPolicyCheck(result)
}

// ═════════════════════════════════════════════════════════════
// mio insight — terminal entry point for mio.insight.*
//
// The insight engine (self-observation) shipped MCP-only: an agent could read
// its own insights, but there was no way to see them from a terminal. These
// commands delegate to the same shared store as the MCP tools, so the two
// cannot disagree.
//
// `generate` is deliberately not exposed. It needs an LLM and the CLI has no
// LLM wiring; the same call was made for creativity generate/ferment.
// ═════════════════════════════════════════════════════════════
function cliInsightStore() {
  return createInsightStore({ dataDir: MIO_HOME })
}

function insightUsage() {
  console.log(`Usage:
  mio insight status                    Insight counts: total, reported, unreported, high-value
  mio insight list                      List insights
  mio insight mark-reported --ids a,b   Mark insights as reported (acknowledged)

Options:
  --unreported       Only unreported insights (list)
  --min-score N      Minimum score (list)
  --detector name    Filter by detector (list)
  --limit N          Max insights (list)
  --ids a,b          Comma-separated insight ids (mark-reported)
  --json             Machine-readable output (same shape as mio.insight.*)

The insight engine is an optional package (@akemi-mio/insight). If it is not
installed these commands say so, rather than reporting a misleading empty list.`)
}

function printInsightStatus(result) {
  console.log('Insight engine')
  console.log(`  total:      ${result.total}`)
  console.log(`  reported:   ${result.reported}`)
  console.log(`  unreported: ${result.unreported}`)
  console.log(`  high-value: ${result.highValue}`)
  if (result.unreported > 0) {
    console.log('\nUnreported insights are waiting: mio insight list --unreported')
  }
}

function printInsightList(insights) {
  if (insights.length === 0) {
    console.log('No insights match.')
    return
  }
  for (const item of insights) {
    const score = typeof item.score === 'number' ? item.score.toFixed(2) : 'n/a'
    const state = item.reported ? 'reported' : 'unreported'
    const detector = item.detector ? `, ${item.detector}` : ''
    console.log(`- [${score}] ${item.id || '(no id)'} (${state}${detector})`)
    const text = String(item.content || item.summary || item.title || '')
    if (text) console.log(`    ${text.replace(/\s+/g, ' ').slice(0, 140)}`)
  }
  console.log(`\n${insights.length} insight(s)`)
}

function insightCommand(args, useJson) {
  const sub = args[1]
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    insightUsage()
    if (!sub) process.exitCode = 1
    return
  }
  if (!['status', 'list', 'mark-reported'].includes(sub)) {
    console.error(`Unknown insight subcommand: ${sub}`)
    insightUsage()
    process.exitCode = 1
    return
  }

  const flags = args.slice(2)
  const store = cliInsightStore()
  try {
    if (sub === 'status') {
      const result = store.status()
      if (useJson) return jsonOrText(result, true)
      return printInsightStatus(result)
    }
    if (sub === 'list') {
      const result = store.list({
        unreported: flagPresent(flags, '--unreported'),
        minScore: parseNumberOption(flags, '--min-score'),
        detector: optionValue(flags, '--detector'),
        limit: parseNumberOption(flags, '--limit'),
      })
      if (useJson) return jsonOrText(result, true)
      return printInsightList(result)
    }
    const ids = splitTagsOption(flags, '--ids')
    if (ids.length === 0) {
      console.error('mio insight mark-reported requires --ids a,b')
      process.exitCode = 1
      return
    }
    const result = store.markReported({ ids })
    if (useJson) return jsonOrText(result, true)
    console.log(`Marked ${result.marked} insight(s) as reported.`)
  } catch (error) {
    console.error(error.message || error)
    process.exitCode = 1
  }
}

// ═════════════════════════════════════════════════════════════
// mio observer — terminal entry point for the observer research pipeline
// (mio.observer.*). Not to be confused with `mio observe`, which is the
// WorkBuddy transcript daemon.
//
// The read-only views plus the two driver commands (collect, ferment) are
// exposed. An earlier version of this comment claimed collect/ferment "belong
// to the daemon" -- they do not: observe/observer.js only tails WorkBuddy
// transcripts and never calls either. Until they got a terminal entry point the
// only way to run a collection was from inside an MCP session.
//
// Base directory defaults to <cwd>/.local/observer -- the MCP server's default
// -- because the pipeline is project-local by design. --base-dir overrides it.
// ═════════════════════════════════════════════════════════════
function cliObserverStore() {
  return createObserverStore({})
}

function observerUsage() {
  console.log(`Usage:
  mio observer status        Pipeline stage counts (observations/trends/topics/...)
  mio observer world-model   Entities, events, trends and narratives
  mio observer trends        Recent trend reports
  mio observer research      Research reports
  mio observer insights      Observer-generated insight articles
  mio observer essays        Published essays
  mio observer dag           Daily summaries for the last N days
  mio observer ingest        Record a trace event (tool_call/error/retry/task_outcome)
                             --trace-id <id> --event-type <type> [--payload '<json>'] [--outcome]
                             [--agent] [--host] [--project] (writes immediately, like mio remember)
  mio observer subscribe     Subscribe to events: --event-types a,b [--topic T] [--ttl-days N]
                             (--yes required to apply; previews by default)
  mio observer digest        New events since the last digest (--limit/--project/--event-types)
                             NOTE: advances the cursor, so a second run returns only newer events
  mio observer collect       Fetch from the configured sources (--sources a,b [--keywords k1,k2])
                             [--limit N]  (needs @akemi-mio/observer; hits the network)
  mio observer ferment       Run the fermentation engine over recent observations
                             (--session morning|afternoon|night; needs @akemi-mio/observer)

Options:
  --base-dir DIR     Observer data directory (default: <cwd>/.local/observer)
  --date YYYY-MM-DD  A single trend report (trends)
  --type name        Essay type (default: published)
  --days N           Days of history (dag, default 7)
  --limit N          Max items
  --sources a,b      Sources to collect from (default: all configured)
  --keywords a,b     Keyword filter, OR matched (collect)
  --session label    Fermentation session (default: afternoon)
  --json             Machine-readable output (same shape as mio.observer.*)`)
}

// Pipeline items are free-form JSON written by different stages, so pull a
// human label from whichever well-known field happens to be present.
function observerItemLabel(item) {
  if (item === null || typeof item !== 'object') return String(item)
  for (const key of ['title', 'name', 'topic', 'headline', 'summary', 'text', 'id', 'date']) {
    const value = item[key]
    if (typeof value === 'string' && value.trim()) return value.trim().replace(/\s+/g, ' ').slice(0, 120)
  }
  return JSON.stringify(item).slice(0, 120)
}

function printObserverList(kind, items) {
  if (items.length === 0) {
    console.log(`No ${kind} found. (Run the observer pipeline, or check --base-dir.)`)
    return
  }
  for (const item of items) console.log(`- ${observerItemLabel(item)}`)
  console.log(`\n${items.length} ${kind}`)
}

function printObserverStatus(status) {
  console.log('Observer pipeline (file counts per stage)')
  let total = 0
  for (const [stage, count] of Object.entries(status)) {
    total += count
    console.log(`  ${stage.padEnd(14)} ${count}`)
  }
  console.log(`\n  ${'total'.padEnd(14)} ${total}`)
  if (total === 0) {
    console.log('\nNo pipeline data yet. Nothing has been collected into this directory.')
  }
}

function printObserverWorldModel(model) {
  const sections = ['entities', 'events', 'trends', 'narratives']
  console.log('World model')
  for (const key of sections) {
    const value = model[key]
    const count = Array.isArray(value) ? value.length : Object.keys(value || {}).length
    console.log(`  ${key.padEnd(12)} ${count}`)
  }
  if (sections.every((key) => (Array.isArray(model[key]) ? model[key].length : 0) === 0)) {
    console.log('\nWorld model is empty.')
  }
}

function printObserverEssays(essays) {
  if (essays.length === 0) {
    console.log('No essays found.')
    return
  }
  for (const essay of essays) {
    console.log(`- ${essay.file} (${essay.type}, ${String(essay.created).slice(0, 10)})`)
    const firstLine = String(essay.content || '').split('\n').find((l) => l.trim()) || ''
    if (firstLine) console.log(`    ${firstLine.replace(/\s+/g, ' ').slice(0, 120)}`)
  }
  console.log(`\n${essays.length} essay(s)`)
}

function printObserverDag(result, days) {
  if (result.summaryCount === 0) {
    console.log(`No daily summaries found in the last ${days || 7} day(s).`)
    return
  }
  for (const day of result.summaries) {
    console.log(`- ${day.date}: ${day.summaries.length} summary(ies)`)
  }
  console.log(`\n${result.summaryCount} summary(ies) across ${result.summaries.length} day(s)`)
}

function cliSubscriptionStore() {
  return createSubscriptionStore({
    dataDir: MIO_HOME,
    projectName,
    agentId: () => 'cli',
  })
}

// Records an arbitrary trace event (tool_call / error / retry / task_outcome).
// Unlike `mio task record-outcome`, which is specific to task outcomes, this is
// the general-purpose half -- and the one AGENTS.md asks agents to call.
//
// It appends rather than modifies, so like `mio remember` it writes straight
// away instead of previewing: there is nothing to destroy. Missing arguments are
// still rejected before anything is written.
function observerIngestCommand(args, useJson) {
  const flags = args.slice(2)
  const traceId = optionValue(flags, '--trace-id')
  const eventType = optionValue(flags, '--event-type')
  if (!traceId || !eventType) {
    console.error('mio observer ingest requires --trace-id <id> and --event-type <type>')
    console.error('Example: mio observer ingest --trace-id t1 --event-type tool_call --payload \'{"tool":"Bash"}\'')
    process.exitCode = 1
    return
  }

  let payload = {}
  const rawPayload = optionValue(flags, '--payload')
  if (rawPayload) {
    try {
      payload = JSON.parse(rawPayload)
    } catch (error) {
      console.error(`--payload must be valid JSON: ${error.message}`)
      process.exitCode = 1
      return
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      console.error('--payload must be a JSON object')
      process.exitCode = 1
      return
    }
  }

  let result
  try {
    result = cliTaskStore().ingestObservation({
      trace_id: traceId,
      event_type: eventType,
      outcome: optionValue(flags, '--outcome'),
      payload,
      agent: optionValue(flags, '--agent'),
      host: optionValue(flags, '--host'),
      project: optionValue(flags, '--project'),
    })
  } catch (error) {
    console.error(error.message || error)
    process.exitCode = 1
    return
  }

  if (useJson) return jsonOrText(result, true)
  console.log(`Ingested ${result.event.event_type} (trace=${result.event.trace_id})`)
  console.log(`  agent=${result.event.agent} project=${result.event.project} host=${result.event.host}`)
  if (result.autoClaims && result.autoClaims.length > 0) {
    console.log(`  auto-claims: ${result.autoClaims.length}`)
  }
}

// Subscribe creates or renews a subscription, so it previews like every other
// mutating command (`mio agents register`, `mio memory archive`): exit 1 and
// nothing written without --yes.
function observerSubscribeCommand(args, useJson) {
  const flags = args.slice(2)
  const project = optionValue(flags, '--project') || projectName()
  const eventTypes = splitTagsOption(flags, '--event-types')
  const topic = optionValue(flags, '--topic') || ''
  const ttlDays = optionValue(flags, '--ttl-days')

  if (!flagPresent(flags, '--yes')) {
    const store = cliSubscriptionStore()
    const existing = readJsonl(store.subscriptionPath).find((subscription) => {
      return (
        subscription &&
        subscription.agent === 'cli' &&
        subscribeKey(subscription.agent, subscription.project, subscription.eventTypes || [], subscription.topic || '') ===
          subscribeKey('cli', project, eventTypes, topic)
      )
    })
    if (useJson) {
      jsonOrText(
        {
          preview: true,
          applied: false,
          project,
          eventTypes,
          topic: topic || null,
          ttlDays: ttlDays ? Number(ttlDays) : null,
          willCreate: !existing,
          hint: 'Re-run with --yes to apply.',
        },
        true,
      )
    } else {
      console.log(`Subscribe preview: project=${project}`)
      console.log(`  event types: ${eventTypes.length > 0 ? eventTypes.join(', ') : '(all)'}`)
      if (topic) console.log(`  topic: ${topic}`)
      console.log(`  ${existing ? 'will renew the existing subscription' : 'will create a new subscription'}`)
      console.log('Re-run with --yes to apply.')
    }
    process.exitCode = 1
    return
  }

  let result
  try {
    result = cliSubscriptionStore().subscribe({ project, eventTypes, topic, ttlDays })
  } catch (error) {
    console.error(error.message || error)
    process.exitCode = 1
    return
  }
  if (useJson) return jsonOrText(result, true)
  console.log(`Subscribed (project=${result.project})`)
  console.log(`  id=${result.subscription.id} expires=${result.subscription.expiresAt}`)
  console.log(`  event types: ${(result.subscription.eventTypes || []).join(', ') || '(all)'}`)
}

// The digest is cursor-based: it returns only events newer than the last one it
// delivered, and ADVANCES that cursor. Running it twice therefore gives different
// results -- so it cannot be previewed, and the output says so rather than
// leaving that surprise for the user to discover.
function observerDigestCommand(args, useJson) {
  const flags = args.slice(2)
  let result
  try {
    result = cliSubscriptionStore().digest({
      project: optionValue(flags, '--project'),
      limit: optionValue(flags, '--limit'),
      eventTypes: splitTagsOption(flags, '--event-types'),
    })
  } catch (error) {
    console.error(error.message || error)
    process.exitCode = 1
    return
  }
  if (useJson) return jsonOrText(result, true)
  console.log(`Observer digest: ${result.count} event(s) (project=${result.project}, agent=${result.agent})`)
  console.log(`  subscriptions: ${result.subscriptionCount} active, ${result.matchedSubscriptions.length} matched`)
  for (const event of result.events) {
    console.log(`- ${event.event_type}${event.outcome ? ` (${event.outcome})` : ''} trace=${event.trace_id || '-'}`)
  }
  if (result.count === 0) {
    console.log('Nothing new since the last digest.')
  }
  console.log('Note: this advances the cursor; the next digest returns only newer events.')
}

// collect drives the upstream collectors, so it needs @akemi-mio/observer and
// hits the network. Unlike the mutating commands it is not previewed: it only
// appends observations, and a preview would have to fetch everything twice.
function printObserverCollect(result) {
  console.log(`Collected ${result.collected} observation(s)`)
  if (result.collected === 0) {
    console.log('Nothing came back. Check the source names and network access.')
    return
  }
  const perSource = new Map()
  for (const item of result.observations) {
    const key = item.source || '(unknown source)'
    const bucket = perSource.get(key) || { ok: 0, errors: [] }
    if (item.error) bucket.errors.push(item.error)
    else bucket.ok += 1
    perSource.set(key, bucket)
  }
  for (const [source, bucket] of perSource) {
    const suffix = bucket.errors.length > 0 ? ` (errors: ${bucket.errors.join('; ')})` : ''
    console.log(`  ${source}: ${bucket.ok}${suffix}`)
  }
}

async function observerCollectCommand(args, useJson) {
  const flags = args.slice(2)
  const base = { baseDir: optionValue(flags, '--base-dir') }
  // splitTagsOption returns [] for an absent flag, and [] is truthy -- passing
  // it through would mean "collect from zero sources" instead of "all sources".
  const sources = splitTagsOption(flags, '--sources')
  const keywords = splitTagsOption(flags, '--keywords')
  let result
  try {
    result = await cliObserverStore().collect({
      ...base,
      sources: sources.length > 0 ? sources : undefined,
      keywords: keywords.length > 0 ? keywords : undefined,
      limit: parseNumberOption(flags, '--limit'),
    })
  } catch (error) {
    console.error(error.message || error)
    process.exitCode = 1
    return
  }
  if (useJson) return jsonOrText(result, true)
  printObserverCollect(result)
}

// ferment is likewise a driver command: it may write an essay when a cluster
// clears the writing threshold, which is why it is not part of the read-only
// views even though it mostly reads.
function printObserverFerment(result, session) {
  if (result.error) {
    console.log(`Fermentation failed: ${result.error}`)
    process.exitCode = 1
    return
  }
  const clusters = Array.isArray(result.clusters) ? result.clusters : []
  console.log(`Fermentation (session=${session}): ${clusters.length} cluster(s)`)
  for (const cluster of clusters) {
    const strength = typeof cluster.strength === 'number' ? cluster.strength.toFixed(2) : 'n/a'
    const words = Array.isArray(cluster.associations) ? cluster.associations.join(', ') : ''
    console.log(`- [${strength}] ${cluster.theme || '(untitled)'}${words ? ` — ${words}` : ''}`)
  }
  if (clusters.length === 0) {
    console.log('No recurring themes found in the recent observations.')
  }
}

async function observerFermentCommand(args, useJson) {
  const flags = args.slice(2)
  const session = optionValue(flags, '--session') || 'afternoon'
  const base = { baseDir: optionValue(flags, '--base-dir') }
  let result
  try {
    result = await cliObserverStore().ferment({ ...base, session })
  } catch (error) {
    console.error(error.message || error)
    process.exitCode = 1
    return
  }
  if (useJson) return jsonOrText(result, true)
  printObserverFerment(result, session)
}

function observerCommand(args, useJson) {
  const sub = args[1]
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    observerUsage()
    if (!sub) process.exitCode = 1
    return
  }
  if (sub === 'ingest') return observerIngestCommand(args, useJson)
  if (sub === 'subscribe') return observerSubscribeCommand(args, useJson)
  if (sub === 'digest') return observerDigestCommand(args, useJson)
  // Driver commands return promises (the upstream engine is async), so they are
  // returned rather than called -- main() is async and awaits them.
  if (sub === 'collect') return observerCollectCommand(args, useJson)
  if (sub === 'ferment') return observerFermentCommand(args, useJson)

  if (!['status', 'world-model', 'trends', 'research', 'insights', 'essays', 'dag'].includes(sub)) {
    console.error(`Unknown observer subcommand: ${sub}`)
    observerUsage()
    process.exitCode = 1
    return
  }

  const flags = args.slice(2)
  const store = cliObserverStore()
  const base = { baseDir: optionValue(flags, '--base-dir') }
  try {
    if (sub === 'status') {
      const result = store.status(base)
      if (useJson) return jsonOrText(result, true)
      return printObserverStatus(result)
    }
    if (sub === 'world-model') {
      const result = store.worldModel(base)
      if (useJson) return jsonOrText(result, true)
      return printObserverWorldModel(result)
    }
    if (sub === 'trends') {
      const result = store.trends({ ...base, date: optionValue(flags, '--date'), limit: parseNumberOption(flags, '--limit') })
      if (useJson) return jsonOrText(result, true)
      return printObserverList('trend report(s)', result)
    }
    if (sub === 'research') {
      const result = store.research({ ...base, limit: parseNumberOption(flags, '--limit') })
      if (useJson) return jsonOrText(result, true)
      return printObserverList('research report(s)', result)
    }
    if (sub === 'insights') {
      const result = store.insights({ ...base, limit: parseNumberOption(flags, '--limit') })
      if (useJson) return jsonOrText(result, true)
      return printObserverList('insight(s)', result)
    }
    if (sub === 'essays') {
      const result = store.essays({ ...base, type: optionValue(flags, '--type'), limit: parseNumberOption(flags, '--limit') })
      if (useJson) return jsonOrText(result, true)
      return printObserverEssays(result)
    }
    const days = parseNumberOption(flags, '--days')
    const result = store.dag({ ...base, days })
    if (useJson) return jsonOrText(result, true)
    return printObserverDag(result, days)
  } catch (error) {
    console.error(error.message || error)
    process.exitCode = 1
  }
}

function creativityUsage() {
  console.log(`Usage:
  mio creativity status              Show hypothesis counts and recent top ideas
  mio creativity list                List hypotheses (--status active|validated|rejected|draft, --limit N)

  mio creativity generate        Generate hypotheses by combining sources (needs 2+ --source, calls an LLM)
  mio creativity ferment         Review/refine active hypotheses (calls an LLM)

Options:
  --status name      Filter list by status
  --limit N          Max results for list / ferment (default 20 / 5)
  --source "name|content"   A concept source for generate; repeat 2+ times
  --strategy explore|signal|stable   Generation strategy (auto-selected if omitted)
  --json             Machine-readable output (same shape as the mio.creativity.* tools)

Examples:
  mio creativity status
  mio creativity list --status rejected --limit 10
  mio creativity generate --source "auth|token rotation" --source "cache|write-through"

generate/ferment call an LLM using the shared client. Configure it with
LLM_API_URL / LLM_KEY / LLM_CHAT_MODEL (the same environment the MCP server
reads). A local Ollama works:
  LLM_API_URL=http://localhost:11434/v1/chat/completions`)
}

function printCreativityStatus(result) {
  console.log('Creativity engine:')
  console.log(`  hypotheses: ${result.hypotheses}  combos: ${result.combos}  experiments: ${result.experiments}`)
  console.log(`  active: ${result.active}  validated: ${result.validated}  rejected: ${result.rejected}`)
  if (result.recentIdeas.length === 0) {
    console.log('No hypotheses yet.')
    return
  }
  console.log('\nRecent top ideas:')
  for (const idea of result.recentIdeas) {
    console.log(`- ${idea.title}  (novelty=${idea.novelty} feasibility=${idea.feasibility} impact=${idea.impact} score=${idea.score})`)
    console.log(`    ${idea.id}`)
  }
}

function printCreativityList(items) {
  if (items.length === 0) {
    console.log('No hypotheses match.')
    return
  }
  console.log(`Hypotheses: ${items.length} shown`)
  items.forEach((h, index) => {
    const when = h.createdAt ? new Date(h.createdAt).toISOString().slice(0, 19).replace('T', ' ') : ''
    const labels = Array.isArray(h.sourceLabels) && h.sourceLabels.length > 0 ? h.sourceLabels.join(' + ') : '—'
    console.log(`${index + 1}. [${h.status}] ${h.title}  (N=${h.novelty} F=${h.feasibility} I=${h.impact} score=${h.score})`)
    console.log(`   ${labels} | ${when} | ${h.id}`)
    if (h.fermentCount) console.log(`   fermented ${h.fermentCount}x`)
  })
}

// Parses repeated `--source "name|content"` into the shape CreativityEngine
// expects. At least two are required: the engine pairs up sources, so one
// source can never produce a combination.
function parseSources(flags) {
  const sources = []
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i] !== '--source') continue
    const raw = flags[i + 1]
    if (!raw) continue
    const sep = raw.indexOf('|')
    if (sep === -1) {
      sources.push({ name: raw, content: raw })
    } else {
      sources.push({
        name: raw.slice(0, sep).trim(),
        content: raw.slice(sep + 1).trim(),
      })
    }
  }
  return sources
}

function warnIfLlmUnconfigured() {
  if (isLlmConfigured()) return
  const { apiUrl, model } = llmConfig()
  console.log(`Note: no LLM_API_URL / LLM_KEY set, so this will call the default endpoint (${model} @ ${apiUrl}).`)
  console.log('Set LLM_API_URL (e.g. http://localhost:11434/v1/chat/completions for a local Ollama) to point elsewhere.')
}

function creativityGenerateCommand(args, useJson) {
  const flags = args.slice(2)
  const sources = parseSources(flags)
  if (sources.length < 2) {
    console.error('mio creativity generate requires at least two --source "name|content" arguments')
    console.error('Example: mio creativity generate --source "auth|token rotation" --source "cache|write-through cache"')
    process.exitCode = 1
    return
  }
  const strategy = optionValue(flags, '--strategy')

  if (!useJson) warnIfLlmUnconfigured()

  let result
  try {
    result = cliCreativityEngine().generate(sources, strategy)
  } catch (error) {
    console.error(error.message || error)
    process.exitCode = 1
    return
  }
  // generate is async in the engine.
  return Promise.resolve(result).then((resolved) => {
    if (useJson) return jsonOrText(resolved, true)
    if (resolved.reason) {
      console.log(`No hypotheses generated: ${resolved.reason}`)
      return
    }
    console.log(`Generated ${resolved.ideas.length} hypothesis/hypotheses (strategy=${resolved.strategy})`)
    resolved.ideas.forEach((idea, index) => {
      console.log(`${index + 1}. [${idea.status}] ${idea.title}`)
      console.log(`   novelty=${idea.novelty} feasibility=${idea.feasibility} impact=${idea.impact} | ${idea.id}`)
      if (idea.rejectionReason) console.log(`   rejected: ${idea.rejectionReason}`)
    })
  })
}

function creativityFermentCommand(args, useJson) {
  const flags = args.slice(2)
  const limit = parseNumberOption(flags, '--limit')

  if (!useJson) warnIfLlmUnconfigured()

  let result
  try {
    result = cliCreativityEngine().ferment(limit)
  } catch (error) {
    console.error(error.message || error)
    process.exitCode = 1
    return
  }
  return Promise.resolve(result).then((resolved) => {
    if (useJson) return jsonOrText(resolved, true)
    if (resolved.fermented === 0) {
      console.log(`Nothing fermented: ${resolved.reason || 'no eligible hypotheses'}`)
      return
    }
    console.log(`Fermented ${resolved.fermented} hypothesis/hypotheses`)
    for (const r of resolved.results || []) {
      console.log(`- ${r.title || r.id}: ${r.verdict || 'updated'}${r.reason ? ` — ${r.reason}` : ''}`)
    }
  })
}

function creativityCommand(args, useJson) {
  const sub = args[1]

  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    creativityUsage()
    if (!sub) process.exitCode = 1
    return
  }
  if (sub === 'generate') return creativityGenerateCommand(args, useJson)
  if (sub === 'ferment') return creativityFermentCommand(args, useJson)

  if (!['status', 'list'].includes(sub)) {
    console.error(`Unknown creativity subcommand: ${sub}`)
    creativityUsage()
    process.exitCode = 1
    return
  }

  const flags = args.slice(2)
  const engine = cliCreativityEngine()

  let result
  try {
    if (sub === 'status') {
      result = engine.status()
    } else {
      result = engine.list({
        status: optionValue(flags, '--status'),
        limit: parseNumberOption(flags, '--limit'),
      })
    }
  } catch (error) {
    console.error(error.message || error)
    process.exitCode = 1
    return
  }

  if (useJson) return jsonOrText(result, true)
  if (sub === 'status') printCreativityStatus(result)
  else printCreativityList(result)
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

function agentsCommand(args, useJson) {
  const sub = args[1]

  // `mio agents` with no subcommand lists installed host adapters (config) —
  // distinct from the observed-agent telemetry below.
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    const config = readConfig()
    const agents = config.agents || {}
    if (useJson) {
      jsonOrText(agents, true)
      return
    }
    const names = Object.keys(agents)
    if (names.length === 0) {
      console.log('No agents installed. Run `mio agents list` for observed agents, or `mio install <host>` to add one.')
      return
    }
    for (const name of names) {
      console.log(`${name}\t${agents[name].installedAt || ''}`)
    }
    return
  }

  if (sub === 'list') {
    const flags = args.slice(2)
    let result
    try {
      result = cliAgentStore().listAgents({ project: optionValue(flags, '--project') })
    } catch (error) {
      console.error(error.message || error)
      process.exitCode = 1
      return
    }
    if (useJson) return jsonOrText(result, true)
    return printAgentList(result)
  }

  if (sub === 'report') {
    const flags = args.slice(2)
    let result
    try {
      result = cliAgentStore().reportAgent({
        agentId: optionValue(flags, '--agent'),
        project: optionValue(flags, '--project'),
      })
    } catch (error) {
      console.error(error.message || error)
      process.exitCode = 1
      return
    }
    if (useJson) return jsonOrText(result, true)
    return printAgentReport(result)
  }

  if (sub === 'register') {
    const flags = args.slice(2)
    const agentId = optionValue(flags, '--agent-id')
    if (!agentId) {
      console.error('mio agents register requires --agent-id <id>')
      process.exitCode = 1
      return
    }
    const project = optionValue(flags, '--project') || projectName()
    const hostType = optionValue(flags, '--host-type') || 'mcp'
    const capabilities = splitTagsOption(flags, '--capabilities')

    // Preview by default, like `mio memory archive`: nothing is written
    // without --yes, in --json mode either.
    if (!flagPresent(flags, '--yes')) {
      const existing = cliAgentStore()
        .listAgents({ project })
        .agents.find((a) => a.agentId === agentId)
      if (useJson) {
        jsonOrText(
          {
            preview: true,
            applied: false,
            agentId,
            project,
            hostType,
            capabilities,
            willCreate: !existing,
            existingSessionCount: existing ? existing.sessionCount || 0 : null,
            hint: 'Re-run with --yes to apply.',
          },
          true,
        )
      } else {
        console.log(`Register preview: ${agentId} (project=${project}, host=${hostType})`)
        if (existing) {
          const next = (existing.sessionCount || 0) + 1
          console.log(`  will update existing agent (sessionCount ${existing.sessionCount || 0} -> ${next})`)
        } else {
          console.log('  will create a new agent record')
        }
        if (capabilities.length > 0) console.log(`  capabilities: ${capabilities.join(', ')}`)
        console.log('Re-run with --yes to apply.')
      }
      process.exitCode = 1
      return
    }

    let result
    try {
      result = cliAgentStore().registerAgent({ agentId, project, hostType, capabilities })
    } catch (error) {
      console.error(error.message || error)
      process.exitCode = 1
      return
    }
    if (useJson) return jsonOrText(result, true)
    console.log(`Registered ${result.agentId} (project=${project})`)
    console.log(
      `  ${result.registered ? 'created' : `updated (session ${result.sessionCount})`} | host=${result.hostType}`,
    )
    if (result.capabilities && result.capabilities.length > 0) {
      console.log(`  capabilities: ${result.capabilities.join(', ')}`)
    }
    return
  }

  console.error(`Unknown agents subcommand: ${sub}`)
  console.error('Usage: mio agents [list|register|report] [--agent X] [--project Y]')
  process.exitCode = 1
}

function printAgentList(result) {
  console.log(`Observed agents: ${result.count} shown${result.project ? ` (project=${result.project})` : ''}`)
  if (result.count === 0) {
    console.log('No observed agents match.')
    return
  }
  for (const a of result.agents) {
    const caps = Array.isArray(a.capabilities) && a.capabilities.length > 0 ? ` [${a.capabilities.join(', ')}]` : ''
    console.log(`${a.agentId} (${a.hostType})${caps}  project=${a.project || '-'}`)
    console.log(
      `   sessions=${a.sessionCount || 0} tasks=${a.taskCount} success=${a.successCount} failure=${a.failureCount} | ${a.id}`,
    )
  }
}

function printAgentReport(result) {
  console.log(`Agent report${result.project ? ` (project=${result.project})` : ''}: ${result.count} agent(s)`)
  if (result.count === 0) {
    console.log('No observed agents match.')
    return
  }
  for (const r of result.reports) {
    const o = r.taskOutcomes
    const when = r.lastSeenAt ? r.lastSeenAt.slice(0, 19).replace('T', ' ') : 'unknown'
    console.log(`${r.agentId} (${r.hostType})  ${r.active ? 'active' : 'idle'}`)
    console.log(
      `   tasks: ${o.total} total, ${o.success} success, ${o.failure} failure (${o.successRate}% success)`,
    )
    console.log(`   memories: ${r.memories}  experience reuses: ${r.experienceReuses.total} (verified ${r.experienceReuses.verified})`)
    console.log(`   last seen: ${when} | sessions=${r.sessionCount}`)
  }
}

function phase0Command(args, useJson) {
  const sub = args[1]
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(`Usage:
  mio phase0 report              Show the Phase 0 validation report (memory/trace/reuse evidence)
  mio phase0 report --format markdown   Render as Markdown
  mio phase0 report --json      Machine-readable report (same shape as mio.phase0.report)

Options:
  --project name     Project filter (defaults to the current directory name)
  --format markdown  Human-readable Markdown instead of JSON`)
    if (!sub) process.exitCode = 1
    return
  }
  if (sub !== 'report') {
    console.error(`Unknown phase0 subcommand: ${sub}`)
    process.exitCode = 1
    return
  }

  const flags = args.slice(2)
  const format = (optionValue(flags, '--format') || '').toLowerCase()
  let report
  try {
    report = loadPhase0(MIO_HOME, optionValue(flags, '--project') || projectName())
  } catch (error) {
    console.error(error.message || error)
    process.exitCode = 1
    return
  }

  if (useJson) {
    return jsonOrText({ project: optionValue(flags, '--project') || projectName(), ...report }, true)
  }
  // Markdown is the human-readable form; the MCP tool exposes the same renderer
  // via --format markdown, so text and MCP output cannot diverge.
  console.log(renderPhase0Markdown(report))
}

function hostCommand(args, useJson) {
  const sub = args[1]
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(`Usage:
  mio host capabilities       Show what each host supports and whether it is installed
  mio host capabilities --json   Machine-readable (same shape as mio.host.capabilities)

Notes:
  "installed" is probed live from each adapter, so it reflects this machine right
  now -- unlike \`mio install <host>\`, which only records intent in config.json.`)
    if (!sub) process.exitCode = 1
    return
  }
  if (sub !== 'capabilities') {
    console.error(`Unknown host subcommand: ${sub}`)
    process.exitCode = 1
    return
  }

  const result = listHostCapabilities()
  if (useJson) return jsonOrText(result, true)

  console.log(`Host capabilities: ${result.hosts.length} host(s)`)
  for (const host of result.hosts) {
    const mark = host.installed ? 'installed' : 'not installed'
    console.log(`  ${host.name.padEnd(10)} ${mark}`)
    console.log(`             ${host.capabilities.join(', ')}`)
  }
}

function recordOutcomeCommand(args, useJson) {
  const flags = args.slice(2)
  const outcome = String(optionValue(flags, '--outcome') || '').toLowerCase()
  if (!['success', 'failure', 'aborted'].includes(outcome)) {
    console.error('mio task record-outcome requires --outcome success|failure|aborted')
    process.exitCode = 1
    return
  }
  const project = optionValue(flags, '--project') || projectName()
  // Mirrors the store default so the preview reports the same agent that the
  // applied run would use.
  const agentId = optionValue(flags, '--agent-id') || 'cli'
  const task = optionValue(flags, '--task') || ''
  const summary = optionValue(flags, '--summary') || ''
  const verification = optionValue(flags, '--verification') || ''
  const traceId = optionValue(flags, '--trace-id') || ''

  // Preview by default, like every other CLI write (mio memory archive,
  // mio agents register): nothing is written without --yes, --json included.
  if (!flagPresent(flags, '--yes')) {
    const existing = cliAgentStore()
      .listAgents({ project })
      .agents.find((a) => a.agentId === agentId)
    if (useJson) {
      jsonOrText(
        {
          preview: true,
          applied: false,
          outcome,
          agentId,
          project,
          task,
          summary,
          verification,
          agentWillUpdate: !!existing,
          currentTaskCount: existing ? existing.taskCount || 0 : null,
          hint: 'Re-run with --yes to apply.',
        },
        true,
      )
    } else {
      console.log(`Record outcome preview: ${outcome} (project=${project}, agent=${agentId})`)
      if (task) console.log(`  task: ${task}`)
      if (summary) console.log(`  summary: ${summary}`)
      if (existing) {
        const nextTasks = (existing.taskCount || 0) + 1
        const nextSuccess = (existing.successCount || 0) + (outcome === 'success' ? 1 : 0)
        console.log(
          `  will update agent (taskCount ${existing.taskCount || 0} -> ${nextTasks}, successCount ${existing.successCount || 0} -> ${nextSuccess})`,
        )
      } else {
        console.log(`  agent not registered: trace only, agent registry untouched`)
        console.log(`  register it with: mio agents register --agent-id ${agentId} --yes`)
      }
      console.log('Re-run with --yes to apply.')
    }
    process.exitCode = 1
    return
  }

  let result
  try {
    result = cliTaskStore().recordTaskOutcome({
      outcome,
      agentId,
      project,
      task,
      summary,
      verification,
      traceId,
    })
  } catch (error) {
    console.error(error.message || error)
    process.exitCode = 1
    return
  }

  if (useJson) return jsonOrText(result, true)
  console.log(`Recorded ${result.event.outcome} for ${result.event.agent} (project=${result.event.project})`)
  console.log(`  trace: ${result.event.trace_id}`)
  console.log(`  agent registry: ${result.agentUpdated ? 'updated' : 'not updated (agent not registered)'}`)
  if (result.autoClaims) console.log(`  auto-claims: ${result.autoClaims.length}`)
}

function taskCommand(args, useJson) {
  const sub = args[1]
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(`Usage:
  mio task route "<task>"     Which verified experiences apply to this task
  mio task route "<task>" --json    Machine-readable (same shape as mio.task.route)

Options:
  --project name     Project filter (defaults to the current directory name)
  --scope all|project|global   Memory scope to consider
  --limit N          Max routes (1-10, default 5)

This is read-only: unlike the MCP call it does not write to the query log.`)
    if (!sub) process.exitCode = 1
    return
  }
  if (sub === 'record-outcome' || sub === 'record_outcome') {
    return recordOutcomeCommand(args, useJson)
  }

  if (sub !== 'route') {
    console.error(`Unknown task subcommand: ${sub}`)
    process.exitCode = 1
    return
  }

  const flags = args.slice(2)
  // The task is free text and may be quoted as one argument or passed as
  // several words. Only flags this command understands are treated as options.
  const TASK_KNOWN_FLAGS = new Set(['--project', '--scope', '--limit', '--json'])
  const taskParts = []
  for (let i = 0; i < flags.length; i += 1) {
    const token = flags[i]
    if (TASK_KNOWN_FLAGS.has(token)) continue
    if (i > 0 && TASK_KNOWN_FLAGS.has(flags[i - 1])) continue
    taskParts.push(token)
  }
  const task = taskParts.join(' ').trim()
  if (!task) {
    console.error('mio task route requires a task, e.g. mio task route "publish the npm package"')
    process.exitCode = 1
    return
  }

  let result
  try {
    result = cliTaskStore().routeTask({
      task,
      project: optionValue(flags, '--project'),
      scope: optionValue(flags, '--scope'),
      limit: parseNumberOption(flags, '--limit'),
      persistQuery: false,
    })
  } catch (error) {
    console.error(error.message || error)
    process.exitCode = 1
    return
  }

  if (useJson) return jsonOrText(result, true)
  printTaskRoute(result)
}

function printTaskRoute(result) {
  console.log(`Task route: "${result.task}" (project=${result.project || 'all'}, scope=${result.scope})`)
  console.log(`verified routes: ${result.count}`)

  if (result.count > 0) {
    console.log('')
    console.log('Routes (apply the top match first):')
    result.routes.forEach((route, index) => {
      const via = route.sourceAgents.length > 0 ? route.sourceAgents.join(', ') : '?'
      const to = route.targetAgents.length > 0 ? route.targetAgents.join(', ') : '?'
      console.log(
        `${index + 1}. [score ${route.score}] ${route.experienceId} — reused ${route.reuseCount}x${route.confirmed ? ' (confirmed)' : ''}`,
      )
      console.log(`   ${String(route.memory.content).replace(/\s+/g, ' ').slice(0, 110)}`)
      console.log(`   ${via} -> ${to}`)
    })
  }

  if (result.relatedMemories.length > 0) {
    console.log('')
    console.log('Related memories:')
    for (const record of result.relatedMemories) {
      console.log(`- ${record.id}  ${String(record.content).replace(/\s+/g, ' ').slice(0, 100)}`)
    }
  }

  if (result.summary && result.summary.routingSignal) {
    console.log(`\nAgent health: ${result.summary.routingSignal}`)
  }
  if (result.summary && result.summary.suggestion) {
    console.log(`\n${result.summary.suggestion}`)
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
  mio agents                  List installed host adapters
  mio agents list             List observed agents (from agents.jsonl, --project X)
  mio agents report           Report per-agent task/memory/reuse telemetry (--agent X, --project Y)
  mio agents register --agent-id X   Register an observed agent (--yes to apply; previews by default)
  mio evolution status        Show composed evolution module health
  mio evolution report        Cross-agent evolution report: ecosystem, agents, memory health, suggestions (--period 24h|7d|30d|all)
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
  mio memory analyze          Report duplicates, low-quality records and kind histogram
  mio memory archive --ids a,b    Archive records (soft delete; --yes required to apply)
  mio memory forget --ids a,b     PERMANENTLY delete records (--yes required; not undoable)
  mio memory restore --ids a,b    Un-archive previously archived records
  mio memory merge --ids a,b  Merge duplicates into one survivor (--yes required to apply)
  mio memory migrate --ids a,b --scope global|project   Move records between layers
  mio experience list        List experience reuse (--status pending|confirmed|verified)
  mio experience confirm --ids a,b   Confirm auto-claimed reuse (bulk supported)
  mio experience reuse --source-agent A --target-agent B --experience-id X   Record a reuse
  mio creativity status        Show creativity hypothesis counts and recent top ideas
  mio creativity list          List creativity hypotheses (--status active|validated|rejected|draft, --limit N)
  mio creativity generate      Generate hypotheses from 2+ --source "name|content" (calls an LLM)
  mio creativity ferment       Review and refine active hypotheses (calls an LLM)
  mio insight status           Insight counts: total, reported, unreported, high-value
  mio insight list             List insights (--unreported, --min-score N, --detector X, --limit N)
  mio insight mark-reported    Mark insights as reported (--ids a,b)
  mio observer <view>          Observer pipeline views (research pipeline, not the observe daemon):
                               status | world-model | trends | research | insights | essays | dag
  mio observer ingest --trace-id T --event-type E   Record a trace event (--payload/--outcome)
  mio observer subscribe --event-types a,b          Subscribe to events (--yes to apply)
  mio observer digest                               New events since the last digest (advances cursor)
  mio observer collect         Fetch from the configured sources (--sources/--keywords/--limit)
  mio observer ferment         Run the fermentation engine (--session morning|afternoon|night)
  mio phase0 report            Show the Phase 0 validation report (--project X, --format markdown)
  mio host capabilities        Show what each host supports and whether it is installed
  mio task route "<task>"      Which verified experiences apply to this task (--project/--scope/--limit)
  mio task record-outcome --outcome success   Record a task outcome (--yes to apply; previews by default)
  mio policy check "<action>" Check historical risk for an action before running it
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
      return agentsCommand(args, useJson)
    case 'observe':
      return observeCommand(args)
    case 'recall':
      return recallCommand(args, useJson)
    case 'traces':
      return tracesCommand(args, useJson)
    case 'remember':
      return rememberCommand(args, useJson)
    case 'memory':
      return memoryCommand(args, useJson)
    case 'experience':
      return experienceCommand(args, useJson)
    case 'policy':
      return policyCommand(args, useJson)
    case 'creativity':
      return creativityCommand(args, useJson)
    case 'insight':
      return insightCommand(args, useJson)
    case 'observer':
      return observerCommand(args, useJson)
    case 'phase0':
      return phase0Command(args, useJson)
    case 'host':
      return hostCommand(args, useJson)
    case 'task':
      return taskCommand(args, useJson)
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
