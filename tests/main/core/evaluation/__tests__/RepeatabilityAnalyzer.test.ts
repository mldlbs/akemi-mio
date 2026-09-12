import { describe, expect, it } from 'vitest'

import { evaluateRepeatability } from '@akemi-mio/core/core/evaluation/RepeatabilityAnalyzer'

describe('evaluateRepeatability', () => {
  it('returns repeatable_positive when the same case identity appears in a second independent window', () => {
    const report = evaluateRepeatability(
      {
        caseFamily: 'browser.automation',
        capability: 'browser.automation',
        operation: 'navigate',
        issueType: 'timeout',
        windowId: 'window-2',
      },
      [
        {
          caseFamily: 'browser.automation',
          capability: 'browser.automation',
          operation: 'navigate',
          issueType: 'timeout',
          windowId: 'window-1',
          traceId: 'trace-a',
        },
        {
          caseFamily: 'browser.automation',
          capability: 'browser.automation',
          operation: 'navigate',
          issueType: 'timeout',
          windowId: 'window-1',
          traceId: 'trace-b',
        },
      ],
      '2026-08-05T00:00:00.000Z',
    )

    expect(report.verdict).toBe('repeatable_positive')
    expect(report.target).toEqual({
      caseFamily: 'browser.automation',
      capability: 'browser.automation',
      operation: 'navigate',
      issueType: 'timeout',
      windowId: 'window-2',
    })
    expect(report.comparison.independentWindowCount).toBe(1)
    expect(report.comparison.matchedWindowIds).toEqual(['window-1'])
    expect(report.traceRefs).toEqual(['trace-a', 'trace-b'])
  })

  it('returns insufficient_evidence when the same identity appears only in the current window', () => {
    const report = evaluateRepeatability(
      {
        caseFamily: 'browser.automation',
        capability: 'browser.automation',
        operation: 'navigate',
        issueType: 'timeout',
        windowId: 'window-2',
      },
      [
        {
          caseFamily: 'browser.automation',
          capability: 'browser.automation',
          operation: 'navigate',
          issueType: 'timeout',
          windowId: 'window-2',
          traceId: 'trace-current',
        },
      ],
      '2026-08-05T00:00:00.000Z',
    )

    expect(report.verdict).toBe('insufficient_evidence')
    expect(report.comparison.independentWindowCount).toBe(0)
    expect(report.comparison.matchedWindowIds).toEqual([])
    expect(report.traceRefs).toEqual([])
  })

  it('returns insufficient_evidence when only a different case identity appeared before', () => {
    const report = evaluateRepeatability(
      {
        caseFamily: 'browser.automation',
        capability: 'browser.automation',
        operation: 'navigate',
        issueType: 'timeout',
        windowId: 'window-2',
      },
      [
        {
          caseFamily: 'browser.automation',
          capability: 'browser.automation',
          operation: 'click',
          issueType: 'timeout',
          windowId: 'window-1',
          traceId: 'trace-different-operation',
        },
      ],
      '2026-08-05T00:00:00.000Z',
    )

    expect(report.verdict).toBe('insufficient_evidence')
    expect(report.comparison.independentWindowCount).toBe(0)
    expect(report.comparison.matchedWindowIds).toEqual([])
  })

  it('fails closed when the target identity is incomplete', () => {
    expect(() =>
      evaluateRepeatability(
        {
          caseFamily: '',
          capability: 'browser.automation',
          operation: 'navigate',
          issueType: 'timeout',
          windowId: 'window-2',
        },
        [],
        '2026-08-05T00:00:00.000Z',
      ),
    ).toThrow(/target\.caseFamily/)
  })

  it('fails closed when a matching history entry has no trace ref', () => {
    expect(() =>
      evaluateRepeatability(
        {
          caseFamily: 'browser.automation',
          capability: 'browser.automation',
          operation: 'navigate',
          issueType: 'timeout',
          windowId: 'window-2',
        },
        [
          {
            caseFamily: 'browser.automation',
            capability: 'browser.automation',
            operation: 'navigate',
            issueType: 'timeout',
            windowId: 'window-1',
            traceId: '',
          },
        ],
        '2026-08-05T00:00:00.000Z',
      ),
    ).toThrow(/history\[0\]\.traceId/)
  })
})
