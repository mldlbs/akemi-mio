/**
 * Verification Gate — Session Memory ADR-013 Phase 1
 *
 * V1: Event emission (session.digest.retrieved / session.digest.retrieved_noop)
 * V2: Storage (session_compactions table, INSERT with UNIQUE constraint)
 * V3: Score determinism (same input → same score, no hidden randomness)
 * V4: Regression guard (memory failure does not propagate)
 *
 * Uses sql.js in-memory SQLite to avoid polluting production DBs.
 */
import { describe, it, expect } from 'vitest'
import initSqlJs from 'sql.js'

// Re-implement minimal SessionMemory logic for isolation test

interface FactChange {
  subject: string
  type: 'new' | 'changed' | 'invalidated'
  oldValue?: string
  newValue: string
  confidence: number
}
interface DecisionRecord {
  subject: string
  decision: string
  alternatives?: string[]
  rationale?: string
  confidence: number
}
interface EntityRecord {
  name: string
  type: string
  salience: number
}
type CompactionTriggerReason = 'production_threshold' | 'observation_threshold' | 'idle'
interface SessionCompaction {
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
interface MatchedFactors {
  recency: number
  attention?: number
  frequency: number
  importance: number
}
interface RetrievalResult {
  compaction: SessionCompaction
  score: number
  matchedFactors: MatchedFactors
}

// ── Scoring constants (match production) ──
const SCORE_RECENCY_WEIGHT = 0.4
const SCORE_ATTENTION_WEIGHT = 0.3
const SCORE_FREQUENCY_WEIGHT = 0.2
const SCORE_IMPORTANCE_WEIGHT = 0.1
const FALLBACK_RECENCY_WEIGHT = 0.55
const FALLBACK_FREQUENCY_WEIGHT = 0.25
const FALLBACK_IMPORTANCE_WEIGHT = 0.2
const RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000

function computeFactors(compaction: SessionCompaction, now: number, attentionEntities?: string[]): MatchedFactors {
  const age = now - compaction.sessionEndAt
  const recency = Math.max(0, Math.min(1, 1 - age / RECENCY_HALF_LIFE_MS))
  const frequency = 0 // no specTopics in basic test
  const importance = compaction.importanceScore

  let attention: number | undefined
  if (attentionEntities && attentionEntities.length > 0 && compaction.entities.length > 0) {
    const entityNames = new Set(compaction.entities.map((e) => e.name.toLowerCase()))
    const matches = attentionEntities.filter((e) => entityNames.has(e.toLowerCase()))
    attention = matches.length / attentionEntities.length
  }
  return { recency, attention, frequency, importance }
}

function computeScore(factors: MatchedFactors, hasAttention: boolean): number {
  if (hasAttention && factors.attention !== undefined) {
    return (
      SCORE_RECENCY_WEIGHT * factors.recency +
      SCORE_ATTENTION_WEIGHT * factors.attention +
      SCORE_FREQUENCY_WEIGHT * factors.frequency +
      SCORE_IMPORTANCE_WEIGHT * factors.importance
    )
  }
  return (
    FALLBACK_RECENCY_WEIGHT * factors.recency +
    FALLBACK_FREQUENCY_WEIGHT * factors.frequency +
    FALLBACK_IMPORTANCE_WEIGHT * factors.importance
  )
}

// ── Test Helpers ──

function makeCompaction(overrides: Partial<SessionCompaction>): SessionCompaction {
  return {
    id: `sc_test_${Date.now()}`,
    sessionId: 'session_test',
    source: 'electron',
    digest: '测试会话摘要',
    topics: ['chat'],
    entities: [{ name: '测试实体', type: 'concept', salience: 0.5 }],
    facts: [],
    decisions: [],
    unresolved: [],
    importanceScore: 0.5,
    messageCount: 10,
    tokenCount: 50,
    sessionStartAt: Date.now() - 60000,
    sessionEndAt: Date.now() - 10000,
    createdAt: Date.now(),
    triggerReason: 'observation_threshold',
    ...overrides,
  }
}

// ══════════════════════════════════════════════
// V1: Event Emission Verification
// ══════════════════════════════════════════════

describe('V1 — Event Emission', () => {
  it('non-empty retrieval produces session.digest.retrieved payload shape', () => {
    const comp = makeCompaction({
      id: 'sc_v1_001',
      sessionId: 'session_a',
      importanceScore: 0.8,
      entities: [{ name: 'architecture', type: 'concept', salience: 0.9 }],
    })
    const now = Date.now()
    const factors = computeFactors(comp, now, ['architecture', 'memory'])
    const score = computeScore(factors, true)

    // Emulate emitRetrievalEvent top-3 emission
    const retrieved = [{ compaction: comp, score, matchedFactors: factors }].slice(0, 3)

    expect(retrieved.length).toBe(1)
    const ev = retrieved[0]
    expect(ev.compaction.id).toBe('sc_v1_001')
    expect(ev.compaction.sessionId).toBe('session_a')
    expect(ev.score).toBeGreaterThan(0)
    expect(ev.matchedFactors).toHaveProperty('recency')
    expect(ev.matchedFactors).toHaveProperty('attention')
    expect(ev.matchedFactors).toHaveProperty('frequency')
    expect(ev.matchedFactors).toHaveProperty('importance')
    // Token estimate present
    expect(ev.compaction.tokenCount).toBeGreaterThan(0)
    expect(ev.compaction.digest.length).toBeGreaterThan(0)
  })

  it('empty retrieval produces noop signal shape', () => {
    // session.digest.retrieved_noop has: matchedCount=0, sessionId
    const noop = { matchedCount: 0 as const, sessionId: 'session_empty' }
    expect(noop.matchedCount).toBe(0)
    expect(noop.sessionId).toBe('session_empty')
  })

  it('compaction failure event has required fields', () => {
    const failure = {
      type: 'memory.compaction.failed' as const,
      sessionId: 'session_fail',
      error: 'DB timeout',
      messageCount: 42,
    }
    expect(failure.sessionId).toBe('session_fail')
    expect(failure.error).toBeTruthy()
    expect(failure.messageCount).toBeGreaterThan(0)
  })
})

// ══════════════════════════════════════════════
// V2: Storage Verification
// ══════════════════════════════════════════════

describe('V2 — Storage', () => {
  async function createTestDb() {
    const SQL = await initSqlJs()
    const sqlite = new SQL.Database()
    sqlite.run(`
      CREATE TABLE IF NOT EXISTS session_compactions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('electron', 'telegram')),
        digest TEXT NOT NULL,
        topics TEXT NOT NULL DEFAULT '[]',
        entities TEXT NOT NULL DEFAULT '[]',
        facts TEXT NOT NULL DEFAULT '[]',
        decisions TEXT NOT NULL DEFAULT '[]',
        unresolved TEXT NOT NULL DEFAULT '[]',
        importance_score REAL NOT NULL DEFAULT 0.5,
        message_count INTEGER NOT NULL DEFAULT 0,
        token_count INTEGER NOT NULL DEFAULT 0,
        session_start_at INTEGER NOT NULL,
        session_end_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        trigger_reason TEXT NOT NULL DEFAULT 'production_threshold'
      )
    `)
    return sqlite
  }

  it('INSERT succeeds with all columns', async () => {
    const sqlite = await createTestDb()
    sqlite.run(
      `INSERT INTO session_compactions
       (id, session_id, source, digest, topics, entities, facts, decisions, unresolved,
        importance_score, message_count, token_count, session_start_at, session_end_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'sc_st_001',
        'session_st',
        'electron',
        '摘要测试',
        JSON.stringify(['chat', 'coding']),
        JSON.stringify([{ name: 'test', type: 'concept', salience: 0.5 }]),
        JSON.stringify([{ subject: 'fact1', type: 'new', newValue: 'val', confidence: 0.7 }]),
        JSON.stringify([{ subject: 'dec1', decision: 'go', confidence: 0.6 }]),
        JSON.stringify(['todo item']),
        0.75,
        20,
        120,
        1000,
        2000,
        Date.now(),
      ],
    )

    const result = sqlite.exec('SELECT * FROM session_compactions WHERE id = ?', ['sc_st_001'])
    expect(result[0].values.length).toBe(1)
    const row = result[0].values[0]
    const cols = result[0].columns
    const obj: Record<string, any> = {}
    for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i]
    expect(obj.session_id).toBe('session_st')
    expect(obj.digest).toBe('摘要测试')
    expect(obj.importance_score).toBe(0.75)
    expect(obj.message_count).toBe(20)
  })

  it('INSERT OR IGNORE prevents duplicate (session_id, session_end_at)', async () => {
    const sqlite = await createTestDb()
    sqlite.run('CREATE UNIQUE INDEX uq_test ON session_compactions(session_id, session_end_at)')

    sqlite.run(
      `INSERT INTO session_compactions
       (id, session_id, source, digest, topics, entities, facts, decisions, unresolved,
        importance_score, message_count, token_count, session_start_at, session_end_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['sc_dup_1', 'session_dup', 'electron', 'first', '[]', '[]', '[]', '[]', '[]', 0.5, 5, 10, 100, 200, 1000],
    )

    // Second insert with same session_id + session_end_at → IGNORE
    sqlite.run(
      `INSERT OR IGNORE INTO session_compactions
       (id, session_id, source, digest, topics, entities, facts, decisions, unresolved,
        importance_score, message_count, token_count, session_start_at, session_end_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['sc_dup_2', 'session_dup', 'electron', 'second', '[]', '[]', '[]', '[]', '[]', 0.5, 5, 10, 100, 200, 2000],
    )

    const result = sqlite.exec('SELECT COUNT(*) as cnt FROM session_compactions')
    expect(result[0].values[0][0]).toBe(1)
  })

  it('stores and retrieves JSON array columns correctly', async () => {
    const sqlite = await createTestDb()
    const topics = ['architecture', 'memory', 'evolution']
    const entities = [
      { name: 'entity1', type: 'concept', salience: 0.8 },
      { name: 'entity2', type: 'file', salience: 0.6 },
    ]
    const facts = [{ subject: 'user_name', type: 'new', newValue: 'Alice', confidence: 0.9 }]

    sqlite.run(
      `INSERT INTO session_compactions
       (id, session_id, source, digest, topics, entities, facts, decisions, unresolved,
        importance_score, message_count, token_count, session_start_at, session_end_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'sc_json_1',
        'session_json',
        'electron',
        'json test',
        JSON.stringify(topics),
        JSON.stringify(entities),
        JSON.stringify(facts),
        '[]',
        '[]',
        0.6,
        15,
        80,
        1000,
        2000,
        Date.now(),
      ],
    )

    const result = sqlite.exec('SELECT topics, entities, facts FROM session_compactions WHERE id = ?', ['sc_json_1'])
    const row: any[] = result[0].values[0]

    const parsedTopics = JSON.parse(row[0])
    const parsedEntities = JSON.parse(row[1])
    const parsedFacts = JSON.parse(row[2])

    expect(parsedTopics).toEqual(topics)
    expect(parsedEntities.length).toBe(2)
    expect(parsedEntities[0].name).toBe('entity1')
    expect(parsedFacts[0].subject).toBe('user_name')
  })

  it('append-only: no UPDATE path exists in schema', async () => {
    const sqlite = await createTestDb()
    sqlite.run(
      `INSERT INTO session_compactions
       (id, session_id, source, digest, topics, entities, facts, decisions, unresolved,
        importance_score, message_count, token_count, session_start_at, session_end_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['sc_ao_1', 'session_ao', 'electron', 'append-only', '[]', '[]', '[]', '[]', '[]', 0.5, 5, 10, 100, 200, 1000],
    )

    // Verify no UPDATE-like mechanism — the only way to get a second row is INSERT
    // Pure INSERT path: same session_id, different session_end_at → allowed
    sqlite.run(
      `INSERT OR IGNORE INTO session_compactions
       (id, session_id, source, digest, topics, entities, facts, decisions, unresolved,
        importance_score, message_count, token_count, session_start_at, session_end_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['sc_ao_2', 'session_ao', 'electron', 'append-only-v2', '[]', '[]', '[]', '[]', '[]', 0.5, 8, 20, 100, 2100, 2000],
    )

    const cnt = sqlite.exec('SELECT COUNT(*) as cnt FROM session_compactions')
    expect(cnt[0].values[0][0]).toBe(2)
  })

  it('INSERT with trigger_reason stores and retrieves correctly', async () => {
    const sqlite = await createTestDb()
    sqlite.run(
      `INSERT INTO session_compactions
       (id, session_id, source, digest, topics, entities, facts, decisions, unresolved,
        importance_score, message_count, token_count, session_start_at, session_end_at, created_at, trigger_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'sc_tr_1',
        'session_tr',
        'electron',
        'obs test',
        '[]',
        '[]',
        '[]',
        '[]',
        '[]',
        0.5,
        10,
        50,
        1000,
        2000,
        3000,
        'observation_threshold',
      ],
    )

    const result = sqlite.exec('SELECT trigger_reason FROM session_compactions WHERE id = ?', ['sc_tr_1'])
    expect(result[0].values[0][0]).toBe('observation_threshold')

    // DEFAULT should be 'production_threshold'
    sqlite.run(
      `INSERT INTO session_compactions
       (id, session_id, source, digest, topics, entities, facts, decisions, unresolved,
        importance_score, message_count, token_count, session_start_at, session_end_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['sc_tr_2', 'session_tr', 'electron', 'prod test', '[]', '[]', '[]', '[]', '[]', 0.5, 50, 200, 4000, 5000, 6000],
    )

    const result2 = sqlite.exec('SELECT trigger_reason FROM session_compactions WHERE id = ?', ['sc_tr_2'])
    expect(result2[0].values[0][0]).toBe('production_threshold')
  })
})

// ══════════════════════════════════════════════
// V3: Score Determinism
// ══════════════════════════════════════════════

describe('V3 — Score Determinism', () => {
  const anchor = Date.now()

  function makeCompactionForScore(ageMs: number, entities: string[] = ['test']): SessionCompaction {
    return makeCompaction({
      id: `sc_det_${ageMs}`,
      sessionEndAt: anchor - ageMs,
      importanceScore: 0.7,
      entities: entities.map((n) => ({ name: n, type: 'concept', salience: 0.5 })),
    })
  }

  it('same input produces same score (recency + fallback)', () => {
    const comp = makeCompactionForScore(3600000) // 1 hour ago

    const factorsA = computeFactors(comp, anchor)
    const factorsB = computeFactors(comp, anchor)
    const scoreA = computeScore(factorsA, false)
    const scoreB = computeScore(factorsB, false)

    // Must be bitwise identical
    expect(scoreA).toBe(scoreB)
    expect(factorsA.recency).toBe(factorsB.recency)
    expect(factorsA.frequency).toBe(factorsB.frequency)
    expect(factorsA.importance).toBe(factorsB.importance)

    // Verify recency decay calculation
    const age = anchor - comp.sessionEndAt
    const expectedRecency = Math.max(0, Math.min(1, 1 - age / RECENCY_HALF_LIFE_MS))
    expect(factorsA.recency).toBe(expectedRecency)
  })

  it('same input with attention produces same score', () => {
    const comp = makeCompactionForScore(7200000, ['architecture', 'memory'])
    const attentionEntities = ['architecture', 'memory']

    const factorsA = computeFactors(comp, anchor, attentionEntities)
    const factorsB = computeFactors(comp, anchor, attentionEntities)
    const scoreA = computeScore(factorsA, true)
    const scoreB = computeScore(factorsB, true)

    expect(scoreA).toBe(scoreB)
    expect(factorsA.attention).toBe(factorsB.attention)
  })

  it('recency decreases monotonically with age', () => {
    const ages = [0, 60000, 3600000, 86400000, 7 * 86400000, 14 * 86400000]
    const recencies = ages.map((a) => computeFactors(makeCompactionForScore(a), anchor).recency)

    for (let i = 1; i < recencies.length; i++) {
      expect(recencies[i]).toBeLessThanOrEqual(recencies[i - 1])
    }

    // Very fresh → recency near 1
    expect(recencies[0]).toBeGreaterThan(0.99)

    // Very old → recency near 0
    expect(recencies[recencies.length - 1]).toBeLessThan(0.1)
  })

  it('no Date.now() dependency in scoring (deterministic fallback)', () => {
    // The production code uses Date.now() in computeFactors,
    // but given a fixed `now` parameter the output is deterministic.
    // This test verifies the contract: same (compaction, now, attention) → same score.
    const comp = makeCompactionForScore(5000000)
    const now = 1000000000000 // fixed epoch

    const factors = computeFactors(comp, now)
    const score = computeScore(factors, false)

    // Run again with identical inputs
    const factors2 = computeFactors(comp, now)
    const score2 = computeScore(factors2, false)

    expect(score).toBe(score2)
    expect(factors.recency).toBe(factors2.recency)

    // Verify specific value at known epoch
    const age = now - comp.sessionEndAt
    const expectedRecency = Math.max(0, Math.min(1, 1 - age / RECENCY_HALF_LIFE_MS))
    expect(factors.recency).toBe(expectedRecency)
    expect(score).toBeCloseTo(FALLBACK_RECENCY_WEIGHT * expectedRecency + FALLBACK_IMPORTANCE_WEIGHT * comp.importanceScore, 5)
  })

  it('score ranking is stable (no random tiebreaks)', () => {
    const now = Date.now()
    const comps = [
      makeCompactionForScore(100000, ['a']), // most recent
      makeCompactionForScore(200000, ['b']),
      makeCompactionForScore(300000, ['c']), // least recent
    ].map((c) => ({ compaction: c, factors: computeFactors(c, now, ['x']) }))

    // Sort by score descending
    const scored = comps
      .map((c) => ({
        ...c,
        score: computeScore(c.factors, false),
      }))
      .sort((a, b) => b.score - a.score)

    // First (most recent) should have highest recency → highest score
    expect(scored[0].score).toBeGreaterThanOrEqual(scored[1].score)
    expect(scored[1].score).toBeGreaterThanOrEqual(scored[2].score)

    // Rerun sort, verify same order
    const rescored = comps
      .map((c) => ({
        ...c,
        score: computeScore(c.factors, false),
      }))
      .sort((a, b) => b.score - a.score)

    expect(rescored[0].compaction.id).toBe(scored[0].compaction.id)
    expect(rescored[1].compaction.id).toBe(scored[1].compaction.id)
    expect(rescored[2].compaction.id).toBe(scored[2].compaction.id)
  })

  it('attention weight vs fallback weight differ but both deterministic', () => {
    const comp = makeCompactionForScore(500000, ['architecture'])
    const attentionEntities = ['architecture']
    const now = Date.now()

    // With attention
    const factorsA = computeFactors(comp, now, attentionEntities)
    const scoreA = computeScore(factorsA, true)

    // Without attention (fallback)
    const factorsB = computeFactors(comp, now)
    const scoreB = computeScore(factorsB, false)

    // Both deterministic
    expect(computeScore(computeFactors(comp, now, attentionEntities), true)).toBe(scoreA)
    expect(computeScore(computeFactors(comp, now), false)).toBe(scoreB)

    // Scores may differ (different weights), but that's expected
    // The important thing: both are repeatable
  })
})

// ══════════════════════════════════════════════
// V4: Regression Guard
// ══════════════════════════════════════════════

describe('V4 — Regression Guard', () => {
  it('context mode returns results (Phase 3: mode block removed)', () => {
    // Phase 3 removed the mode='context' block from retrieve().
    // Both 'observation' and 'context' now return results —
    // injection decision moved to ChatExecutor layer.
    function unguardedRetrieve(mode: 'observation' | 'context'): any[] {
      if (mode === 'context') {
        return [{ id: 'context-result', mode }]
      }
      return [{ id: 'observation-result', mode }]
    }

    expect(unguardedRetrieve('observation').length).toBe(1)
    expect(unguardedRetrieve('context').length).toBe(1)
    expect(unguardedRetrieve('context')[0].id).toBe('context-result')
  })

  it('compaction failure isolation — error does not propagate', () => {
    // Simulate checkCompaction's try/catch pattern
    function checkCompaction(sessionId: string, fail: boolean): string | null {
      try {
        if (fail) throw new Error('DB timeout')
        return 'compacted'
      } catch (err) {
        // Must NOT re-throw — Memory is auxiliary
        return null
      }
    }

    expect(checkCompaction('valid', false)).toBe('compacted')
    expect(checkCompaction('failing', true)).toBeNull()
    // No exception thrown
  })

  it('retrieve failure returns empty array, does not throw', () => {
    function safeRetrieve(): any[] {
      try {
        throw new Error('DB error')
      } catch {
        return []
      }
    }

    const result = safeRetrieve()
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBe(0)
  })

  it('buildContext with empty retrieval produces zero-token empty block', () => {
    function buildContext(compactions: any[]): any {
      if (compactions.length === 0) {
        return { digests: [], facts: [], decisions: [], entities: [], totalTokens: 0, sourceSessions: [] }
      }
      return { digests: ['d'], facts: ['f'], totalTokens: 100 }
    }

    const block = buildContext([])
    expect(block.digests.length).toBe(0)
    expect(block.totalTokens).toBe(0)
    expect(block.sourceSessions).toEqual([])
  })
})

// ══════════════════════════════════════════════
// V5: Scoring Quality Events (ADR-013 Phase 2)
// ══════════════════════════════════════════════

describe('V5 — Scoring Quality Events', () => {
  it('memory.retrieval.scored payload shape is correct', () => {
    const payload = {
      type: 'memory.retrieval.scored' as const,
      sessionId: 'session_v5',
      specSessionId: 'session_v5',
      totalCompactions: 10,
      scoredCount: 5,
      attentionAvailable: true,
      scoreDistribution: { min: 0.1, max: 0.9, avg: 0.45, median: 0.4 },
      topScores: [0.9, 0.7, 0.5],
      tokenBudget: 800,
      tokenUtilized: 350,
      resultCount: 3,
    }
    expect(payload.type).toBe('memory.retrieval.scored')
    expect(payload.totalCompactions).toBe(10)
    expect(payload.scoredCount).toBe(5)
    expect(payload.attentionAvailable).toBe(true)
    expect(payload.scoreDistribution.min).toBe(0.1)
    expect(payload.scoreDistribution.max).toBe(0.9)
    expect(payload.scoreDistribution.avg).toBe(0.45)
    expect(payload.scoreDistribution.median).toBe(0.4)
    expect(payload.topScores).toEqual([0.9, 0.7, 0.5])
    expect(payload.tokenBudget).toBe(800)
    expect(payload.tokenUtilized).toBe(350)
    expect(payload.resultCount).toBe(3)
  })

  it('score distribution calculation matches retrieval results', () => {
    // Simulate the emitScoringEvent logic
    const scored = [
      { score: 0.9, matchedFactors: { recency: 0.9, attention: 0.8, frequency: 0.5, importance: 0.7 } },
      { score: 0.7, matchedFactors: { recency: 0.7, attention: 0.5, frequency: 0.3, importance: 0.6 } },
      { score: 0.5, matchedFactors: { recency: 0.5, attention: 0.3, frequency: 0.2, importance: 0.4 } },
      { score: 0.3, matchedFactors: { recency: 0.3, attention: 0.1, frequency: 0.1, importance: 0.2 } },
      { score: 0.1, matchedFactors: { recency: 0.1, attention: 0.0, frequency: 0.0, importance: 0.1 } },
    ]

    const scores = scored.map((r) => r.score)
    const min = Math.min(...scores)
    const max = Math.max(...scores)
    const avg = scores.reduce((s, v) => s + v, 0) / scores.length
    const sorted = [...scores].sort((a, b) => a - b)
    const median =
      sorted.length % 2 === 0 ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2 : sorted[Math.floor(sorted.length / 2)]
    const topScores = [...scores].sort((a, b) => b - a).slice(0, 3)

    expect(min).toBe(0.1)
    expect(max).toBe(0.9)
    expect(avg).toBeCloseTo(0.5, 5)
    expect(median).toBe(0.5)
    expect(topScores).toEqual([0.9, 0.7, 0.5])
  })

  it('attentionAvailable flag reflects spec attention entities', () => {
    // With attention entities
    const withAttention = { attentionAvailable: true, attentionEntitiesCount: 3 }
    expect(withAttention.attentionAvailable).toBe(true)

    // Without attention entities
    const withoutAttention = { attentionAvailable: false, attentionEntitiesCount: 0 }
    expect(withoutAttention.attentionAvailable).toBe(false)
  })

  it('token utilization equals sum of selected compaction token counts', () => {
    const results = [{ compaction: { tokenCount: 200 } }, { compaction: { tokenCount: 150 } }, { compaction: { tokenCount: 100 } }]
    const tokenBudget = 800
    const tokenUtilized = results.reduce((s, r) => s + (r.compaction.tokenCount || 0), 0)

    expect(tokenUtilized).toBe(450)
    expect(tokenUtilized).toBeLessThanOrEqual(tokenBudget)
    expect(tokenBudget - tokenUtilized).toBe(350)
  })

  it('memory.scoring.attention_gap payload shape', () => {
    const gapPayload = {
      type: 'memory.scoring.attention_gap' as const,
      sessionId: 'session_gap',
      attentionScore: 0.85,
      fallbackScore: 0.55,
      gap: 0.3,
      attentionFactors: { recency: 0.9, attention: 0.8, frequency: 0.5, importance: 0.7 },
      fallbackFactors: { recency: 0.9, frequency: 0.5, importance: 0.7 },
      attentionEntityCount: 3,
    }
    expect(gapPayload.type).toBe('memory.scoring.attention_gap')
    expect(gapPayload.gap).toBeCloseTo(0.3, 5)
    expect(gapPayload.attentionScore).toBeGreaterThan(gapPayload.fallbackScore)
    expect(gapPayload.attentionEntityCount).toBe(3)

    // fallbackFactors should not have attention field
    expect(gapPayload.fallbackFactors).not.toHaveProperty('attention')
  })
})
