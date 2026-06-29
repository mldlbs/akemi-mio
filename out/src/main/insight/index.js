import { InsightService } from './InsightService';
import { DrizzleInsightStore } from './DrizzleInsightStore';
import { InsightGenerator } from './InsightGenerator';
import { InsightScorer } from './InsightScorer';
import { PresenceService } from './PresenceService';
export let insightService = null;
export let insightStore = null;
export let presenceService = null;
export function initInsight(filePath, deps, llm, taskRunner) {
    if (!insightService) {
        const presence = new PresenceService();
        presenceService = presence;
        const store = new DrizzleInsightStore();
        insightStore = store;
        insightService = new InsightService(store, presence, deps, llm, undefined, undefined, taskRunner ?? undefined);
    }
    return insightService;
}
export { InsightService, DrizzleInsightStore, InsightGenerator, InsightScorer, PresenceService };
