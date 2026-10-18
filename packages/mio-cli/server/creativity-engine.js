'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { readJsonl } = require('./memory-store.js')
const { ConceptMixer } = require('@akemi-mio/creativity/ConceptMixer')
const { evaluateNovelty } = require('@akemi-mio/creativity/NoveltyScorer')
const { JsonlFeedbackEventStore } = require('@akemi-mio/creativity/JsonlFeedbackEventStore')
const {
  buildFeedbackSnapshot,
  buildFeedbackPromptBlock,
  replayFeedbackAdjustment,
  DEFAULT_FEEDBACK_LEARNING_CONFIG,
} = require('@akemi-mio/creativity/FeedbackLearning')
const {
  resolveFeedbackRuntime,
  isFeedbackApplied,
  isFeedbackObserved,
  DEFAULT_FEEDBACK_RUNTIME,
  FEEDBACK_MODES,
} = require('@akemi-mio/creativity/FeedbackRuntime')
const {
  computeFeedbackGenerationMetrics,
  resolveFeedbackMetricsConfig,
} = require('@akemi-mio/creativity/FeedbackMetrics')
const {
  resolveFeedbackRolloutThresholds,
  buildFeedbackRolloutReport,
} = require('@akemi-mio/creativity/FeedbackRollout')
const { recordFeedbackRuntimeRun, readFeedbackRuntimeRuns } = require('@akemi-mio/creativity/FeedbackRuntimeRuns')

// P3 收官：反馈模式的持久化文件（仅 mode；λ/预算/半衰期旋钮仍只认 env）。
// 优先级 env MIO_FEEDBACK_MODE > 本文件 > 默认 off，两层都 fail-closed：
// 文件缺失/损坏/非法 mode 一律视为未设置，回默认 off。
const FEEDBACK_RUNTIME_FILE = 'feedback-runtime.json'

function readFeedbackModeFile(dataDir) {
  try {
    const raw = fs.readFileSync(path.join(dataDir, FEEDBACK_RUNTIME_FILE), 'utf8')
    const row = JSON.parse(raw)
    const mode = row && typeof row.mode === 'string' ? row.mode : null
    return mode && FEEDBACK_MODES.includes(mode) ? mode : null
  } catch (_) {
    return null
  }
}

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

// ISO timestamp for provenance: accepts epoch ms or date strings, returns
// undefined when the value is missing or unparsable.
function isoOf(value) {
  const t = typeof value === 'number' ? value : Date.parse(value || '')
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined
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
//  Concept pairing — R2 收敛（spec §九）：唯一实现是
//  @akemi-mio/creativity/ConceptMixer（已探索对罚 15 分参与排序，
//  不再硬跳过；策略配对约束也在 mixer 内）。engine 只在入口层做
//  策略可行性回退、装配 explored key 与反馈输入。
// ═══════════════════════════════════════════════

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
      // > 0.7: IdeaGenerator.applyTemperature keeps any weight>0.7 source unconditionally.
      weight: 0.78,
      origin: `insight:${i.id || i.title || 'unknown'}`,
      ...(i.id ? { originId: i.id } : {}),
      ...(isoOf(i.createdAt) ? { timestamp: isoOf(i.createdAt) } : {}),
    }))
}

const STRATEGY_CYCLE = ['explore', 'signal', 'stable']

// One row shape for every list variant — the fields JSON/CLI consumers already
// depend on. `noveltyScore` is added only by sort=novelty (relative ranking),
// never confused with the quality sum `score`.
function listRow(h) {
  return {
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
  }
}

