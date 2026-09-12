import { InsightService } from '@akemi-mio/intelligence-insight/InsightService'
import { DrizzleInsightStore } from '@akemi-mio/intelligence-insight/DrizzleInsightStore'
import { InsightGenerator } from '@akemi-mio/intelligence-insight/InsightGenerator'
import { InsightScorer } from '@akemi-mio/intelligence-insight/InsightScorer'
import { PresenceService } from '@akemi-mio/intelligence-insight/PresenceService'
import type { TaskRunner } from '@akemi-mio/core/core/tasks/unified/TaskRunner'

export let insightService: InsightService | null = null
export let insightStore: DrizzleInsightStore | null = null
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
    const store = new DrizzleInsightStore()
    insightStore = store
    insightService = new InsightService(store, presence, deps, llm, undefined, undefined, taskRunner ?? undefined)
  }
  return insightService
}

export { InsightService, DrizzleInsightStore, InsightGenerator, InsightScorer, PresenceService }
export type { Insight, RawDetection, DetectionContext, InsightTriggerPolicy, ReturnReport, PresenceState } from '@akemi-mio/intelligence-insight/types'
