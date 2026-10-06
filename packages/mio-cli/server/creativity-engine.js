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

// One clamp for every LLM score: coerce, reject NaN/Infinity (a model that
// returns "high" used to store NaN and poison the sum gate), then bound to
// 0-100. Missing values fall back so old records keep a neutral score.
function clamp100(value, fallback = 50) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(100, Math.max(0, n))
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
          system: [
            'You are a creative hypothesis generator. Generate ONE novel hypothesis by combining the given concepts.',
            'Reasoning rules:',
            '1. First state the synergy mechanism: WHY these two concepts combine (what shared structure or complementary gap), not just THAT they pair.',
            '2. Then give a causal chain: premise -> mechanism -> outcome. Each step must follow from the previous one; no unexplained jumps.',
            '3. Be concrete: name the component, the change, and the observable effect. Vague claims ("improve efficiency", "be better") score 0 on logic.',
            '4. State the strongest counter-risk honestly; an idea with no real risk is not being analyzed.',
            'Output JSON with fields: title (<=60 chars), idea (the full causal chain, 100-250 words), expectedBenefit, risk, novelty (0-100), feasibility (0-100), impact (0-100), logic (0-100: how tight and complete the causal chain is).',
          ].join('\n'),
          temperature: strat === 'explore' ? 0.8 : 0.4,
          maxTokens: 900,
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
          title: String(result.data.title || 'Untitled').slice(0, 60),
          idea: result.data.idea || '',
          expectedBenefit: result.data.expectedBenefit || '',
          risk: result.data.risk || '',
          novelty: clamp100(result.data.novelty || 50),
          feasibility: clamp100(result.data.feasibility || 50),
          impact: clamp100(result.data.impact || 50),
          // logic is the fourth scoring dimension: a high-novelty idea with a
          // broken causal chain must be visibly weaker than one that reasons
          // cleanly. Defaults to 50 so records written before it existed keep
          // a neutral value instead of NaN.
          logic: clamp100(result.data.logic ?? 50),
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
Novelty: ${h.novelty}, Feasibility: ${h.feasibility}, Impact: ${h.impact}, Logic: ${h.logic ?? '(not scored)'}

Review checklist (apply in order):
1. Causal chain: does the idea explain WHY A leads to B at each step? If a step is asserted without a mechanism, lower logic and rewrite the step.
2. Evidence: is each claim traceable to the given idea text, or is it speculation presented as fact? Flag speculation.
3. Falsifiability: can you state how this idea would prove wrong? If not, say so in reason.
4. Concrete over vague: reject filler claims ("improve efficiency") by rewriting them with the specific component and effect.

Verdict rules:
- promote: the idea is mature AND the refined scores justify landing (novelty + feasibility + impact > 200 with logic >= 60).
- merge: only when this idea is clearly complementary to another stored one; set mergeWithId to that hypothesis id.
- reject: the causal chain cannot be repaired, or the premise lost its supporting signals.
- keep: everything else.

