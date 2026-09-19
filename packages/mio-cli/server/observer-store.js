'use strict'

// Shared observer research-pipeline store: the single implementation behind the
// mio.observer.* MCP tools and the `mio observer` CLI command. Keeping it here
// rather than inlined in the MCP server means both entry points read the same
// files the same way and cannot drift -- same rationale as memory-store.js,
// experience-store.js and policy-store.js.
//
// Default base directory matches the MCP server: <cwd>/.local/observer. This is
// deliberately project-local (unlike the MIO_HOME-backed stores) because the
// research pipeline writes into the project it observes; both the CLI flag
// --base-dir and the MCP argument baseDir override it.

const fs = require('fs')
const path = require('path')

// Observer research pipeline (optional -- installed via @akemi-mio/observer).
// Loaded lazily at module level so the CLI can report availability without the
// MCP server having to pass its own handles down.
// Two-step resolution, same as server/runtime-modules.js and insight-store.js:
// the published package first, then the workspace source. A checkout has no
// node_modules/@akemi-mio, so without the fallback the whole mio.observer.*
// family stays gated off while its source is sitting in packages/observer.
function loadObserver() {
  try {
    return require('@akemi-mio/observer')
  } catch (_) {
    return require(path.resolve(__dirname, '..', '..', 'observer'))
  }
}

let ObserverStore = null
let ObserverService = null
try {
  const obs = loadObserver()
  ObserverStore = obs.ObserverStore
  ObserverService = obs.ObserverService
} catch {}

// Subdirectories that make up the pipeline. `observerStatus` counts files in
// each, so adding a stage here also makes it show up in the status output.
const OBSERVER_SUBDIRS = [
  'observations',
  'trends',
  'topics',
  'research',
  'insights',
  'world_model',
  'essays',
]

function isObserverAvailable() {
  return Boolean(ObserverStore)
}

function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function readJsonlSafe(filePath) {
  if (!fs.existsSync(filePath)) return []
  try {
    return fs
      .readFileSync(filePath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

// Reads a directory of per-item JSON files, newest file name first.
function readJsonDir(dirPath, limit) {
  if (!fs.existsSync(dirPath)) return []
  const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.json')).sort().reverse()
  return files.slice(0, limit).map((f) => readJsonSafe(path.join(dirPath, f))).filter(Boolean)
}

function createObserverStore(options = {}) {
  const defaultBaseDir = options.baseDir || path.join(process.cwd(), '.local', 'observer')

  // Per-call args win over the store default, matching the MCP handler contract
  // where the caller may pass baseDir on any tool call.
  function baseDirOf(args = {}) {
    return args.baseDir || defaultBaseDir
  }

  function status(args = {}) {
    const baseDir = baseDirOf(args)
    const result = {}
    for (const d of OBSERVER_SUBDIRS) {
      const dir = path.join(baseDir, d)
      result[d] = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => !f.startsWith('.')).length
        : 0
    }
    return result
  }

  function worldModel(args = {}) {
    const baseDir = baseDirOf(args)
    const wmDir = path.join(baseDir, 'world_model')
    return {
      entities: readJsonSafe(path.join(wmDir, 'entities.json')) || [],
      events: readJsonSafe(path.join(wmDir, 'events.json')) || [],
      trends: readJsonSafe(path.join(wmDir, 'trends.json')) || [],
      narratives: readJsonSafe(path.join(wmDir, 'narratives.json')) || [],
    }
  }

  function trends(args = {}) {
    const baseDir = baseDirOf(args)
    const trendsDir = path.join(baseDir, 'trends')
    if (args.date) {
      const report = readJsonSafe(path.join(trendsDir, `${args.date}.json`))
      return report ? [report] : []
    }
    return readJsonDir(trendsDir, args.limit || 7)
  }

  function research(args = {}) {
    return readJsonDir(path.join(baseDirOf(args), 'research'), args.limit || 10)
  }

  function insights(args = {}) {
    return readJsonDir(path.join(baseDirOf(args), 'insights'), args.limit || 20)
  }

  function essays(args = {}) {
    const baseDir = baseDirOf(args)
    const type = args.type || 'published'
    const essaysDir = path.join(baseDir, 'essays', type)
    if (!fs.existsSync(essaysDir)) return []
    const files = fs.readdirSync(essaysDir).filter((f) => f.endsWith('.md')).sort().reverse()
    return files.slice(0, args.limit || 10).map((f) => {
      const full = path.join(essaysDir, f)
      return {
        file: f,
        type,
        content: fs.readFileSync(full, 'utf8'),
        created: fs.statSync(full).birthtime.toISOString(),
      }
    })
  }

  // Daily summaries for the last N days, used by the DAG view.
  function dag(args = {}) {
    const baseDir = baseDirOf(args)
    const days = args.days || 7
    const summaries = []
    const todayDate = new Date()
    for (let i = 0; i < days; i++) {
      const d = new Date(todayDate)
      d.setDate(d.getDate() - i)
      const dateStr = d.toISOString().slice(0, 10)
      const items = readJsonlSafe(path.join(baseDir, 'summaries', `${dateStr}.jsonl`))
      if (items.length) summaries.push({ date: dateStr, summaries: items })
    }
    return { summaries, summaryCount: summaries.reduce((a, s) => a + s.summaries.length, 0) }
  }

  // ObserverService.collectBySource and FermentationEngine.ferment are both
  // async. They must be awaited here: a Promise is `typeof 'object'` with no
  // own enumerable keys, so the previous synchronous version of collect()
  // happily "iterated" one and pushed nothing -- every call reported
  // `collected: 0` no matter how much the collectors actually returned.
  async function collect(args = {}) {
    if (!ObserverService) throw new Error('@akemi-mio/observer not installed')
    // ObserverService takes the base dir as a bare string -- passing an options
    // object made path.resolve() throw before any collector ran, so collect()
    // was dead on arrival for every caller. (collectorConfig was never read by
    // the package; it was invented here.)
    const service = new ObserverService(baseDirOf(args))
    const sources = args.sources || ['bilibili', 'hackernews', 'github', 'douyin', 'rss']
    const allObs = []
    for (const src of sources) {
      try {
        const collectFn = service.collectBySource || service.collect
        if (!collectFn) {
          throw new Error('ObserverService exposes neither collectBySource nor collect')
        }
        const result = await collectFn.call(service, [src], args.keywords || [], args.limit || 20)
        if (Array.isArray(result)) allObs.push(...result)
        else if (result && typeof result === 'object') {
          // Record<sourceName, Observation[]>: keep every list, in key order.
          for (const items of Object.values(result)) {
            if (Array.isArray(items)) allObs.push(...items)
          }
        }
      } catch (e) {
        allObs.push({ source: src, error: e.message })
      }
    }
    return { collected: allObs.length, observations: allObs }
  }

  async function ferment(args = {}) {
    if (!ObserverService) throw new Error('@akemi-mio/observer not installed')
    const service = new ObserverService(baseDirOf(args))
    const session = args.session || 'afternoon'
    try {
      const fermentation = service.getFermentation()
      if (fermentation && fermentation.ferment) return await fermentation.ferment(session)
      return { status: 'fermentation engine available but no ferment method' }
    } catch (e) {
      return { error: e.message }
    }
  }

  return {
    baseDir: defaultBaseDir,
    status,
    worldModel,
    trends,
    research,
    insights,
    essays,
    dag,
    collect,
    ferment,
  }
}

module.exports = {
  createObserverStore,
  isObserverAvailable,
  readJsonSafe,
  readJsonlSafe,
  OBSERVER_SUBDIRS,
}
