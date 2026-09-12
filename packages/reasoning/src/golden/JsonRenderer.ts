/**
 * JsonRenderer — ADR-007 JSON serialization.
 *
 * render(report: RegressionReport): string
 *
 * Invariants (P1.4.1a):
 *   J-1: Determinism — same report → same string
 *   J-2: Round-trip — JSON.parse(render(r)) recovers original
 *   J-3: Immutability — input is not mutated
 *   J-4: No derived fields — output matches Contract exactly
 *   J-5: Canonical field order — byte-identical for equal inputs
 */
import type { RegressionReport } from './types'

const CANONICAL_KEYS: ReadonlyArray<string> = [
  'reportSchemaVersion',
  'summary',
  'capability',
  'regression',
  'evidence',
  'trend',
  'metadata',
]

const SUMMARY_KEYS: ReadonlyArray<string> = ['total', 'passed', 'failed', 'skipped', 'durationMs', 'passRate', 'status']

const CAPABILITY_ENTRY_KEYS: ReadonlyArray<string> = ['capability', 'failedCount', 'totalCount', 'affectedCaseIds']

const FIELD_DIFF_KEYS: ReadonlyArray<string> = [
  'patternChanged',
  'expectedPattern',
  'actualPattern',
  'goalsChanged',
  'constraintsChanged',
  'outputStyleChanged',
]

const REGRESSION_ENTRY_KEYS: ReadonlyArray<string> = ['caseId', 'category', 'diffSummary', 'fieldDiff']

const EVIDENCE_ENTRY_KEYS: ReadonlyArray<string> = ['caseId', 'category', 'inputText', 'expected', 'actual', 'diff']

const TREND_ENTRY_KEYS: ReadonlyArray<string> = ['executedAt', 'runnerVersion', 'passRate', 'total', 'passed']

const DATASET_INFO_KEYS: ReadonlyArray<string> = ['totalCases', 'categories']

const COMMIT_INFO_KEYS: ReadonlyArray<string> = ['sha', 'branch', 'dirty']

const METADATA_KEYS: ReadonlyArray<string> = [
  'runnerVersion',
  'reportSchemaVersion',
  'goldenVersion',
  'goldenSchemaVersion',
  'datasetInfo',
  'commit',
  'executedAt',
]

const DIRECTIVE_KEYS: ReadonlyArray<string> = ['pattern', 'goals', 'constraints', 'outputStyle']

/** Serialize a value to canonical JSON string. */
function j(v: unknown): string {
  return JSON.stringify(v)
}

function orderedObject(obj: Record<string, unknown>, keyOrder: ReadonlyArray<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keyOrder) {
    if (k in obj) out[k] = obj[k]
  }
  return out
}

function orderedDirective(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val
  const o = val as Record<string, unknown>
  return orderedObject(o, DIRECTIVE_KEYS)
}

function orderedFailure(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val
  const o = val as Record<string, unknown>
  return {
    caseId: o.caseId,
    expected: orderedDirective(o.expected),
    actual: orderedDirective(o.actual),
    diff: o.diff,
  }
}

function orderedFieldDiff(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val
  return orderedObject(val as Record<string, unknown>, FIELD_DIFF_KEYS)
}

function orderedRegressionEntry(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val
  const o = val as Record<string, unknown>
  const base = orderedObject(o, REGRESSION_ENTRY_KEYS)
  if (o.fieldDiff) base.fieldDiff = orderedFieldDiff(o.fieldDiff)
  return base
}

function orderedEvidenceEntry(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val
  const o = val as Record<string, unknown>
  const base = orderedObject(o, EVIDENCE_ENTRY_KEYS)
  if (o.expected) base.expected = orderedDirective(o.expected)
  if (o.actual) base.actual = orderedDirective(o.actual)
  return base
}

function orderedSummary(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val
  return orderedObject(val as Record<string, unknown>, SUMMARY_KEYS)
}

function orderedCapabilityEntry(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val
  return orderedObject(val as Record<string, unknown>, CAPABILITY_ENTRY_KEYS)
}

function orderedCapability(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val
  const o = val as Record<string, unknown>
  return {
    regressed: (o.regressed as unknown[])?.map(orderedCapabilityEntry),
    intact: o.intact,
  }
}

function orderedTrendEntry(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val
  return orderedObject(val as Record<string, unknown>, TREND_ENTRY_KEYS)
}

function orderedTrend(val: unknown): unknown {
  if (val === null) return null
  const o = val as Record<string, unknown>
  return {
    history: (o.history as unknown[])?.map(orderedTrendEntry),
    direction: o.direction,
  }
}

function orderedDatasetInfo(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val
  return orderedObject(val as Record<string, unknown>, DATASET_INFO_KEYS)
}

function orderedCommitInfo(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val
  return orderedObject(val as Record<string, unknown>, COMMIT_INFO_KEYS)
}

function orderedMetadata(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val
  const o = val as Record<string, unknown>
  const base = orderedObject(o, METADATA_KEYS) as Record<string, unknown>
  if (o.datasetInfo) base.datasetInfo = orderedDatasetInfo(o.datasetInfo)
  if (o.commit) base.commit = orderedCommitInfo(o.commit)
  return base
}

function orderedRegression(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val
  const o = val as Record<string, unknown>
  return {
    count: o.count,
    entries: (o.entries as unknown[])?.map(orderedRegressionEntry),
  }
}

function orderedEvidence(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val
  const o = val as Record<string, unknown>
  return {
    entries: (o.entries as unknown[])?.map(orderedEvidenceEntry),
  }
}

/** Build a canonical-ordered RegressionReport object, then serialize it. */
export function renderJson(report: RegressionReport): string {
  const ordered: Record<string, unknown> = {}
  for (const k of CANONICAL_KEYS) {
    const val = (report as unknown as Record<string, unknown>)[k]
    if (k === 'summary') ordered[k] = orderedSummary(val)
    else if (k === 'capability') ordered[k] = orderedCapability(val)
    else if (k === 'regression') ordered[k] = orderedRegression(val)
    else if (k === 'evidence') ordered[k] = orderedEvidence(val)
    else if (k === 'trend') ordered[k] = orderedTrend(val)
    else if (k === 'metadata') ordered[k] = orderedMetadata(val)
    else ordered[k] = val
  }
  return JSON.stringify(ordered, null, 2)
}

export function render(report: RegressionReport): string {
  return renderJson(report)
}
