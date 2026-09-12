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

// ═══════════════════════════════════════════════════════
//  M4 Runner Types (ADR-007 Input Contract)
// ═══════════════════════════════════════════════════════

/** Runner version. Free-form semantic string. */
export type RunnerVersion = string

/** Category of golden case in the manifest. */
export type GoldenCategory = 'analysis' | 'decision' | 'planning' | 'creation'

/** A single failure record produced by ReplayRunner. */
export interface ReplayFailure {
  caseId: string
  expected: ReasoningDirective
  actual: ReasoningDirective
  diff: string
}

/** Report produced by ReplayRunner.run(). */
export interface ReplayReport {
  total: number
  passed: number
  failed: number
  skipped: number
  durationMs: number
  failures: ReplayFailure[]
  runnerVersion: RunnerVersion
  executedAt: string
}

// ═══════════════════════════════════════════════════════
//  ADR-007 Regression Report Contract Types
// ═══════════════════════════════════════════════════════

/** ReplayResult: input to ReportGenerator. */
export interface ReplayResult {
  total: number
  passed: number
  failed: number
  skipped: number
  durationMs: number
  failures: ReplayFailure[]
  runnerVersion: RunnerVersion
  executedAt: string
}

/** Commit context injected into ReportGenerator. */
export interface CommitContext {
  sha: string
  branch: string
  dirty: boolean
}

export interface SummarySection {
  total: number
  passed: number
  failed: number
  skipped: number
  durationMs: number
  passRate: number
  status: 'pass' | 'fail' | 'inconclusive'
}

export interface CapabilityEntry {
  capability: string
  failedCount: number
  totalCount: number
  affectedCaseIds: string[]
}

export interface CapabilitySection {
  regressed: CapabilityEntry[]
  intact: string[]
}

export interface FieldDiff {
  patternChanged: boolean
  expectedPattern?: string
  actualPattern?: string
  goalsChanged: boolean
  constraintsChanged: boolean
  outputStyleChanged: boolean
}

export interface RegressionEntry {
  caseId: string
  category: string
  diffSummary: string
  fieldDiff: FieldDiff
}

export interface RegressionSection {
  count: number
  entries: RegressionEntry[]
}

export interface EvidenceEntry {
  caseId: string
  category: string
  inputText: string
  expected: ReasoningDirective
  actual: ReasoningDirective
  diff: string
}

export interface EvidenceSection {
  entries: EvidenceEntry[]
}

export interface TrendEntry {
  executedAt: string
  runnerVersion: string
  passRate: number
  total: number
  passed: number
}

export interface TrendSection {
  history: TrendEntry[]
  direction: 'improving' | 'stable' | 'declining' | 'unknown'
}

export interface DatasetInfo {
  totalCases: number
  categories: Record<string, number>
}

export interface CommitInfo {
  sha: string
  branch: string
  dirty: boolean
}

export interface MetadataSection {
  runnerVersion: string
  reportSchemaVersion: '0.1'
  goldenVersion: string
  goldenSchemaVersion: string
  datasetInfo: DatasetInfo
  commit: CommitInfo
  executedAt: string
}

export interface RegressionReport {
  reportSchemaVersion: '0.1'
  summary: SummarySection
  capability: CapabilitySection
  regression: RegressionSection
  evidence: EvidenceSection
  trend: TrendSection | null
  metadata: MetadataSection
}

export interface ReportGenerator {
  generate(result: ReplayResult, context?: CommitContext): RegressionReport
}
