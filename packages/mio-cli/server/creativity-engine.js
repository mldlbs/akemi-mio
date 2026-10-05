'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// Cache validity key for a JSONL file: a (size, mtimeMs) pair, the same
// guard server/insight-store.js uses (commit 0ba7fa8). Every getter below used
// to latch its parsed array forever, so a long-running MCP process answered
// `mio.creativity.list` from the copy it loaded at startup and a
// `mio creativity generate` in another process stayed invisible until restart.
function fileSignature(filePath) {
  try {
    const st = fs.statSync(filePath)
    return `${st.size}:${st.mtimeMs}`
  } catch (_) {
    return 'missing'
  }
}

// ═══════════════════════════════════════════════
//  JSONL Store — ideas, combos, experiments
// ═══════════════════════════════════════════════

class CreativityStore {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.hypothesesPath = path.join(dataDir, 'creativity-hypotheses.jsonl')
    this.combosPath = path.join(dataDir, 'creativity-combos.jsonl')
    this.experimentsPath = path.join(dataDir, 'creativity-experiments.jsonl')
    this._hypotheses = null
    this._combos = null
    this._experiments = null
    this._hypothesesSig = null
    this._combosSig = null
    this._experimentsSig = null
  }

  _ensureDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true })
    }
  }

  _readJsonl(filePath) {
    if (!fs.existsSync(filePath)) return []
    return fs.readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line) } catch { return null }
      })
      .filter(Boolean)
  }

  _appendJsonl(filePath, record) {
    this._ensureDir()
    fs.appendFileSync(filePath, JSON.stringify(record) + '\n')
  }

  getHypotheses(opts = {}) {
    const sig = fileSignature(this.hypothesesPath)
    if (this._hypotheses === null || this._hypothesesSig !== sig) {
      this._hypotheses = this._readJsonl(this.hypothesesPath)
      this._hypothesesSig = sig
    }
    let list = this._hypotheses
    if (opts.status) list = list.filter(h => h.status === opts.status)
    if (opts.limit) list = list.slice(-opts.limit)
    return list
  }

  addHypothesis(h) {
    this._appendJsonl(this.hypothesesPath, h)
    this._hypothesesSig = fileSignature(this.hypothesesPath)
    if (this._hypotheses) this._hypotheses.push(h)
  }

  updateHypothesis(id, patch) {
    const all = this.getHypotheses()
    const idx = all.findIndex(h => h.id === id)
    if (idx === -1) return false
    Object.assign(all[idx], patch)
    this._hypotheses = all
    this._rewriteFile(this.hypothesesPath, all)
    this._hypothesesSig = fileSignature(this.hypothesesPath)
    return true
  }

  getCombos(limit) {
    const sig = fileSignature(this.combosPath)
    if (this._combos === null || this._combosSig !== sig) {
      this._combos = this._readJsonl(this.combosPath)
      this._combosSig = sig
    }
    return limit ? this._combos.slice(-limit) : this._combos
  }

  addCombo(c) {
    this._appendJsonl(this.combosPath, c)
    this._combosSig = fileSignature(this.combosPath)
    if (this._combos) this._combos.push(c)
  }

  getExperiments() {
    const sig = fileSignature(this.experimentsPath)
    if (this._experiments === null || this._experimentsSig !== sig) {
      this._experiments = this._readJsonl(this.experimentsPath)
      this._experimentsSig = sig
    }
    return this._experiments
  }

  addExperiment(e) {
    this._appendJsonl(this.experimentsPath, e)
    this._experimentsSig = fileSignature(this.experimentsPath)
    if (this._experiments) this._experiments.push(e)
  }

  count() {
    return {
      hypotheses: this.getHypotheses().length,
      combos: this.getCombos().length,
      experiments: this.getExperiments().length,
    }
  }

  _rewriteFile(filePath, records) {
    this._ensureDir()
    fs.writeFileSync(filePath, records.map(r => JSON.stringify(r)).join('\n') + '\n')
  }
}

// ═══════════════════════════════════════════════
//  Concept Mixer — pair sources for novel combos
// ═══════════════════════════════════════════════

