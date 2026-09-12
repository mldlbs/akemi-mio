import { describe, it, expect } from 'vitest'
import { formatExecutionGoalContext } from '@akemi-mio/evolution/goals/executionGoalContext'

describe('formatExecutionGoalContext', () => {
  it('returns empty string when no goals exist', () => {
    expect(formatExecutionGoalContext({ total: 0, active: 0, blocked: 0, completed: 0, abandoned: 0, completionRate: 0 }, [])).toBe('')
  })

  it('includes abandoned in the summary and completion-rate formula', () => {
    const text = formatExecutionGoalContext({ total: 6, active: 1, blocked: 1, completed: 3, abandoned: 1, completionRate: 0.6 }, [])

    expect(text).toContain('总目标: 6')
    expect(text).toContain('完成: 3')
    expect(text).toContain('阻塞: 1')
    expect(text).toContain('放弃: 1')
    expect(text).toContain('完成率: 60%')
    expect(text).toContain('completed/(completed+blocked+abandoned)')
  })

  it('lists methodology breakdown with blocked and abandoned', () => {
    const text = formatExecutionGoalContext({ total: 4, active: 0, blocked: 1, completed: 2, abandoned: 1, completionRate: 0.5 }, [
      { methodology: 'systematic_debugging', total: 3, completed: 2, blocked: 0, abandoned: 1, completionRate: 2 / 3 },
      { methodology: null, total: 1, completed: 0, blocked: 1, abandoned: 0, completionRate: 0 },
    ])

    expect(text).toContain('systematic_debugging: 2/3 完成')
    expect(text).toContain('blocked=0')
    expect(text).toContain('abandoned=1')
    expect(text).toContain('未绑定: 0/1 完成')
    expect(text).toContain('abandoned=0')
  })
})
