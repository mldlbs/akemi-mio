/**
 * Golden Schema — M4.3 Frozen Data Contract
 *
 * Two-level design:
 *  Level 1 (v0.1): deterministic ReasoningDirective snapshot — exact match
 *  Level 2 (future): non-deterministic LLM response — approximate match
 *
 * Invariants:
 *  1. GoldenCase is a snapshot. Updates produce new version entries.
 *  2. One active GoldenCase per BenchmarkCase at any point in time.
 *  3. Level 1 diff = failure. Level 2 diff governed by RegressionPolicy.
 *  4. All changelog updates must carry a human-readable reason.
 */

import type { ReasoningDirective, BenchmarkCaseId } from '../types'

// ═══════════════════════════════════════════════════════
//  Level 1: ReasoningDirective Snapshot (deterministic)
// ═══════════════════════════════════════════════════════

/** Schema version. Incremented when the shape of GoldenCase changes. */
export type GoldenSchemaVersion = '0.1'

/** Level 1 — the expected ReasoningDirective for a given input. */
export interface GoldenDirectiveSnapshot {
  schemaVersion: GoldenSchemaVersion
  directive: ReasoningDirective
}

// ═══════════════════════════════════════════════════════
//  Level 2: LLM Response Snapshot (non-deterministic, future)
// ═══════════════════════════════════════════════════════

/** @future — Level 2 snapshot: approved LLM execution trace. */
export interface GoldenResponseSnapshot {
  schemaVersion: GoldenSchemaVersion
  renderedPrompt: string
  goldenResponse: string
  llmContext: {
    model: string
    temperature: number
    promptBuilderVersion: string
    recordedAt: string
  }
}

// ═══════════════════════════════════════════════════════
//  Revision History
// ═══════════════════════════════════════════════════════

/** One atomic revision entry. Every update appends, never in-place overwrite. */
export interface GoldenChangelogEntry {
  date: string
  reason: string
  author: string
  level: 'l1' | 'l2'
  previousDirectiveHash?: string
}

// ═══════════════════════════════════════════════════════
//  GoldenCase — top-level container
// ═══════════════════════════════════════════════════════

/**
 * Complete golden record for one benchmark case.
 * Stored as one JSON file per case: {caseId}.golden.json
 */
export interface GoldenCase {
  /** Benchmark case identifier, e.g. "Q01", "D-D05" */
  caseId: BenchmarkCaseId

  /** Snapshot of the benchmark input (decoupled from benchmark markdown) */
  caseRef: {
    text: string
    expectations: string[]
  }

  /** Level 1: deterministic ReasoningDirective. Implemented in v0.1. */
  level1: GoldenDirectiveSnapshot

  /**
   * Level 2: LLM response.
   * @future — null in v0.1. Populated in Golden Dataset v0.2+.
   */
  level2: GoldenResponseSnapshot | null

  /** Append-only revision log. Length = version number. */
  changelog: GoldenChangelogEntry[]

  createdAt: string
  updatedAt: string
}
