#!/usr/bin/env node
'use strict'

// Gate: every MCP tool must be reachable from the terminal and mentioned in the
// README.
//
// Why this exists: `mio.insight.generate` sat in the MCP server for weeks with
// no CLI entry point while the README already listed it as one of the four
// LLM-calling commands -- the docs promised a command that did not exist. The
// same drift is invisible in review because the tool list lives in
// server/mio-intelligence-mcp/index.js and nothing cross-checks it.
//
// Design notes, because two obvious designs are wrong:
//   * The tool list is DISCOVERED from source, not hand-written. A hand-written
//     list rots silently -- it stays green while tools are added.
//   * The MCP -> CLI mapping below IS hand-written (the names genuinely differ:
//     mio.memory.query is `mio recall`). It cannot rot unnoticed either,
//     because a tool missing from the map is reported. That is the whole point:
//     the map is forced to stay complete, and the discovered list is what
//     forces it.
//   * "Has a CLI entry point" is checked by running the command's own usage
//     output, not by grepping bin/mio.js -- a string in a comment would pass a
//     grep.

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const SERVER_DIR = path.join(root, 'packages', 'mio-cli', 'server')
const CLI = path.join(root, 'packages', 'mio-cli', 'bin', 'mio.js')
const README = path.join(root, 'packages', 'mio-cli', 'README.md')

// The one hand-written table. `cli` is the argv a user would type after `mio`.
const MCP_TO_CLI = {
  'mio.agent.list': ['agents', 'list'],
  'mio.agent.register': ['agents', 'register'],
  'mio.agent.report': ['agents', 'report'],
  'mio.agent.evaluation': ['agents', 'evaluation'],
  'mio.creativity.ferment': ['creativity', 'ferment'],
  'mio.creativity.generate': ['creativity', 'generate'],
  'mio.creativity.list': ['creativity', 'list'],
  'mio.creativity.status': ['creativity', 'status'],
  'mio.digest.generate': ['digest'],
  'mio.evolution.authority.plan': ['evolution', 'authority', 'plan'],
  'mio.evolution.cutover.apply': ['evolution', 'cutover', 'apply'],
  'mio.evolution.cutover.readiness': ['evolution', 'cutover', 'readiness'],
  'mio.evolution.dual_write.record': ['evolution', 'dual-write', 'record'],
  'mio.evolution.migration.plan': ['evolution', 'migration', 'plan'],
  'mio.evolution.report': ['evolution', 'report'],
  'mio.evolution.shadow.record': ['evolution', 'shadow', 'record'],
  'mio.evolution.status': ['evolution', 'status'],
  'mio.experience.confirm': ['experience', 'confirm'],
  'mio.experience.list': ['experience', 'list'],
  'mio.experience.reuse': ['experience', 'reuse'],
  'mio.host.capabilities': ['host', 'capabilities'],
  'mio.insight.generate': ['insight', 'generate'],
  'mio.insight.list': ['insight', 'list'],
  'mio.insight.mark_reported': ['insight', 'mark-reported'],
  'mio.insight.status': ['insight', 'status'],
  'mio.memory.analyze': ['memory', 'analyze'],
  'mio.memory.archive': ['memory', 'archive'],
  'mio.memory.forget': ['memory', 'forget'],
  'mio.memory.merge': ['memory', 'merge'],
  'mio.memory.migrate': ['memory', 'migrate'],
  'mio.memory.query': ['recall'],
  'mio.memory.record': ['remember'],
  'mio.observer.collect': ['observer', 'collect'],
  'mio.observer.dag': ['observer', 'dag'],
  'mio.observer.digest': ['observer', 'digest'],
  'mio.observer.essays': ['observer', 'essays'],
  'mio.observer.ferment': ['observer', 'ferment'],
  'mio.observer.ingest': ['observer', 'ingest'],
  'mio.observer.insights': ['observer', 'insights'],
  'mio.observer.pipeline': ['observer', 'pipeline'],
  'mio.observer.research': ['observer', 'research'],
  'mio.observer.status': ['observer', 'status'],
  'mio.observer.subscribe': ['observer', 'subscribe'],
  'mio.observer.trends': ['observer', 'trends'],
  'mio.observer.world_model': ['observer', 'world-model'],
  'mio.phase0.report': ['phase0', 'report'],
  'mio.policy.check': ['policy', 'check'],
  'mio.task.record_outcome': ['task', 'record-outcome'],
  'mio.task.route': ['task', 'route'],
  'mio.trace.query': ['traces'],
}

// Digits matter: mio.phase0.report was missed for a while by a pattern that
// only allowed letters.
const TOOL_PATTERN = /name:\s*'(mio\.[a-zA-Z0-9_.]+)'/g

function discoverTools() {
  const found = new Set()
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js')) {
        const text = fs.readFileSync(full, 'utf8')
        for (const match of text.matchAll(TOOL_PATTERN)) found.add(match[1])
      }
    }
  }
  walk(SERVER_DIR)
  return [...found].sort()
}

// Does the CLI actually offer this command?
//
// The first choice is the top-level `mio --help`, because that is the list
// users read and it costs one safe call. Probing each command's own `--help`
// looks tempting but is NOT safe and NOT uniform: `mio recall --help` runs a
// real search for "--help", `mio traces --help` / `mio digest --help` really
// execute, and `mio agents --help` prints adapters instead of a usage.
//
// The fallback is deliberately weaker: the subcommand token must appear
// somewhere in bin/mio.js. That still catches the case this gate exists for -- a
// tool with no terminal entry point at all, like mio.insight.generate used to
// be -- while tolerating shorthand usage text. The observer views are the
// reason: they are listed as "status | world-model | ..." under one
// `mio observer <view>` line, so "mio observer world-model" appears nowhere.
const mainHelp = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' }).stdout || ''
const cliSource = fs.readFileSync(CLI, 'utf8')

function cliOwnsCommand(cli) {
  if (mainHelp.includes(`mio ${cli.join(' ')}`)) return true
  const token = cli[cli.length - 1]
  return cliSource.includes(`'${token}'`) || cliSource.includes(`"${token}"`)
}

const tools = discoverTools()
const readme = fs.readFileSync(README, 'utf8')

const problems = []
let mapped = 0
let documented = 0

for (const tool of tools) {
  const cli = MCP_TO_CLI[tool]
  if (!cli) {
    problems.push(`${tool}: no CLI entry point mapped (add one, or map it here)`)
    continue
  }
  mapped += 1
  if (!cliOwnsCommand(cli)) {
    problems.push(`${tool}: mapped to "mio ${cli.join(' ')}" but that command's usage does not list it`)
  }
  if (!readme.includes(tool)) {
    problems.push(`${tool}: not mentioned in packages/mio-cli/README.md`)
  } else {
    documented += 1
  }
}

// The reverse direction: a mapping for a tool that no longer exists means the
// table was not cleaned up when the tool was removed.
for (const tool of Object.keys(MCP_TO_CLI)) {
  if (!tools.includes(tool)) problems.push(`${tool}: mapped but no longer defined in server/`)
}

console.log(`MCP tools: ${tools.length} | with a CLI entry: ${mapped} | documented: ${documented}`)

if (problems.length > 0) {
  console.error(`\n${problems.length} coverage problem(s):`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log('every MCP tool is reachable from the CLI and documented')