function mulberry32(seed) {
  let t = seed | 0
  return () => {
    t = (t + 0x6D2B79F5) | 0
    let x = Math.imul(t ^ (t >>> 15), 1 | t)
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

function mixConcepts(sources, exploredPairs, rng) {
  if (sources.length < 2) return []
  const pairs = []
  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      const key = `${sources[i].name}||${sources[j].name}`
      const reverseKey = `${sources[j].name}||${sources[i].name}`
      if (exploredPairs.has(key) || exploredPairs.has(reverseKey)) continue
      pairs.push([sources[i], sources[j]])
    }
  }
  // Shuffle and take top pairs
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[pairs[i], pairs[j]] = [pairs[j], pairs[i]]
  }
  return pairs.slice(0, Math.min(5, pairs.length))
}

// ═══════════════════════════════════════════════
//  Novelty Scorer — reject duplicates
// ═══════════════════════════════════════════════

function bigramSet(text) {
  const s = new Set()
  const lower = text.toLowerCase()
  for (let i = 0; i < lower.length - 1; i++) {
    s.add(lower.slice(i, i + 2))
  }
  return s
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

function evaluateNovelty(idea, recent, rejected) {
  const ideaBigrams = bigramSet(idea.title + ' ' + idea.idea)
  for (const r of recent) {
    const sim = jaccard(ideaBigrams, bigramSet(r.title + ' ' + r.idea))
    if (sim > 0.7) {
      return { shouldReject: true, rejectReason: `too similar to recent: "${r.title}" (sim=${sim.toFixed(2)})`, adjustedNovelty: idea.novelty }
    }
  }
  for (const r of rejected) {
    const sim = jaccard(ideaBigrams, bigramSet(r.title + ' ' + r.idea))
    if (sim > 0.6) {
      return { shouldReject: true, rejectReason: `matches rejected: "${r.title}" (sim=${sim.toFixed(2)})`, adjustedNovelty: idea.novelty }
    }
  }
  return { shouldReject: false, adjustedNovelty: Math.min(100, idea.novelty + 5) }
}

// ═══════════════════════════════════════════════
//  Creativity Engine — main orchestrator
// ═══════════════════════════════════════════════

// Concept sources drawn from stored insights, backing
// `mio.creativity.generate { fromInsights: true }` / `mio creativity generate
// --from-insights`. The *caller* supplies the insight records because only the
// entry point knows which store is authoritative (MIO_HOME for the CLI, the
// MCP server's MIO_DATA_DIR); this only maps them onto the { name, content,
// type, weight } shape the concept mixer pairs up. Highest score first, capped
// so one busy insight run cannot turn into dozens of LLM calls.
function sourcesFromInsights(insights, limit = 10) {
  return (Array.isArray(insights) ? insights : [])
    .filter(i => i && (i.title || i.description || i.content))
    .slice()
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, limit)
    .map(i => ({
      name: String(i.title || i.id || 'insight').replace(/\s+/g, ' ').slice(0, 60),
      content: [
        i.description || i.content || i.title || '',
        Array.isArray(i.evidence) && i.evidence.length > 0 ? `Evidence: ${i.evidence.join('; ')}` : '',
      ].filter(Boolean).join('\n'),
      type: 'insight',
      weight: 0.7,
    }))
}

const STRATEGY_CYCLE = ['explore', 'signal', 'stable']

class CreativityEngine {
  constructor(dataDir, chatJson) {
    this.store = new CreativityStore(dataDir)
    this.chatJson = chatJson
    this.strategyIndex = 0
    this.exploredPairs = new Set()
    this.rng = mulberry32(Date.now())
  }

