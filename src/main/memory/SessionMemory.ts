/**
 * SessionMemory — ADR-013 Session Memory Architecture
 *
 * Phase 1: Observable memory infrastructure.
 * - Compaction: rule-based, triggered after reply
 * - Retrieval: scoring with Attention fallback
 * - EvaluationEvent: observation only, no context injection
 *
 * Phase 1 invariant:
 *   Retrieval available ≠ Context injection enabled
 */

import { log } from '../logger/Logger'
import { getRawDb, markDirty } from '../db/connection'
import { getMessagesBySession, getSessions } from '../db/messages'
import type { StoredMessage } from '../db/messages'
import type { EvaluationEmitter } from '../core/evaluation/EvaluationEmitter'
import type { AttentionEntity } from '../agent/WorkingMemory'

// ══════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════

export interface FactChange {
  subject: string
  type: 'new' | 'changed' | 'invalidated'
  oldValue?: string
  newValue: string
  confidence: number
}

export interface DecisionRecord {
  subject: string
  decision: string
  alternatives?: string[]
  rationale?: string
  confidence: number
}

export interface EntityRecord {
  name: string
  type: string
  salience: number
}

export type CompactionTriggerReason = 'production_threshold' | 'observation_threshold' | 'idle'

export interface SessionCompaction {
  id: string
  sessionId: string
  source: 'electron' | 'telegram'
  digest: string
  topics: string[]
  entities: EntityRecord[]
  facts: FactChange[]
  decisions: DecisionRecord[]
  unresolved: string[]
  importanceScore: number
  messageCount: number
  tokenCount: number
  sessionStartAt: number
  sessionEndAt: number
  createdAt: number
  triggerReason: CompactionTriggerReason
}

export interface RetrievalSpec {
  userText?: string
  sessionId?: string
  activeTopics?: string[]
  attentionEntities?: AttentionEntity[]
  maxTokens?: number
  includeTypes?: Array<'digest' | 'fact' | 'decision' | 'entity'>
  /** Phase 1: 仅 observation。Phase 3 后允许 'context' */
  mode?: 'observation' | 'context'
}

export interface MemoryContextBlock {
  digests: string[]
  facts: string[]
  decisions: string[]
  entities: string[]
  totalTokens: number
  sourceSessions: string[]
}

export interface MatchedFactors {
  recency: number
  attention?: number
  frequency: number
  importance: number
}

export interface RetrievalResult {
  compaction: SessionCompaction
  score: number
  matchedFactors: MatchedFactors
}

// ══════════════════════════════════════════════
// Scoring constants
// ══════════════════════════════════════════════

const SCORE_RECENCY_WEIGHT = 0.4
const SCORE_ATTENTION_WEIGHT = 0.3
const SCORE_FREQUENCY_WEIGHT = 0.2
const SCORE_IMPORTANCE_WEIGHT = 0.1

const FALLBACK_RECENCY_WEIGHT = 0.55
const FALLBACK_FREQUENCY_WEIGHT = 0.25
const FALLBACK_IMPORTANCE_WEIGHT = 0.20

const RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const DEFAULT_MAX_TOKENS = 800

// ══════════════════════════════════════════════
// Compaction trigger thresholds
// ══════════════════════════════════════════════

const COMPACT_MESSAGE_THRESHOLD = 50
const OBSERVATION_COMPACT_THRESHOLD = 10
const COMPACT_IDLE_MS = 30 * 60 * 1000 // 30 min idle triggers compaction
const COMPACT_IDLE_FALLBACK_MS = 4 * 60 * 60 * 1000 // 4h idle for timer cleanup

// ══════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════

const TOPIC_KEYWORDS: Record<string, string[]> = {
  architecture: ['架构', '设计', 'architecture', 'design', 'refactor', '重构'],
  evaluation: ['evaluation', '评估', 'guardrail', 'metric', 'metric', 'fitness'],
  memory: ['记忆', 'memory', 'remember', '记住', 'recall'],
  evolution: ['进化', 'evolution', '演化', '自改进'],
  writing: ['写作', 'writing', '文章', '创作', 'blog'],
  coding: ['代码', 'code', '编程', '实现', 'function', 'bug', '修复'],
  tool: ['工具', 'tool', 'mcp', '插件', 'plugin'],
  chat: ['聊天', 'chat', '日常', '闲聊'],
  tts: ['语音', 'tts', 'voice', '朗读', '发音'],
  config: ['配置', 'config', '设置', 'setting'],
}