// --- read-side adoption join (idea b19bada4, design discussion 1d2e22e4 D3) ---
// The store never gains an `adopted` status (D1/D4, see adoptHypothesis at the
// bottom of this file): adoption is joined at READ time from the two evidence
// axes the write side owns -- an append-only `creativity.adopt` trace event
// (payload.hypothesisId = the CLAIM, written by mio.creativity.adopt) and a
// `hypothesis:<id>` tag on a memory record (the EVIDENCE, injected by
// mio.memory.record's hypothesisId parameter). The engine sits in
// <dataRoot>/creativity on both hosts (MCP: path.join(dataDir, 'creativity');
// CLI: path.join(MIO_HOME, 'creativity')), so the two evidence files are one
// dirname up -- the same dataRoot convention adoptHypothesis documents.
// Missing files are fine: readJsonl returns [] for them.
//
// The counts are informational joins, NOT ADR-017 metrics: no rate and no
// threshold by design (D3 -- adoption rate was explicitly out of scope).
// `sources` follows the routeAdoption pattern (evaluation-store.js): names
// each axis' backing file and that it is durable, so a reader can tell
// "0 adopted" apart from "evidence not kept". claimed/evidenced are raw
// distinct ids (they can include ids no longer in the store); adopted is the
// inner join against stored hypotheses, the only count that answers "which
// surviving hypotheses were adopted".
const ADOPTION_TAG_PREFIX = 'hypothesis:'

const ADOPTION_SOURCES = Object.freeze({
  events: { file: 'traces.jsonl', durable: true },
  memory: { file: 'memory.jsonl', durable: true },
})

function readAdoptionEvidence(rootDir) {
  const claimed = new Set()
  for (const record of readJsonl(path.join(rootDir, 'traces.jsonl'))) {
    if (!record || record.event_type !== 'creativity.adopt') continue
    const id = record.payload && record.payload.hypothesisId
    if (id) claimed.add(String(id))
  }
  const evidenced = new Set()
  for (const record of readJsonl(path.join(rootDir, 'memory.jsonl'))) {
    if (!record || !Array.isArray(record.tags)) continue
    for (const tag of record.tags) {
      if (typeof tag !== 'string' || !tag.startsWith(ADOPTION_TAG_PREFIX)) continue
      const id = tag.slice(ADOPTION_TAG_PREFIX.length).trim()
      if (id) evidenced.add(id)
    }
  }
  return { claimed, evidenced }
}

class CreativityEngine {
  constructor(dataDir, chatJson) {
    this.dataDir = dataDir
    this.store = new CreativityStore(dataDir)
    this.chatJson = chatJson
    this.strategyIndex = 0
    // R2 收敛：配对唯一实现（已探索对降权 15 分，不硬跳过）。
    this.mixer = new ConceptMixer()
    // 正向反馈闭环 P0：CLI 侧证据事件只追加 feedback-events.jsonl（交换格式），
    // 权威真相源在主进程 SQLite，由 ingest 单向导入。
    this.feedbackEvents = new JsonlFeedbackEventStore(dataDir)
    // 正向反馈闭环 P3：受控启用运行时（默认 off，行为不变）。
    // 模式优先级：env MIO_FEEDBACK_MODE > 持久化 feedback-runtime.json >
    // 默认 off（两层都 fail-closed，见 readFeedbackModeFile）。
    this.feedbackRuntime = resolveFeedbackRuntime()
    if (!process.env.MIO_FEEDBACK_MODE) {
      const fileMode = readFeedbackModeFile(dataDir)
      if (fileMode) {
        this.feedbackRuntime = resolveFeedbackRuntime({ ...process.env, MIO_FEEDBACK_MODE: fileMode })
      }
    }
  }