  async generate(sourceLabels, strategy) {
    // A missing sources array used to reach .map() and surface as
    // "Cannot read properties of undefined", which tells the caller nothing.
    if (!Array.isArray(sourceLabels)) {
      throw new Error('creativity.generate requires sources: an array of { name, content } entries')
    }
    const sources = sourceLabels.map(s => ({
      name: s.name || 'unnamed',
      content: s.content || '',
      type: s.type || 'knowledge',
      weight: s.weight || 0.5,
    }))

    if (sources.length < 2) {
      return { ideas: [], reason: 'need at least 2 sources' }
    }

    const strat = strategy || STRATEGY_CYCLE[this.strategyIndex % STRATEGY_CYCLE.length]
    this.strategyIndex++

    // Mix concepts
    const recent = this.store.getHypotheses({ limit: 30 })
    const rejected = this.store.getHypotheses({ status: 'rejected', limit: 50 })
    const exploredPairs = new Set(recent.flatMap(h => (h.sourceLabels || []).map((l, i, a) => i > 0 ? `${a[i-1]}||${l}` : '')).filter(Boolean))
    const pairs = mixConcepts(sources, exploredPairs, this.rng.bind(this))

    if (pairs.length === 0) {
      return { ideas: [], reason: 'all pairs already explored' }
    }

    // Generate hypotheses via LLM
    const ideas = []
    // A failed pair used to vanish: `catch {}` swallowed the exception and a
    // chatJson `{ error }` payload fell through the `if (result.data)` guard,
    // so the caller saw `ideas: []` with no explanation of whether the LLM was
    // down, the JSON was unparseable, or every pair really was a duplicate.
    const errors = []
    for (const [a, b] of pairs) {
      const prompt = this._buildGenerationPrompt(a, b, strat, recent.slice(-10), rejected.slice(-5))
      try {
        const result = await this.chatJson(prompt, {
          system: `You are a creative hypothesis generator. Output JSON with fields: title, idea, expectedBenefit, risk, novelty (0-100), feasibility (0-100), impact (0-100). Generate ONE novel hypothesis by combining the given concepts.`,
          temperature: strat === 'explore' ? 0.8 : 0.4,
        })

        if (!result || !result.data) {
          errors.push({
            pair: [a.name, b.name],
            error: (result && result.error) || 'LLM returned no data',
          })
          continue
        }

        const h = {
          id: crypto.randomUUID(),
          title: result.data.title || 'Untitled',
          idea: result.data.idea || '',
          expectedBenefit: result.data.expectedBenefit || '',
          risk: result.data.risk || '',
          novelty: Math.min(100, Math.max(0, result.data.novelty || 50)),
          feasibility: Math.min(100, Math.max(0, result.data.feasibility || 50)),
          impact: Math.min(100, Math.max(0, result.data.impact || 50)),
          sourceLabels: [a.name, b.name],
          status: 'active',
          createdAt: Date.now(),
          strategy: strat,
        }

        // Novelty check
        const verdict = evaluateNovelty(h, recent, rejected)
        if (verdict.shouldReject) {
          h.status = 'rejected'
          h.rejectionReason = verdict.rejectReason
        } else {
          h.novelty = verdict.adjustedNovelty
        }

        this.store.addHypothesis(h)
        ideas.push(h)

        // Record combo
        this.store.addCombo({
          id: crypto.randomUUID(),
          sources: [a.name, b.name],
          description: h.title,
          createdAt: Date.now(),
        })
      } catch (err) {
        errors.push({
          pair: [a.name, b.name],
          error: String((err && err.message) || err),
        })
      }
    }

    return { ideas, strategy: strat, pairsAttempted: pairs.length, errors }
  }

  async ferment(limit = 5) {
    const fermentable = this.store.getHypotheses({ status: 'active' })
      .concat(this.store.getHypotheses({ status: 'draft' }))
      .slice(-limit)

    if (fermentable.length === 0) {
      return { fermented: 0, reason: 'no fermentable hypotheses' }
    }

    const results = []
    // Same reason as generate(): a failing review used to be indistinguishable
    // from a hypothesis that simply had nothing new to say.
    const errors = []
    for (const h of fermentable) {
      const prompt = `Review and refine this hypothesis. Current state:
Title: ${h.title}
Idea: ${h.idea}
Novelty: ${h.novelty}, Feasibility: ${h.feasibility}, Impact: ${h.impact}

Output JSON with: title, idea, expectedBenefit, risk, novelty, feasibility, impact, verdict (promote/keep/reject/merge), reason.`

      try {
        const result = await this.chatJson(prompt, {
          system: 'You are a creative hypothesis reviewer. Output JSON with refined scores and a verdict.',
          temperature: 0.3,
        })

        if (!result || !result.data) {
          errors.push({
            id: h.id,
            title: h.title,
            error: (result && result.error) || 'LLM returned no data',
          })
          continue
        }

        const patch = {
          title: result.data.title || h.title,
          idea: result.data.idea || h.idea,
          expectedBenefit: result.data.expectedBenefit || h.expectedBenefit,
          risk: result.data.risk || h.risk,
          novelty: Math.min(100, Math.max(0, result.data.novelty || h.novelty)),
          feasibility: Math.min(100, Math.max(0, result.data.feasibility || h.feasibility)),
          impact: Math.min(100, Math.max(0, result.data.impact || h.impact)),
          fermentedAt: Date.now(),
          fermentCount: (h.fermentCount || 0) + 1,
        }

        if (result.data.verdict === 'reject') {
          patch.status = 'rejected'
        } else if (result.data.verdict === 'promote' && (h.novelty + h.feasibility + h.impact) > 200) {
          patch.status = 'validated'
        }

        this.store.updateHypothesis(h.id, patch)
        results.push({ id: h.id, title: h.title, verdict: result.data.verdict, reason: result.data.reason })
      } catch (err) {
        errors.push({ id: h.id, title: h.title, error: String((err && err.message) || err) })
      }
    }

    return { fermented: results.length, results, errors }
  }