function extractTopics(text: string): string[] {
  const matched = new Set<string>()
  const lower = text.toLowerCase()
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        matched.add(topic)
        break
      }
    }
  }
  return Array.from(matched)
}

function extractEntities(messages: StoredMessage[]): EntityRecord[] {
  const entityMap = new Map<string, { count: number; types: Set<string> }>()
  const filePattern = /[\w-]+\/[\w./-]+\.\w+/g
  const conceptPattern = /「(.+?)」|"([^"]+)"|#(\w+)/g

  for (const msg of messages) {
    // File paths
    const files = msg.content.match(filePattern)
    if (files) {
      for (const f of files) {
        const existing = entityMap.get(f) || { count: 0, types: new Set<string>() }
        existing.count++
        existing.types.add('file')
        entityMap.set(f, existing)
      }
    }
    // Concepts
    const concepts = msg.content.matchAll(conceptPattern)
    for (const c of concepts) {
      const name = (c[1] || c[2] || c[3]).trim()
      if (name.length > 1) {
        const existing = entityMap.get(name) || { count: 0, types: new Set<string>() }
        existing.count++
        existing.types.add('concept')
        entityMap.set(name, existing)
      }
    }
  }

  const total = messages.length
  return Array.from(entityMap.entries())
    .map(([name, info]) => ({
      name,
      type: info.types.has('file') ? 'file' : 'concept',
      salience: Math.min(1, info.count / Math.max(1, total)),
    }))
    .sort((a, b) => b.salience - a.salience)
    .slice(0, 15)
}

function estimateTokenCount(texts: string[]): number {
  let total = 0
  for (const t of texts) {
    // Rough estimate: ~2 chars per token for CJK, ~4 for ASCII
    let cjk = 0
    let ascii = 0
    for (const ch of t) {
      const code = ch.charCodeAt(0)
      if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) {
        cjk++
      } else {
        ascii++
      }
    }
    total += Math.ceil(cjk / 2) + Math.ceil(ascii / 4)
  }
  return total
}

function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean))
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean))
  if (setA.size === 0 || setB.size === 0) return 0
  const intersection = new Set([...setA].filter((x) => setB.has(x)))
  const union = new Set([...setA, ...setB])
  return intersection.size / union.size
}

// ══════════════════════════════════════════════
// SessionMemory
// ══════════════════════════════════════════════

export class SessionMemory {
  private emitter: EvaluationEmitter | null = null
  /** 当前轮次的 attention entities（由 ChatExecutor 注入） */
  private currentAttention: AttentionEntity[] = []

  setEvaluationEmitter(emitter: EvaluationEmitter): void {
    this.emitter = emitter
  }

  /** 每轮由 ChatExecutor 注入当前 attention */
  setAttention(entities: AttentionEntity[]): void {
    this.currentAttention = entities
  }

  // ══════════════════════════════════════════════
  // Compaction
  // ══════════════════════════════════════════════

  /**
   * 检查是否需要 compaction（reply 完成后调用）。
   * Trigger 条件：消息数超阈值 OR idle 超时。
   * 失败时不影响主流程——Memory 是辅助系统，不是 Runtime dependency。
   */
  checkCompaction(sessionId: string, source: 'electron' | 'telegram'): void {
    try {
      const messages = getMessagesBySession(sessionId)
      if (messages.length === 0) return

      // 是否已有 compaction
      const existing = this.getCompactionsBySession(sessionId)

      // ── Observation-only trigger ──
      // Phase 1 Observation Window: 在生产阈值 (50) 达到前先用观测阈值 (10) 验证链路闭环。
      // 仅首次 compaction 生效，trigger_reason='observation_threshold' 区分二者。
      // 这不是优化 policy，是建立可观测实验条件。
      if (existing.length === 0 && messages.length >= OBSERVATION_COMPACT_THRESHOLD) {
        this.compact(sessionId, source, messages, 'observation_threshold')
        return
      }

      if (existing.length > 0) {
        // 已有 compaction，检查新增消息是否达到 re-compact 次级阈值（当前 25）
        const lastCompact = existing[existing.length - 1]
        const newMessages = messages.filter((m) => m.createdAt > lastCompact.sessionEndAt)
        if (newMessages.length < COMPACT_MESSAGE_THRESHOLD / 2) {
          return
        }
      } else if (messages.length < COMPACT_MESSAGE_THRESHOLD) {
        // 首次 compaction 需要足够消息（已被 observation trigger 拦截，到这里说明 < 10）
        return
      }

      this.compact(sessionId, source, messages, 'production_threshold')
    } catch (err) {
      log('WARN', 'session_memory_check_compaction_failed', { sessionId, error: String(err) })
      // Memory 是辅助系统，failure 不影响主流程
      this.emitCompactionFailed(sessionId, String(err), getMessagesBySession(sessionId).length)
    }
  }