  /** P3 收官：持久化反馈模式（放量操作面）。env 设定时仅写文件、当场不生效。 */
  setFeedbackMode(mode) {
    if (!FEEDBACK_MODES.includes(mode)) {
      throw new Error(`invalid feedback mode "${mode}" (expected: ${FEEDBACK_MODES.join(' | ')})`)
    }
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true })
    fs.writeFileSync(
      path.join(this.dataDir, FEEDBACK_RUNTIME_FILE),
      JSON.stringify({ mode, updatedAt: Date.now() }) + '\n',
      'utf8',
    )
    this.feedbackRuntime = process.env.MIO_FEEDBACK_MODE
      ? resolveFeedbackRuntime()
      : resolveFeedbackRuntime({ ...process.env, MIO_FEEDBACK_MODE: mode })
    return this.feedbackRuntime
  }

  /** P3：热切换反馈模式（回滚 = 切回 off）。 */
  setFeedbackRuntime(cfg) {
    this.feedbackRuntime = cfg || DEFAULT_FEEDBACK_RUNTIME
    return this.feedbackRuntime
  }

  /** P3：用本机 JSONL 事件 + 假设 provenance 构建不可变快照。 */
  buildFeedbackSnapshot() {
    const events = this.feedbackEvents.list()
    const hypotheses = {}
    for (const h of this.store.getHypotheses()) {
      hypotheses[h.id] = h.provenance ? { sources: h.provenance.sources } : undefined
    }
    return buildFeedbackSnapshot(events, hypotheses, DEFAULT_FEEDBACK_LEARNING_CONFIG)
  }

  /** P3：把快照转成 mixer 调整表（key = 排序 conceptId 对）。 */
  buildPairAdjustments(snapshot) {
    const map = new Map()
    for (const pair of snapshot.pairs) {
      map.set(pair.pairKey, replayFeedbackAdjustment(pair, DEFAULT_FEEDBACK_LEARNING_CONFIG).clampedAdjustment)
    }
    return map
  }

  /** P3 收尾：观测运行摘要落 feedback-runtime-runs.jsonl（读写唯一实现在 @akemi-mio/creativity/FeedbackRuntimeRuns，与主进程同格式）。 */
  recordRuntimeRun(run) {
    recordFeedbackRuntimeRun(this.dataDir, run)
  }

  readRuntimeRuns() {
    return readFeedbackRuntimeRuns(this.dataDir)
  }

  /** 事件摄取完整度的行统计：非空原始行 vs 可解析行（损坏行=静默丢失）。 */
  _ingestionCounts() {
    let rawLines = 0
    let validRows = 0
    try {
      const raw = fs.readFileSync(this.feedbackEvents.eventsPath, 'utf8')
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        rawLines++
        try {
          JSON.parse(line)
          validRows++
        } catch (_) {
          // 损坏行计入 dropped
        }
      }
    } catch (_) {
      // 文件缺失 → 0/0（completeness = null，无样本 ≠ 1）
    }
    return { rawLines, validRows }
  }

  /** P3 收官：验证指标（spec §八；纯计算，只读文件与假设状态）。 */
  _generationMetrics(snapshot) {
    return computeFeedbackGenerationMetrics({
      snapshot,
      hypotheses: this.store.getHypotheses(),
      ingestion: this._ingestionCounts(),
      config: resolveFeedbackMetricsConfig(),
    })
  }

  /** P3 收尾：放量状态 + 判定报告 + 验证指标（只读；阈值/指标走 env 配置，缺省预固定默认）。 */
  feedbackStatus() {
    let snapshot = null
    try {
      snapshot = this.buildFeedbackSnapshot()
    } catch (_) {
      snapshot = null
    }
    const runs = this.readRuntimeRuns()
    const thresholds = resolveFeedbackRolloutThresholds()
    const rollout = buildFeedbackRolloutReport({
      snapshot,
      runs,
      currentMode: this.feedbackRuntime.mode,
      thresholds,
    })
    let generation = null
    try {
      generation = this._generationMetrics(snapshot)
    } catch (_) {
      generation = null
    }
    return {
      mode: this.feedbackRuntime.mode,
      config: this.feedbackRuntime,
      snapshot: snapshot
        ? {
            version: snapshot.version,
            pairs: snapshot.pairs.length,
            eventCount: snapshot.eventCount,
            attributionCoverage: snapshot.attributionCoverage,
            duplicateApplicationRate: snapshot.duplicateApplicationRate,
          }
        : null,
      generation,
      recentRuns: runs.slice(-5),
      thresholds,
      rollout,
    }
  }

  async generate(sourceLabels, strategy, feedbackBlockArg) {
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
      // 正向反馈闭环 P2：保留 origin 供快照 pair 对齐（缺省 = 不影响既有行为）
      ...(s.origin ? { origin: s.origin } : {}),
      // P3-R5（task 0946ba33）：provenance 需要来源时间戳，有则透传
      ...(s.timestamp ? { timestamp: s.timestamp } : {}),
    }))

    if (sources.length < 2) {
      return { ideas: [], reason: 'need at least 2 sources' }
    }

    const strat = strategy || STRATEGY_CYCLE[this.strategyIndex % STRATEGY_CYCLE.length]
    this.strategyIndex++

    // R2 收敛（spec §九）：配对唯一实现是 @akemi-mio/creativity/ConceptMixer。
    // 策略可行性在入口层回退：mixer 的 explore 只配跨类型、signal 要求
    // provocation/insight/failure 来源，同质池会直接配出 0 对（先例：
    // idea-generate.js "cross-type explore only when two types exist, else
    // stable"）。回退只喂给 mixer——prompt 框架与温度仍按请求的 strat。
    const distinctTypes = new Set(sources.map((s) => s.type)).size
    const hasSignal = sources.some(
      (s) => s.type === 'provocation' || s.type === 'insight' || s.type === 'failure',
    )
    let mixStrat = strat
    if (strat === 'explore' && distinctTypes < 2) mixStrat = 'stable'
    else if (strat === 'signal' && !hasSignal) mixStrat = distinctTypes >= 2 ? 'explore' : 'stable'
    // stable 不回退：全部来源类型互异时它配不出同类型对，由下面的空池分支
    // 给出可切换策略的信号（文档化 "409 -> retry" 契约的承接者）。

    // 已探索身份 = 近 30 条假设 sourceLabels 的排序原始名对，与 ConceptMixer
    // scorePair 的 [nameA, nameB].sort().join('|') 同键。不按 strategy 分桶
    // （策略不再参与身份：降权对任何策略的重跑一致生效）；不 trim/截断
    // （旧 pairSourceKey 的 120 字符身份随 mixConcepts 一并移除）。
    const recent = this.store.getHypotheses({ limit: 30 })
    const rejected = this.store.getHypotheses({ status: 'rejected', limit: 50 })
    const exploredPairs = new Set(
      recent.flatMap((h) =>
        (h.sourceLabels || []).flatMap((l, i, a) =>
          i === 0 ? [] : [[a[i - 1], l].sort().join('|')],
        ),
      ),
    )
    // 正向反馈闭环 P3：受控启用。
    //   off     = 原行为（缺省，逐字节不变）
    //   shadow  = 只观测：计算快照与调整，记录版本，不应用到排序/prompt
    //   canary  = 按比例应用（canaryFraction 缩放 λ）
    //   full    = 全部应用
    let feedbackBlock = feedbackBlockArg
    let pairAdjustments = null
    const feedbackInfo = { mode: this.feedbackRuntime.mode, version: null, pairs: 0, applied: false }
    if (isFeedbackObserved(this.feedbackRuntime.mode) && !feedbackBlock) {
      try {
        const snapshot = this.buildFeedbackSnapshot()
        feedbackInfo.version = snapshot.version
        feedbackInfo.pairs = snapshot.pairs.length
        if (snapshot.pairs.length > 0) {
          const block = buildFeedbackPromptBlock(snapshot)
          const adjustments = this.buildPairAdjustments(snapshot)
          if (this.feedbackRuntime.mode === 'canary') {
            const scale = this.feedbackRuntime.canaryFraction
            for (const [k, v] of adjustments) adjustments.set(k, v * scale)
          }
          if (isFeedbackApplied(this.feedbackRuntime.mode)) {
            feedbackBlock = block
            pairAdjustments = adjustments
            feedbackInfo.applied = true
          }
          // shadow：保持 block=null / adjustments=null，仅观测
        }
      } catch (_) {
        // best-effort：反馈构建失败不得阻断生成
      }
    }
    // P3 收尾：观测模式下落运行摘要，供放量报告统计阶段门槛。
    if (isFeedbackObserved(this.feedbackRuntime.mode)) {
      try {
        this.recordRuntimeRun({
          at: Date.now(),
          mode: this.feedbackRuntime.mode,
          snapshotVersion: feedbackInfo.version,
          pairCount: feedbackInfo.pairs,
          applied: feedbackInfo.applied,
        })
      } catch (_) {
        // best-effort：观测落盘失败不得阻断生成
      }
    }

    // 反馈只进 mixer 排序：λ clamp 已在 buildPairAdjustments 完成、canary 已
    // 按 canaryFraction 缩放；explorationBudget 从运行时配置透传（spec §六.2
    // 有界消费）。off/shadow/无快照 → pairAdjustments 为 null → 缺省路径。
    const mixerFeedback =
      pairAdjustments && pairAdjustments.size > 0
        ? { pairAdjustments, explorationBudget: this.feedbackRuntime.explorationBudget }
        : undefined
    const pairs = this.mixer.mix(sources, 5, [...exploredPairs], mixStrat, mixerFeedback)

    if (pairs.length === 0) {
      // 空池只剩一种成因：stable 在"全部来源类型互异"的池子上配不出同类型
      // 对（explore/signal 的入口层回退保证非空）。调用方据此切换策略重试。
      // 旧文案 "all pairs already explored" 已不成立——罚分降权后重复生成
      // 总是到达 LLM，耗尽信号只来自策略可行性。
      const candidatePairs = (sources.length * (sources.length - 1)) / 2
      return {
        ideas: [],
        reason: `no candidate pairs for strategy "${strat}" (${sources.length} sources, ${candidatePairs} candidate pairs)`,
        strategy: strat,
        pairsAvailable: 0,
        feedback: feedbackInfo,
      }
    }

    // Generate hypotheses via LLM
    const ideas = []
    // A failed pair used to vanish: `catch {}` swallowed the exception and a
    // chatJson `{ error }` payload fell through the `if (result.data)` guard,
    // so the caller saw `ideas: []` with no explanation of whether the LLM was
    // down, the JSON was unparseable, or every pair really was a duplicate.
    const errors = []
    for (const { pair: [a, b] } of pairs) {
      const prompt = this._buildGenerationPrompt(a, b, strat, recent.slice(-10), rejected.slice(-5), feedbackBlock)
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
          // P3-R5（task 0946ba33）：generate 路径补写 provenance——本路径的
          // 每条假设都诞生于恰好一个概念对，来源身份与 mixer pairAdjustments
          // 同一规则（sourceConceptId：origin 优先，缺失回退 name:<name>，
          // types.ts 概念身份）。由此 ferment/adopt 的终局事件可归因到对
          // （isAttributable 不变），terminal 假设参与 pair precision@K 链接；
          // 其他路径的模板/legacy 兜底假设无 provenance，仍按 R5 记
          // hypothesis_only——对称规则不破。
          provenance: {
            strategy: strat,
            sources: [a, b].map((src) => ({
              name: src.name,
              type: src.type,
              origin: src.origin || `name:${src.name}`,
              ...(src.timestamp ? { timestamp: src.timestamp } : {}),
            })),
            generatedAt: isoOf(Date.now()),
          },
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

    return { ideas, strategy: strat, pairsAttempted: pairs.length, errors, feedback: feedbackInfo }
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

        // 正向反馈闭环 P0：ferment 终局追加证据事件（validated/rejected）。
        // sourceId 按 ferment 轮次确定 → 同轮重放幂等；keep/merge 不产事件。
        // 只写 JSONL 交换层，不改假设状态、不进晋级门。
        if (patch.status === 'validated' || patch.status === 'rejected') {
          const feedback = this.feedbackEvents.append({
            hypothesisId: h.id,
            eventType: patch.status,
            sourceType: 'experiment',
            sourceId: `ferment:${h.id}:${patch.fermentCount}`,
            evidenceRef: typeof result.data.reason === 'string' ? result.data.reason.slice(0, 200) : undefined,
          })
          if (!feedback.appended && !feedback.deduped && feedback.quarantine) {
            errors.push({ id: h.id, title: h.title, error: `feedback quarantine: ${feedback.quarantine.reason}` })
          }
        }

        results.push({ id: h.id, title: h.title, verdict, reason: result.data.reason })
      } catch (err) {
        errors.push({ id: h.id, title: h.title, error: String((err && err.message) || err) })
      }
    }

    return { fermented: results.length, results, errors }
  }

  // Fresh per call: both evidence files are append-only and a long-lived MCP
  // server must see new adopt events / memory tags without a restart (same
  // rationale as the insight-store mtime cache -- minus the cache, since this
  // is two small file reads on a read-only report path).
  _adoption() {
    const { claimed, evidenced } = readAdoptionEvidence(path.dirname(this.dataDir))
    const storedIds = new Set(this.store.getHypotheses().map((h) => h.id))
    const adoptedIds = new Set()
    for (const id of [...claimed, ...evidenced]) {
      if (storedIds.has(id)) adoptedIds.add(id)
    }
    return { claimed, evidenced, adoptedIds }
  }

  status() {
    const count = this.store.count()
    const active = this.store.getHypotheses({ status: 'active' })
    const validated = this.store.getHypotheses({ status: 'validated' })
    const rejected = this.store.getHypotheses({ status: 'rejected' })
    // draft is a real state -- ferment() reviews draft + active -- so hiding it
    // here made `status` and `list --status draft` disagree.
    const draft = this.store.getHypotheses({ status: 'draft' })
    const adoption = this._adoption()

    return {
      ...count,
      active: active.length,
      validated: validated.length,
      rejected: rejected.length,
      draft: draft.length,
      // Derived join of the two evidence axes (see readAdoptionEvidence).
      // metric:false is load-bearing: this is NOT an ADR-017 evaluation metric,
      // so no rate and no threshold are reported -- adoption rate was explicitly
      // out of scope (D3). sources names the backing files, routeAdoption style.
      adoption: {
        adopted: adoption.adoptedIds.size,
        claimed: adoption.claimed.size,
        evidenced: adoption.evidenced.size,
        metric: false,
        note:
          'derived join of creativity.adopt events and hypothesis:<id> memory tags — informational; no rate or threshold by design',
        sources: ADOPTION_SOURCES,
      },
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
    // Same read-side join as status(): every row carries `adopted` so the two
    // surfaces cannot disagree (the CLI/MCP entry points already share this
    // engine). listRow() stays the pure store-row shape; decoration is here.
    const adoption = this._adoption()
    const decorate = (row) => ({ ...row, adopted: adoption.adoptedIds.has(row.id) })
    if (opts.sort === 'novelty') {
      // Relative novelty ranking (read-only, nothing written back). Pairwise
      // Jaccard is O(n²) — bound candidates to the newest 200 (spec Risk 3).
      const candidates = this.store.getHypotheses({ status: opts.status }).slice(-200)
      const rows = candidates.map((h) => {
        const others = candidates.filter((x) => x.id !== h.id)
        const verdict = evaluateNovelty(h, others, [])
        return { ...listRow(h), noveltyScore: verdict.adjustedNovelty }
      })
      rows.sort((a, b) => b.noveltyScore - a.noveltyScore || (b.createdAt || 0) - (a.createdAt || 0))
      const decorated = rows.map(decorate)
      return limit === 0 ? decorated : decorated.slice(0, limit)
    }
    return this.store
      .getHypotheses({ status: opts.status, limit })
      .map(listRow)
      .map(decorate)
  }

  _buildGenerationPrompt(a, b, strategy, recentHypotheses, rejectedHypotheses, feedbackBlock) {
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

    // 正向反馈闭环 P2：结构化快照块（已验证来源 + 失败边界）。缺省 = 提示词不变。
    if (feedbackBlock) {
      const { buildFeedbackBlockSection } = require('@akemi-mio/creativity/CreativityPrompt')
      prompt += `\n${buildFeedbackBlockSection(feedbackBlock)}`
    }

    prompt += `\nOutput JSON: {"title": "...", "idea": "...", "expectedBenefit": "...", "risk": "...", "novelty": 0-100, "feasibility": 0-100, "impact": 0-100, "logic": 0-100}`
    return prompt
  }
}