  status() {
    const count = this.store.count()
    const active = this.store.getHypotheses({ status: 'active' })
    const validated = this.store.getHypotheses({ status: 'validated' })
    const rejected = this.store.getHypotheses({ status: 'rejected' })
    // draft is a real state -- ferment() reviews draft + active -- so hiding it
    // here made `status` and `list --status draft` disagree.
    const draft = this.store.getHypotheses({ status: 'draft' })

    return {
      ...count,
      active: active.length,
      validated: validated.length,
      rejected: rejected.length,
      draft: draft.length,
      recentIdeas: active.slice(-5).map(h => ({
        id: h.id,
        title: h.title,
        novelty: h.novelty,
        feasibility: h.feasibility,
        impact: h.impact,
        score: h.novelty + h.feasibility + h.impact,
      })),
    }
  }

  // The MCP schema and the CLI usage text both promise a default of 20; the
  // implementation returned the whole store, so a large one flooded the tool
  // result. `limit: 0` (and only 0) opts back into "everything".
  list(opts = {}) {
    const limit = opts.limit === undefined ? 20 : opts.limit
    return this.store.getHypotheses({ ...opts, limit }).map(h => ({
      id: h.id,
      title: h.title,
      idea: h.idea,
      status: h.status,
      novelty: h.novelty,
      feasibility: h.feasibility,
      impact: h.impact,
      score: h.novelty + h.feasibility + h.impact,
      sourceLabels: h.sourceLabels,
      createdAt: h.createdAt,
      fermentedAt: h.fermentedAt,
      fermentCount: h.fermentCount,
    }))
  }

  _buildGenerationPrompt(a, b, strategy, recentHypotheses, rejectedHypotheses) {
    let prompt = `Combine these two concepts into ONE novel hypothesis:\n\n`
    prompt += `Concept A: "${a.name}" — ${a.content}\n`
    prompt += `Concept B: "${b.name}" — ${b.content}\n\n`
    prompt += `Strategy: ${strategy}\n`

    if (strategy === 'explore') {
      prompt += `Cross-domain combination. Emphasize structural differences and unexpected connections.\n`
    } else if (strategy === 'signal') {
      prompt += `Inject external signals. Be provocative and challenge assumptions.\n`
    } else {
      prompt += `Stable combination. Conservative refinement of existing ideas.\n`
    }

    if (recentHypotheses.length > 0) {
      prompt += `\nRecent ideas (avoid duplicates):\n`
      for (const h of recentHypotheses) {
        prompt += `- "${h.title}" (novelty=${h.novelty})\n`
      }
    }

    if (rejectedHypotheses.length > 0) {
      prompt += `\nRejected ideas (learn from failures):\n`
      for (const h of rejectedHypotheses) {
        prompt += `- "${h.title}" — ${h.risk}\n`
      }
    }

    prompt += `\nOutput JSON: {"title": "...", "idea": "...", "expectedBenefit": "...", "risk": "...", "novelty": 0-100, "feasibility": 0-100, "impact": 0-100}`
    return prompt
  }
}

module.exports = { CreativityEngine, CreativityStore, sourcesFromInsights }
