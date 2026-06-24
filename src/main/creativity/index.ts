import { CreativityService } from './CreativityService'
import { DrizzleIdeaStore } from './DrizzleIdeaStore'
import type { CreativitySource } from './types'
import type { TaskRunner } from '../core/tasks/unified/TaskRunner'

export let creativityService: CreativityService | null = null
export let ideaStore: DrizzleIdeaStore | null = null

export function initCreativity(
  filePath: string,
  deps: {
    getSources: () => CreativitySource[]
    getInsights: () => { title: string; description: string; score: number }[]
    getFailedHypotheses: () => { title: string; idea: string; risk: string }[]
  },
  chatJson: (
    userText: string,
    options?: { system?: string; temperature?: number; timeoutMs?: number; requestId?: string },
  ) => Promise<{ data?: any; error?: string }>,
  temperature = 0.3,
  reportDir = '',
  taskRunner?: TaskRunner | null,
  observerDir?: string,
): CreativityService {
  if (!creativityService) {
    const store = new DrizzleIdeaStore()
    ideaStore = store
    creativityService = new CreativityService(
      store,
      deps,
      chatJson,
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
export * from './types'
