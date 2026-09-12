/**
 * MarkdownRenderer — ADR-007 Markdown serialization.
 *
 * render(report: RegressionReport): string
 *
 * Invariants:
 *   M-1: Determinism — same report → same string
 *   M-2: Non-empty — reasonable report produces non-empty output
 *   M-3: Content coverage — output contains passRate, status, total
 *   M-4: No-failures edge case — failed=0 → no failures section
 *   M-5: All-failures edge case — passed=0 still renders
 *   M-6: Empty edge case — total=0 does not crash
 *   M-7: Output contains Markdown structure markers (#, |, ---)
 */

import type { RegressionReport, RegressionEntry } from './types'

function pct(rate: number): string {
  return (rate * 100).toFixed(2) + '%'
}

function statusBadge(status: string): string {
  switch (status) {
    case 'pass':
      return '✅ Pass'
    case 'fail':
      return '❌ Fail'
    default:
      return '➖ Inconclusive'
  }
}

function renderSummary(report: RegressionReport): string {
  const s = report.summary
  const lines: string[] = [
    '## Summary',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| Total | ${s.total} |`,
    `| Passed | ${s.passed} |`,
    `| Failed | ${s.failed} |`,
    `| Skipped | ${s.skipped} |`,
    `| Pass Rate | ${pct(s.passRate)} |`,
    `| Status | ${statusBadge(s.status)} |`,
    `| Duration | ${s.durationMs}ms |`,
    '',
  ]
  return lines.join('\n')
}

function renderCapability(report: RegressionReport): string {
  const c = report.capability
  const lines: string[] = ['## Capability Impact', '']

  if (c.regressed.length > 0) {
    lines.push('### Regressed')
    for (const entry of c.regressed) {
      const ids = entry.affectedCaseIds.join(', ')
      lines.push(`- **${entry.capability}**: ${entry.failedCount} failed / ${entry.totalCount} total — ${ids}`)
    }
    lines.push('')
  }

  if (c.intact.length > 0) {
    lines.push('### Intact')
    lines.push(`- ${c.intact.join(', ')}`)
    lines.push('')
  }

  if (c.regressed.length === 0 && c.intact.length === 0) {
    lines.push('_No capability data._')
    lines.push('')
  }

  return lines.join('\n')
}

function renderFieldDiff(entry: RegressionEntry): string[] {
  const fd = entry.fieldDiff
  const bullets: string[] = []
  if (fd.patternChanged) {
    bullets.push(`- **Pattern changed**: ${fd.expectedPattern ?? '?'} vs ${fd.actualPattern ?? '?'}`)
  }
  bullets.push(`- **Goals changed**: ${fd.goalsChanged ? 'yes' : 'no'}`)
  bullets.push(`- **Constraints changed**: ${fd.constraintsChanged ? 'yes' : 'no'}`)
  bullets.push(`- **Output style changed**: ${fd.outputStyleChanged ? 'yes' : 'no'}`)
  return bullets
}

function renderRegression(report: RegressionReport): string {
  const r = report.regression
  const lines: string[] = ['## Regression Details', '']

  if (r.count === 0 || r.entries.length === 0) {
    lines.push('_No regressions detected._')
    lines.push('')
    return lines.join('\n')
  }

  for (const entry of r.entries) {
    lines.push(`### ${entry.caseId} — ${entry.diffSummary}`)
    lines.push(...renderFieldDiff(entry))
    lines.push('')
  }

  return lines.join('\n')
}

function directiveToMd(label: string, directive: { pattern: string; goals: unknown; constraints: unknown; outputStyle: string }): string {
  return [`**${label}**:`, '```json', JSON.stringify(directive, null, 2), '```'].join('\n')
}

function renderEvidence(report: RegressionReport): string {
  const e = report.evidence
  const lines: string[] = ['## Evidence', '']

  if (e.entries.length === 0) {
    lines.push('_No evidence entries._')
    lines.push('')
    return lines.join('\n')
  }

  for (const entry of e.entries) {
    lines.push(`### ${entry.caseId} (${entry.category})`)
    lines.push('')
    lines.push(`- **Diff**: ${entry.diff}`)
    lines.push('')
    lines.push(directiveToMd('Expected', entry.expected))
    lines.push('')
    lines.push(directiveToMd('Actual', entry.actual))
    lines.push('')
  }

  return lines.join('\n')
}

function renderMetadata(report: RegressionReport): string {
  const m = report.metadata
  const commitStr = `${m.commit.sha} (${m.commit.branch})${m.commit.dirty ? ' [dirty]' : ''}`
  return [
    '---',
    `_Schema: ${m.reportSchemaVersion} | Runner: ${m.runnerVersion} | Golden: ${m.goldenVersion} | Commit: ${commitStr} | ${m.executedAt}_`,
  ].join('\n')
}

export function render(report: RegressionReport): string {
  const sections: string[] = [
    '# Regression Report',
    '',
    renderSummary(report),
    renderCapability(report),
    renderRegression(report),
    renderEvidence(report),
    renderMetadata(report),
  ]
  return sections.join('\n') + '\n'
}