// Adoption evidence (idea b19bada4, design discussion 1d2e22e4 D1/D4): the
// store never gains an `adopted` status -- adoption is a relation between a
// stored hypothesis and the outside world, not an attribute of the hypothesis,
// so it lives as an append-only `creativity.adopt` trace event, optionally
// cross-checked against a memory record carrying the `hypothesis:<id>` tag.
// The host (MCP or CLI) passes its own ingestObservation so both entry points
// write byte-identical events; dataRoot is the directory holding memory.jsonl
// and traces.jsonl -- the engine sits in <dataRoot>/creativity on both hosts
// (see cliCreativityEngine in bin/mio.js). Every validation failure happens
// before ingest, so a rejected call never pollutes the event stream. This
// function writes traces only: it never touches memory.jsonl (the
// generate/ferment write nothing to Memory boundary extends here).
function adoptHypothesis(engine, args = {}, ingest, dataRoot) {
  const hypothesisId = String(args.hypothesisId || '').trim()
  if (!hypothesisId) {
    throw new Error('mio.creativity.adopt requires hypothesisId: a stored hypothesis UUID')
  }
  if (!engine.store.getHypotheses().some((h) => h.id === hypothesisId)) {
    throw new Error(`mio.creativity.adopt: no stored hypothesis with id "${hypothesisId}"`)
  }
  const memoryId = String(args.memoryId || '').trim()
  if (memoryId) {
    const memoryPath = path.join(dataRoot, 'memory.jsonl')
    const records = fs.existsSync(memoryPath)
      ? fs
          .readFileSync(memoryPath, 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            try { return JSON.parse(line) } catch { return null }
          })
          .filter(Boolean)
      : []
    const record = records.find((r) => r && r.id === memoryId)
    if (!record) {
      throw new Error(`mio.creativity.adopt: no memory record with id "${memoryId}"`)
    }
    const tag = `hypothesis:${hypothesisId}`
    if (!Array.isArray(record.tags) || !record.tags.includes(tag)) {
      throw new Error(`mio.creativity.adopt: memory record "${memoryId}" is missing tag "${tag}"`)
    }
  }
  if (typeof ingest !== 'function') {
    throw new Error('mio.creativity.adopt: ingest is not available on this host')
  }
  const taskId = String(args.taskId || '').trim()
  const note = String(args.note || '').trim()
  const occurredAt = Date.now()
  const result = ingest({
    trace_id: `creativity-adopt:${hypothesisId}:${occurredAt}`,
    event_type: 'creativity.adopt',
    outcome: 'success',
    payload: {
      hypothesisId,
      ...(memoryId ? { memoryId } : {}),
      ...(taskId ? { taskId } : {}),
      ...(note ? { note } : {}),
    },
  })
  // 正向反馈闭环 P0：adopt 是选择证据（weight 0.2 档），追加 adopted 事件到
  // feedback-events.jsonl 交换层。store 状态不变（D1），不写 Memory（D4）。
  // 每次有意的 adopt 调用各记一条事件；P1 聚合时在假设级归并，不虚增样本。
  const feedback = engine.feedbackEvents.append({
    hypothesisId,
    eventType: 'adopted',
    sourceType: 'adoption',
    sourceId: `adopt:${hypothesisId}:${occurredAt}`,
    ...(memoryId ? { evidenceRef: `memory:${memoryId}` } : {}),
    occurredAt,
  })
  return {
    recorded: true,
    hypothesisId,
    event: (result && result.event) || result,
    feedback: { appended: feedback.appended, deduped: feedback.deduped },
  }
}

module.exports = { CreativityEngine, CreativityStore, sourcesFromInsights, isoOf, adoptHypothesis }
