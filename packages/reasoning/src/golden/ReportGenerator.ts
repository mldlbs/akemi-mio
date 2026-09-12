/**
 * ReportGenerator — ADR-007 pure function implementation.
 *
 * RegressionReport = f(ReplayResult)
 *
 * Invariants:
 *   I-1: Referential Transparency — same input always produces same output
 *   I-2: Immutability — input is never mutated
 *   I-3: No filesystem / Golden / Git access
 */
import type { ReasoningDirective } from '../types'
import type {
  ReplayResult,
  CommitContext,
  RegressionReport,
  SummarySection,
  CapabilitySection,
  CapabilityEntry,
  RegressionSection,
  RegressionEntry,
  FieldDiff,
  EvidenceSection,
  EvidenceEntry,
  MetadataSection,
} from './types'

/** Compare two ReasoningDirective fields structurally. */
function fieldDiffOf(expected: ReasoningDirective, actual: ReasoningDirective): FieldDiff {
  return {
    patternChanged: expected.pattern !== actual.pattern,
    expectedPattern: expected.pattern,
    actualPattern: actual.pattern,
    goalsChanged: JSON.stringify(expected.goals) !== JSON.stringify(actual.goals),
    constraintsChanged: JSON.stringify(expected.constraints) !== JSON.stringify(actual.constraints),
    outputStyleChanged: expected.outputStyle !== actual.outputStyle,
  }
}

/** Build SummarySection from ReplayResult counters. */
function summaryOf(r: ReplayResult): SummarySection {
  const passRate = r.total > 0 ? r.passed / r.total : 0
  const status: SummarySection['status'] = r.failed > 0 ? 'fail' : r.passed > 0 ? 'pass' : 'inconclusive'
  return {
    total: r.total,
    passed: r.passed,
    failed: r.failed,
    skipped: r.skipped,
    durationMs: r.durationMs,
    passRate,
    status,
  }
}

/** Build CapabilitySection by grouping failures by expected.pattern. */
function capabilityOf(r: ReplayResult): CapabilitySection {
  const map = new Map<string, { failedCount: number; totalCount: number; ids: string[] }>()
  for (const f of r.failures) {
    const pat = f.expected.pattern || 'unknown'
    const e = map.get(pat) || { failedCount: 0, totalCount: 0, ids: [] }
    e.failedCount++
    e.totalCount++
    e.ids.push(f.caseId)
    map.set(pat, e)
  }
  const regressed: CapabilityEntry[] = []
  const intact: string[] = []
  for (const [cap, d] of map) {
    regressed.push({ capability: cap, failedCount: d.failedCount, totalCount: d.totalCount, affectedCaseIds: d.ids })
  }
  return { regressed, intact }
}

/** Build RegressionSection from failures. */
function regressionOf(r: ReplayResult): RegressionSection {
  return {
    count: r.failures.length,
    entries: r.failures.map((f) => ({
      caseId: f.caseId,
      category: 'analysis',
      diffSummary: f.diff,
      fieldDiff: fieldDiffOf(f.expected, f.actual),
    })),
  }
}

/** Build EvidenceSection from failures. */
function evidenceOf(r: ReplayResult): EvidenceSection {
  return {
    entries: r.failures.map((f) => ({
      caseId: f.caseId,
      category: 'analysis',
      inputText: 'replay-runner-input',
      expected: f.expected,
      actual: f.actual,
      diff: f.diff,
    })),
  }
}

/** Build MetadataSection from runner output and optional commit context. */
function metadataOf(r: ReplayResult, ctx?: CommitContext): MetadataSection {
  return {
    runnerVersion: r.runnerVersion,
    reportSchemaVersion: '0.1',
    goldenVersion: '0.1',
    goldenSchemaVersion: '0.1',
    datasetInfo: {
      totalCases: r.total,
      categories: { analysis: 0, decision: 0, planning: 0, creation: 0 },
    },
    commit: { sha: ctx?.sha || 'unknown', branch: ctx?.branch || 'unknown', dirty: ctx?.dirty ?? false },
    executedAt: r.executedAt,
  }
}

export class ReportGenerator {
  /**
   * Produce a RegressionReport from ReplayResult.
   * Pure function: same input always produces same output.
   * Never mutates input.
   */
  generate(result: ReplayResult, context?: CommitContext): RegressionReport {
    return {
      reportSchemaVersion: '0.1',
      summary: summaryOf(result),
      capability: capabilityOf(result),
      regression: regressionOf(result),
      evidence: evidenceOf(result),
      trend: null,
      metadata: metadataOf(result, context),
    }
  }
}
