import { describe, expect, it, vi } from 'vitest'
import { TaskOrchestrationModeManager } from '@akemi-mio/evolution/behavior/TaskOrchestrationModeManager'

function driveToSimplified(): TaskOrchestrationModeManager {
  const manager = new TaskOrchestrationModeManager()
  // 连续 2 次失败 → normal → simplified
  manager.recordToolBatchResult([{ name: 'read_file', success: false, error: 'boom' }])
  manager.recordToolBatchResult([{ name: 'read_file', success: false, error: 'boom' }])
  return manager
}

describe('TaskOrchestrationModeManager forceExecute guard', () => {
  it('returns no-op recommendations when forced, even in simplified mode', () => {
    const manager = driveToSimplified()
    expect(manager.getCurrentMode()).toBe('simplified')

    const recs = manager.getModeRecommendations(true)
    expect(recs.reduceToolChain).toBe(false)
    expect(recs.addExplanation).toBe(false)
    expect(recs.simplifyPrompt).toBe(false)
    expect(recs.insertProbingQuestion).toBe(false)
    expect(recs.probingQuestionText).toBe('')
    expect(recs.extraPromptModules).toEqual([])
  })

  it('still suggests tool-chain reduction in simplified mode when not forced', () => {
    const manager = driveToSimplified()
    const recs = manager.getModeRecommendations(false)
    expect(recs.reduceToolChain).toBe(true)
    expect(recs.extraPromptModules.length).toBeGreaterThan(0)
  })

  it('does not inject probing questions when forced even after repeated help signals', () => {
    const manager = driveToSimplified()
    for (let i = 0; i < 3; i++) manager.recordUserMessage('帮我看看这个怎么弄')
    expect(manager.getCurrentMode()).toBe('guided')

    const recs = manager.getModeRecommendations(true)
    expect(recs.insertProbingQuestion).toBe(false)
    expect(recs.probingQuestionText).toBe('')
  })
})