  /**
   * 按需 compact（主动触发）。
   */
  compact(sessionId: string, source: 'electron' | 'telegram', rawMessages?: StoredMessage[], triggerReason?: CompactionTriggerReason): SessionCompaction | null {
    try {
      const messages = rawMessages ?? getMessagesBySession(sessionId)
      if (messages.length === 0) return null

      const userMessages = messages.filter((m) => m.role === 'user')
      const assistantMessages = messages.filter((m) => m.role === 'assistant')
      const allText = messages.map((m) => m.content).join('\n')

      // Extract topics
      const topics = extractTopics(allText)

      // Extract entities
      const entities = extractEntities(messages)

      // Rule-based digest: key user messages + assistant highlights
      const digest = this.buildDigest(userMessages, assistantMessages)

      // Importance score based on topic diversity, entity count, message length
      const importanceScore = this.calcImportance(topics, entities, messages)

      // Facts & decisions — rule-based extraction (Phase 1, no LLM)
      const facts = this.extractFacts(userMessages)
      const decisions = this.extractDecisions(messages)

      // Unresolved items
      const unresolved = this.extractUnresolved(messages)

      const sessionStartAt = messages[0].createdAt
      const sessionEndAt = messages[messages.length - 1].createdAt
      const tokenCount = estimateTokenCount([digest])
      const id = `sc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

      const compaction: SessionCompaction = {
        id,
        sessionId,
        source,
        digest,
        topics,
        entities,
        facts,
        decisions,
        unresolved,
        importanceScore,
        messageCount: messages.length,
        tokenCount,
        sessionStartAt,
        sessionEndAt,
        createdAt: Date.now(),
        triggerReason: triggerReason ?? 'production_threshold',
      }

      this.saveCompaction(compaction)
      log('INFO', 'session_memory_compacted', {
        sessionId,
        messages: messages.length,
        topics: topics.length,
        entities: entities.length,
        facts: facts.length,
        decisions: decisions.length,
        importanceScore,
        triggerReason,
      })

      return compaction
    } catch (err) {
      log('WARN', 'session_memory_compact_failed', { sessionId, error: String(err) })
      return null
    }
  }

  /**
   * Timer cleanup — 对长期未活动的 session 做 compaction + 关闭。
   * 不负责主要 compaction 触发（主路径是 reply 后 checkCompaction）。
   */
  cleanupStaleSessions(): void {
    try {
      const sessions = getSessions()
      const now = Date.now()
      for (const s of sessions) {
        if (now - s.lastActivityAt > COMPACT_IDLE_FALLBACK_MS) {
          const existing = this.getCompactionsBySession(s.id)
          if (existing.length === 0) {
            log('INFO', 'session_memory_cleanup_compact', { sessionId: s.id })
            this.compact(s.id, s.source === 'telegram' ? 'telegram' : 'electron', undefined, 'idle')
          }
        }
      }
    } catch (err) {
      log('WARN', 'session_memory_cleanup_failed', { error: String(err) })
    }
  }

  // ══════════════════════════════════════════════
  // Retrieval
  // ══════════════════════════════════════════════

  /**
   * 检索与当前上下文相关的 session digests。
   * Phase 1: passive observation — 返回结果但 caller 不注入 context。
   * mode='context' 在 Phase 3 前禁用。
   * Phase 2: 每次检索后 emit memory.retrieval.scored / memory.scoring.attention_gap
   */
  retrieve(spec: RetrievalSpec): RetrievalResult[] {
    if (spec.mode === 'context') {
      log('WARN', 'session_memory_context_mode_blocked', { msg: 'Phase 1 invariant: context injection disabled by ADR-013' })
      return []
    }
    try {
      const allCompactions = this.getAllCompactions()
      if (allCompactions.length === 0) return []

      const scored = allCompactions
        .map((c) => {
          const matchedFactors = this.computeFactors(c, spec)
          const score = this.computeScore(matchedFactors, !!spec.attentionEntities?.length)
          return { compaction: c, score, matchedFactors }
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)

      // Token budget cut
      const maxTokens = spec.maxTokens ?? DEFAULT_MAX_TOKENS
      let tokenBudget = maxTokens
      const results: RetrievalResult[] = []

      for (const r of scored) {
        const estimate = r.compaction.tokenCount || estimateTokenCount([r.compaction.digest])
        if (estimate > tokenBudget) continue
        results.push(r)
        tokenBudget -= estimate
      }

      // Phase 2: emit scoring quality events (after token cut — reflects actual selection)
      this.emitScoringEvent(scored, results, maxTokens, allCompactions.length, spec)

      return results
    } catch (err) {
      log('WARN', 'session_memory_retrieve_failed', { error: String(err) })
      return []
    }
  }

  /** 构建 MemoryContextBlock（供 ChatExecutor 被动读取） */
  buildContext(spec: RetrievalSpec): MemoryContextBlock {
    const results = this.retrieve({ ...spec, mode: spec.mode ?? 'observation' })

    // Emit observation event
    this.emitRetrievalEvent(results, spec.sessionId || '')

    if (results.length === 0) {
      return {
        digests: [],
        facts: [],
        decisions: [],
        entities: [],
        totalTokens: 0,
        sourceSessions: [],
      }
    }

    const digests = results.map((r) => r.compaction.digest)
    const facts = results.flatMap((r) => r.compaction.facts.map((f) => `[${f.type}] ${f.subject}: ${f.newValue}`))
    const decisions = results.flatMap((r) => r.compaction.decisions.map((d) => `${d.subject}: ${d.decision}`))
    const entities = results.flatMap((r) => r.compaction.entities.map((e) => e.name))
    const sourceSessions = [...new Set(results.map((r) => r.compaction.sessionId))]

    return {
      digests,
      facts,
      decisions,
      entities: [...new Set(entities)],
      totalTokens: results.reduce((s, r) => s + (r.compaction.tokenCount || 0), 0),
      sourceSessions,
    }
  }

  // ══════════════════════════════════════════════
  // Internal: Scoring
  // ══════════════════════════════════════════════

  private computeFactors(compaction: SessionCompaction, spec: RetrievalSpec): MatchedFactors {
    const now = Date.now()

    // Recency: linear decay over 7 days
    const age = now - compaction.sessionEndAt
    const recency = Math.max(0, Math.min(1, 1 - age / RECENCY_HALF_LIFE_MS))

    // Frequency: topic overlap with spec
    let frequency = 0
    const specTopics = spec.activeTopics ?? []
    if (specTopics.length > 0 && compaction.topics.length > 0) {
      const intersection = specTopics.filter((t) => compaction.topics.includes(t))
      frequency = intersection.length / Math.max(1, specTopics.length)
    }

    // Importance
    const importance = compaction.importanceScore

    // Attention
    let attention: number | undefined
    const attentionEntities = spec.attentionEntities ?? this.currentAttention
    if (attentionEntities.length > 0 && compaction.entities.length > 0) {
      const entityNames = new Set(compaction.entities.map((e) => e.name.toLowerCase()))
      const matches = attentionEntities.filter((e) => entityNames.has(e.name.toLowerCase()))
      attention = matches.reduce((s, e) => s + e.relevance, 0) / attentionEntities.length
    }

    return { recency, attention, frequency, importance }
  }

  private computeScore(factors: MatchedFactors, hasAttention: boolean): number {
    if (hasAttention && factors.attention !== undefined) {
      return (
        SCORE_RECENCY_WEIGHT * factors.recency +
        SCORE_ATTENTION_WEIGHT * factors.attention +
        SCORE_FREQUENCY_WEIGHT * factors.frequency +
        SCORE_IMPORTANCE_WEIGHT * factors.importance
      )
    }
    // Deterministic fallback when Attention is unavailable
    return (
      FALLBACK_RECENCY_WEIGHT * factors.recency +
      FALLBACK_FREQUENCY_WEIGHT * factors.frequency +
      FALLBACK_IMPORTANCE_WEIGHT * factors.importance
    )
  }

  // ══════════════════════════════════════════════
  // Internal: Rule-based extraction
  // ══════════════════════════════════════════════

  private buildDigest(userMessages: StoredMessage[], assistantMessages: StoredMessage[]): string {
    const parts: string[] = []

    // Key user intents (first sentence of each user message)
    const keyIntents = userMessages
      .map((m) => m.content.replace(/[。！？，、\n]/g, ' ').trim().slice(0, 100))
      .filter((t, i, a) => a.indexOf(t) === i) // dedup
      .slice(0, 5)
    if (keyIntents.length > 0) {
      parts.push(`用户关注：${keyIntents.join('；')}`)
    }

    // Assistant key responses
    const keyResponses = assistantMessages
      .filter((m) => m.content.length > 20)
      .map((m) => m.content.replace(/\n/g, ' ').trim().slice(0, 120))
      .slice(0, 3)
    if (keyResponses.length > 0) {
      parts.push(`助手回应：${keyResponses.join('；')}`)
    }

    return parts.join('\n')
  }

  private extractFacts(userMessages: StoredMessage[]): FactChange[] {
    const facts: FactChange[] = []
    const rememberPatterns = [
      /记住[：:，,\s]*(.+)/,
      /记下[：:，,\s]*(.+)/,
      /别忘了[：:，,\s]*(.+)/,
      /我叫[：:，,\s]*(.+)/,
      /我是[：:，,\s]*(.+)/,
      /我喜欢[：:，,\s]*(.+)/,
      /我用[：:，,\s]*(.+)/,
      /我决定[：:，,\s]*(.+)/,
      /改成[：:，,\s]*(.+)/,
      /换[成用][：:，,\s]*(.+)/,
    ]

    for (const msg of userMessages) {
      for (const pattern of rememberPatterns) {
        const match = msg.content.match(pattern)
        if (match) {
          facts.push({
            subject: match[1].slice(0, 80),
            type: 'new',
            newValue: match[1].slice(0, 200),
            confidence: 0.7,
          })
        }
      }
    }

    return facts
  }

  private extractDecisions(messages: StoredMessage[]): DecisionRecord[] {
    const decisions: DecisionRecord[] = []
    const decisionPatterns = [
      /决定[：:，,\s]*(.+)/,
      /选[用择][：:，,\s]*(.+)/,
      /采用[：:，,\s]*(.+)/,
      /不[用要][：:，,\s]*(.+)/,
      /抛弃[：:，,\s]*(.+)/,
    ]

    const allText = messages.map((m) => m.content).join('\n')
    for (const pattern of decisionPatterns) {
      const match = allText.match(pattern)
      if (match) {
        decisions.push({
          subject: match[1].slice(0, 60),
          decision: match[1].slice(0, 200),
          confidence: 0.6,
        })
      }
    }

    return decisions
  }

  private extractUnresolved(messages: StoredMessage[]): string[] {
    const unresolved: string[] = []
    const questionPatterns = [
      /怎[么样]解决/,
      /有[什么]办法/,
      /待解决/,
      /还没[做搞好处理]/,
      /下一步/,
      /TODO/,
      /todo/,
      /未完成/,
    ]

    for (const msg of messages) {
      if (msg.role === 'user') {
        for (const pattern of questionPatterns) {
          if (pattern.test(msg.content)) {
            const snippet = msg.content.replace(/\n/g, ' ').trim().slice(0, 100)
            if (!unresolved.includes(snippet)) {
              unresolved.push(snippet)
            }
            break
          }
        }
      }
    }

    return unresolved.slice(0, 5)
  }

  private calcImportance(topics: string[], entities: EntityRecord[], messages: StoredMessage[]): number {
    const topicScore = Math.min(1, topics.length / 5)
    const entityScore = Math.min(1, entities.length / 10)
    const messageScore = Math.min(1, messages.length / 100)
    const decisionCount = this.extractDecisions(messages).length
    const decisionScore = Math.min(1, decisionCount / 3)
    const hasUserFacts = messages.filter((m) => /记住|决定|改[成用]/.test(m.content)).length > 0
    const factBoost = hasUserFacts ? 0.15 : 0

    return Math.min(1, 0.25 * topicScore + 0.25 * entityScore + 0.2 * messageScore + 0.3 * decisionScore + factBoost)
  }

  // ══════════════════════════════════════════════
  // Internal: Event emission
  // ══════════════════════════════════════════════

  private emitRetrievalEvent(results: RetrievalResult[], sessionId: string): void {
    if (!this.emitter) return

    if (results.length === 0) {
      this.emitter.emit(
        'session.digest.retrieved_noop' as any,
        {
          type: 'session.digest.retrieved_noop',
          matchedCount: 0 as const,
          sessionId,
        } as any,
        { sessionId },
      )
      return
    }

    for (const r of results.slice(0, 3)) {
      this.emitter.emit(
        'session.digest.retrieved' as any,
        {
          type: 'session.digest.retrieved',
          sessionId: r.compaction.sessionId,
          digestId: r.compaction.id,
          score: r.score,
          matchedFactors: r.matchedFactors,
          tokenEstimate: r.compaction.tokenCount,
          sourceSessionId: r.compaction.sessionId,
        } as any,
        { sessionId },
      )
    }
  }

  private emitCompactionFailed(sessionId: string, error: string, messageCount: number): void {
    if (!this.emitter) return
    this.emitter.emit(
      'memory.compaction.failed' as any,
      {
        type: 'memory.compaction.failed',
        sessionId,
        error,
        messageCount,
      } as any,
      { sessionId },
    )
  }

  /** Phase 2: emit memory.retrieval.scored + memory.scoring.attention_gap */
  private emitScoringEvent(
    /** All scored results (pre-token-cut) */
    scored: Array<{ score: number; matchedFactors: any }>,
    /** Selected results (post-token-cut) */
    results: RetrievalResult[],
    tokenBudget: number,
    totalCompactions: number,
    spec: RetrievalSpec,
  ): void {
    if (!this.emitter) return

    const sessionId = spec.sessionId || ''
    const scoredCount = scored.length
    const attentionAvailable = !!spec.attentionEntities?.length

    // Score distribution
    const scores = scored.map((r) => r.score)
    const min = scores.length > 0 ? Math.min(...scores) : 0
    const max = scores.length > 0 ? Math.max(...scores) : 0
    const avg = scores.length > 0 ? scores.reduce((s, v) => s + v, 0) / scores.length : 0
    const sorted = [...scores].sort((a, b) => a - b)
    const median = sorted.length > 0
      ? sorted.length % 2 === 0
        ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        : sorted[Math.floor(sorted.length / 2)]
      : 0

    // Top 3 scores
    const topScores = [...scores]
      .sort((a, b) => b - a)
      .slice(0, 3)

    // Token utilization
    const tokenUtilized = results.reduce((s, r) => s + (r.compaction.tokenCount || 0), 0)

    this.emitter.emit(
      'memory.retrieval.scored' as any,
      {
        type: 'memory.retrieval.scored',
        sessionId,
        specSessionId: spec.sessionId || undefined,
        totalCompactions,
        scoredCount,
        attentionAvailable,
        scoreDistribution: { min, max, avg, median },
        topScores,
        tokenBudget,
        tokenUtilized,
        resultCount: results.length,
      } as any,
      { sessionId },
    )

    // attention_gap: only when both branches possible and attention is available
    if (attentionAvailable && scoredCount > 0 && this.currentAttention && this.currentAttention.length > 0) {
      const top = scored[0]
      const factors = top.matchedFactors as any
      // Recompute without attention to measure gap (pass [] to disable attention branch)
      const fallbackFactors = this.computeFactors(
        top.compaction,
        { ...spec, attentionEntities: [] },
      )
      const fallbackScore = this.computeScore(fallbackFactors, false)

      this.emitter.emit(
        'memory.scoring.attention_gap' as any,
        {
          type: 'memory.scoring.attention_gap',
          sessionId,
          attentionScore: top.score,
          fallbackScore,
          gap: Math.abs(top.score - fallbackScore),
          attentionFactors: {
            recency: factors.recency ?? 0,
            attention: factors.attention ?? 0,
            frequency: factors.frequency ?? 0,
            importance: factors.importance ?? 0,
          },
          fallbackFactors: {
            recency: fallbackFactors.recency ?? 0,
            frequency: fallbackFactors.frequency ?? 0,
            importance: fallbackFactors.importance ?? 0,
          },
          attentionEntityCount: this.currentAttention.length,
        } as any,
        { sessionId },
      )
    }
  }

  // ══════════════════════════════════════════════
  // Internal: Persistence
  // ══════════════════════════════════════════════

  private saveCompaction(c: SessionCompaction): void {
    try {
      const db = getRawDb()
      db.run(
        `INSERT OR IGNORE INTO session_compactions
         (id, session_id, source, digest, topics, entities, facts, decisions, unresolved,
          importance_score, message_count, token_count, session_start_at, session_end_at, created_at, trigger_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          c.id, c.sessionId, c.source, c.digest,
          JSON.stringify(c.topics), JSON.stringify(c.entities),
          JSON.stringify(c.facts), JSON.stringify(c.decisions),
          JSON.stringify(c.unresolved),
          c.importanceScore, c.messageCount, c.tokenCount,
          c.sessionStartAt, c.sessionEndAt, c.createdAt,
          c.triggerReason,
        ],
      )
      markDirty()
    } catch (err) {
      log('WARN', 'session_memory_save_failed', { sessionId: c.sessionId, error: String(err) })
    }
  }

  getCompactionsBySession(sessionId: string): SessionCompaction[] {
    try {
      const db = getRawDb()
      const result = db.exec(
        `SELECT * FROM session_compactions WHERE session_id = ? ORDER BY created_at DESC`,
        [sessionId],
      )
      return this.parseCompactionRows(result)
    } catch (err) {
      log('WARN', 'session_memory_get_failed', { sessionId, error: String(err) })
      return []
    }
  }

  getAllCompactions(): SessionCompaction[] {
    try {
      const db = getRawDb()
      const result = db.exec(
        'SELECT * FROM session_compactions ORDER BY session_end_at DESC',
      )
      return this.parseCompactionRows(result)
    } catch (err) {
      log('WARN', 'session_memory_get_all_failed', { error: String(err) })
      return []
    }
  }

  private parseCompactionRows(
    result: Array<{ columns: string[]; values: any[][] }>,
  ): SessionCompaction[] {
    if (!result || !result.length || !result[0].values.length) return []
    const columns = result[0].columns
    return result[0].values.map((v: any[]) => {
      const obj: Record<string, any> = {}
      for (let i = 0; i < columns.length; i++) obj[columns[i]] = v[i]
      const parseJson = (val: any, fallback: any) => {
        if (val === null || val === undefined) return fallback
        if (Array.isArray(val)) return val
        try { return JSON.parse(val) } catch { return fallback }
      }
      return {
        id: obj.id,
        sessionId: obj.session_id,
        source: obj.source as 'electron' | 'telegram',
        digest: obj.digest,
        topics: parseJson(obj.topics, []),
        entities: parseJson(obj.entities, []),
        facts: parseJson(obj.facts, []),
        decisions: parseJson(obj.decisions, []),
        unresolved: parseJson(obj.unresolved, []),
        importanceScore: obj.importance_score ?? 0.5,
        messageCount: obj.message_count ?? 0,
        tokenCount: obj.token_count ?? 0,
        sessionStartAt: obj.session_start_at,
        sessionEndAt: obj.session_end_at,
        createdAt: obj.created_at,
        triggerReason: (obj.trigger_reason ?? 'production_threshold') as CompactionTriggerReason,
      } as SessionCompaction
    })
  }
}

// Singleton
export const sessionMemory = new SessionMemory()
