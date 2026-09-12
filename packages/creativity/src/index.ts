import { CreativityService } from './CreativityService'
import { DrizzleIdeaStore } from './DrizzleIdeaStore'
import type { CreativitySource } from './types'
import type { TaskRunner } from '@akemi-mio/core/core/tasks/unified/TaskRunner'

export let creativityService: CreativityService | null = null
export let ideaStore: DrizzleIdeaStore | null = null

export function initCreativity(
  filePath: string,
  deps: {
    getSources: () => CreativitySource[]
    getBehaviorSources?: () => CreativitySource[]
    getInsights: () => { title: string; description: string; score: number }[]
    getFailedHypotheses: () => { title: string; idea: string; risk: string }[]
    getExternalSources?: () => CreativitySource[]
    getFeedbackSources?: () => CreativitySource[]
  },
  chatJson: (
    userText: string,
    options?: { system?: string; temperature?: number; timeoutMs?: number; requestId?: string },
  ) => Promise<{ data?: any; error?: string }>,
  temperature = 0.3,
  reportDir = '',
  taskRunner?: TaskRunner | null,
  observerDir?: string,
  chatJsonWithCode?: (
    userText: string,
    options?: { system?: string; temperature?: number; timeoutMs?: number; requestId?: string },
  ) => Promise<{ data?: any; error?: string }>,
): CreativityService {
  if (!creativityService) {
    const store = new DrizzleIdeaStore()
    ideaStore = store
    creativityService = new CreativityService(
      store,
      deps,
      chatJson,
      chatJsonWithCode,
      temperature,
      undefined,
      undefined,
      reportDir,
      taskRunner ?? undefined,
      observerDir,
    )
  }
  return creativityService
}

export { CreativityService, DrizzleIdeaStore }
export { ContentEnhancer } from './ContentEnhancer'
export type { EnhancedSource } from './ContentEnhancer'
export * from './types'

