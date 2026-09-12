import { InsightService, type TaskRunner } from './InsightService'
import { InsightStore } from './InsightStore'
import { InsightGenerator } from './InsightGenerator'
import { InsightScorer } from './InsightScorer'
import { PresenceService } from './PresenceService'

export let insightService: InsightService | null = null
export let insightStore: InsightStore | null = null
export let presenceService: PresenceService | null = null

export function initInsight(
  filePath: string,
  deps: {
    getMemoryEntries: () => { type: string; content: string; createdAt: number }[]
    getSummaries: () => string[]
    getInteractionCount: () => number
    getPlans: () => { title: string; status: string; updatedAt: number; steps: { status: string }[]; createdAt: number }[]
  },
  llm: {
    chatJson: (
      userText: string,
      options?: { system?: string; temperature?: number; timeoutMs?: number; requestId?: string },
    ) => Promise<{ data?: any; error?: string }>
  },
  taskRunner?: TaskRunner | null,
): InsightService {
  if (!insightService) {
    const presence = new PresenceService()
    presenceService = presence
    const store = new InsightStore(filePath)
    insightStore = store
    insightService = new InsightService(store, presence, deps, llm, undefined, undefined, taskRunner ?? undefined)
  }
  return insightService
}

export { InsightService, InsightStore, InsightGenerator, InsightScorer, PresenceService }
export type { TaskRunner } from './InsightService'
export type { Insight, RawDetection, DetectionContext, InsightTriggerPolicy, ReturnReport, PresenceState } from './types'