Output JSON with: title, idea, expectedBenefit, risk, novelty (0-100), feasibility (0-100), impact (0-100), logic (0-100), verdict (promote/keep/reject/merge), reason, mergeWithId (only for merge).`

      try {
        const result = await this.chatJson(prompt, {
          system: 'You are a critical creative hypothesis reviewer. Reward tight causal reasoning, penalize vagueness. Output JSON only.',
          temperature: 0.3,
          maxTokens: 900,
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
          title: String(result.data.title || h.title).slice(0, 60),
          idea: result.data.idea || h.idea,
          expectedBenefit: result.data.expectedBenefit || h.expectedBenefit,
          risk: result.data.risk || h.risk,
          novelty: clamp100(result.data.novelty || h.novelty),
          feasibility: clamp100(result.data.feasibility || h.feasibility),
          impact: clamp100(result.data.impact || h.impact),
          logic: clamp100(result.data.logic ?? h.logic ?? 50),
          fermentedAt: Date.now(),
          fermentCount: (h.fermentCount || 0) + 1,
        }

        let verdict = result.data.verdict
        if (verdict === 'reject') {
          patch.status = 'rejected'
        } else if (verdict === 'merge') {
          // merge used to fall through silently: the verdict was echoed back
          // in the results but nothing was merged. Now it behaves like
          // IdeaFermentationEngine -- the reviewed idea is folded into the
          // target and marked merged, or downgraded to keep when the target
          // id is unknown (an unresolvable merge is not a merge).
          const target = result.data.mergeWithId
            ? this.store.getHypotheses().find((x) => x.id === result.data.mergeWithId)
            : null
          if (target && target.id !== h.id) {
            target.idea = [target.idea, patch.idea].filter(Boolean).join('\n---\n')
            target.fermentedAt = patch.fermentedAt
            target.fermentCount = (target.fermentCount || 0) + 1
            this.store.updateHypothesis(target.id, {
              idea: target.idea,
              fermentedAt: target.fermentedAt,
              fermentCount: target.fermentCount,
            })
            patch.status = 'merged'
            patch.mergedInto = target.id
          } else {
            // An unresolvable merge target is not a merge; report it honestly
            // as keep so the caller never sees a merge that did not happen.
            verdict = 'keep'
          }
        }

        // The gate is unconditional: patch.logic already folds in the
        // review's score, the stored score, or 50. A reviewer that omits
        // the field falls back to the stored/neutral value — omitting logic
        // must not waive the gate it exists to enforce.
        const logicOk = Number.isFinite(patch.logic) && patch.logic >= 60
        if (verdict === 'promote' && (patch.novelty + patch.feasibility + patch.impact) > 200 && logicOk) {
          patch.status = 'validated'
        }

        this.store.updateHypothesis(h.id, patch)
        results.push({ id: h.id, title: h.title, verdict, reason: result.data.reason })
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
        // Undefined keys vanish over JSON (the CLI path); keep them out here
        // too so the engine and the CLI round-trip deep-equal.
        ...(h.logic !== undefined ? { logic: h.logic } : {}),
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
      ...(h.logic !== undefined ? { logic: h.logic } : {}),
      score: h.novelty + h.feasibility + h.impact,
      sourceLabels: h.sourceLabels,
      createdAt: h.createdAt,
      fermentedAt: h.fermentedAt,
      fermentCount: h.fermentCount,
      ...(h.mergedInto !== undefined ? { mergedInto: h.mergedInto } : {}),
    }))
  }

  _buildGenerationPrompt(a, b, strategy, recentHypotheses, rejectedHypotheses) {
    // Long sources used to be pasted unbounded, crowding the instructions out
    // of the context window; 600 chars keeps the pairing signal without the
    // flood.
    const clip = (s, n = 600) => (s.length > n ? s.slice(0, n) + '…' : s)
    let prompt = `Combine these two concepts into ONE novel hypothesis:\n\n`
    prompt += `Concept A: "${a.name}" — ${clip(a.content)}\n`
    prompt += `Concept B: "${b.name}" — ${clip(b.content)}\n\n`
    prompt += `Strategy: ${strategy}\n`

    if (strategy === 'explore') {
      prompt += `Cross-domain combination. Emphasize structural differences and unexpected connections.\n`
    } else if (strategy === 'signal') {
      prompt += `Inject external signals. Be provocative and challenge assumptions.\n`
    } else {
      prompt += `Stable combination. Conservative refinement of existing ideas.\n`
    }

    // The logical-quality bar, stated where the model composes rather than
    // only in the system prompt: synergy mechanism, explicit causal chain,
    // and no claims that cannot name their mechanism.
    prompt += `\nQuality requirements:\n`
    prompt += `- The idea must explain the synergy mechanism: WHY these two concepts combine.\n`
    prompt += `- Write the proposal as a causal chain (premise -> mechanism -> outcome), each step following from the last.\n`
    prompt += `- Be specific: component, change, observable effect. No bare claims like "improve efficiency".\n`
    prompt += `- The title must be self-contained (a reader sees only the title in lists).\n`

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

    prompt += `\nOutput JSON: {"title": "...", "idea": "...", "expectedBenefit": "...", "risk": "...", "novelty": 0-100, "feasibility": 0-100, "impact": 0-100, "logic": 0-100}`
    return prompt
  }
}

module.exports = { CreativityEngine, CreativityStore, sourcesFromInsights }
