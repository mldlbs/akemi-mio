/**
 * CliRenderer — ADR-007 terminal-formatted report output.
 *
 * render(report: RegressionReport): string
 *
 * Invariants:
 *   C-1: Determinism — same report → same string
 *   C-2: Non-empty — reasonable report produces non-empty output
 *   C-3: Content coverage — output contains passRate, status, total
 *   C-4: No-failures edge case — failed=0 → no failures section
 *   C-5: All-failures edge case — passed=0 still renders
 *   C-6: Empty edge case — total=0 does not crash
 *   C-7: Output contains box-drawing characters
 */

import type { RegressionReport } from './types'

function pct(rate: number): string {
  return (rate * 100).toFixed(2) + '%'
}

const TOP = '╔══════════════════════════════════════════════════════════════════╗'
const SEP = '╠══════════════════════════════════════════════════════════════════╣'
const BOT = '╚══════════════════════════════════════════════════════════════════╝'

function padCell(s: string, w: number): string {
  return s.padEnd(w)
}

function renderSummary(report: RegressionReport): string {
  const s = report.summary
  const lines: string[] = []
  const titleLine = '║           Regression Report                                ║'
  lines.push(TOP)
  lines.push(titleLine)
  lines.push(SEP)

  // header row
  const h = '║ Total     Passed   Failed   Pass Rate   Status   Duration   ║'
  lines.push(h)

  // value row
  const v = `║ ${padCell(String(s.total), 9)} ${padCell(String(s.passed), 7)} ${padCell(String(s.failed), 7)} ${padCell(pct(s.passRate), 10)} ${padCell(s.status.toUpperCase(), 8)} ${padCell(s.durationMs + 'ms', 9)}║`
  lines.push(v)
  lines.push(BOT)
  lines.push('')
  return lines.join('\n')
}

function renderCapability(report: RegressionReport): string {
  const c = report.capability
  const lines: string[] = ['Capability Impact:', '']

  if (c.regressed.length === 0 && c.intact.length === 0) {
    lines.push('  (no capability data)')
    lines.push('')
    return lines.join('\n')
  }

  for (const entry of c.regressed) {
    const ids = entry.affectedCaseIds.join(', ')
    lines.push(`  ✗ ${entry.capability} ${'.'.repeat(Math.max(1, 30 - entry.capability.length))} ${entry.failedCount}/${entry.totalCount} failed  [${ids}]`)
  }
  for (const name of c.intact) {
    lines.push(`  ✓ ${name} ${'.'.repeat(Math.max(1, 30 - name.length))} 0/${'?'} failed`)
  }
  lines.push('')
  return lines.join('\n')
}

function renderRegression(report: RegressionReport): string {
  const r = report.regression
  const lines: string[] = ['Regression Details:', '']

  if (r.count === 0 || r.entries.length === 0) {
    lines.push('  (no regressions)')
    lines.push('')
    return lines.join('\n')
  }

  for (const entry of r.entries) {
    const fd = entry.fieldDiff
    const changes: string[] = []
    if (fd.patternChanged) {
      changes.push(`pattern ${fd.expectedPattern ?? '?'} → ${fd.actualPattern ?? '?'}`)
    }
    if (fd.goalsChanged) changes.push('goals changed')
    if (fd.constraintsChanged) changes.push('constraints changed')
    if (fd.outputStyleChanged) changes.push('output style changed')
    const detail = changes.length > 0 ? changes.join(', ') : 'no field changes'
    lines.push(`  ${entry.caseId}: ${detail}`)
  }
  lines.push('')
  return lines.join('\n')
}

function renderEvidence(report: RegressionReport): string {
  const e = report.evidence
  const lines: string[] = ['Evidence:', '']

  if (e.entries.length === 0) {
    lines.push('  (no evidence)')
    lines.push('')
    return lines.join('\n')
  }

  for (const entry of e.entries) {
    lines.push(`  [${entry.caseId}] Diff: ${entry.diff}`)
    lines.push(`    Expected: ${JSON.stringify(entry.expected)}`)
    lines.push(`    Actual:   ${JSON.stringify(entry.actual)}`)
    lines.push('')
  }

  return lines.join('\n')
}

function renderMetadata(report: RegressionReport): string {
  const m = report.metadata
  const dirtyFlag = m.commit.dirty ? ' [dirty]' : ''
  return `Schema: ${m.reportSchemaVersion} | Runner: ${m.runnerVersion} | Golden: ${m.goldenVersion} | ${m.commit.sha}${dirtyFlag} | ${m.executedAt}\n`
}

export function render(report: RegressionReport): string {
  const sections: string[] = [
    renderSummary(report),
    renderCapability(report),
    renderRegression(report),
    renderEvidence(report),
    renderMetadata(report),
  ]
  return sections.join('\n')
}
