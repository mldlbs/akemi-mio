import { CreativityService } from './CreativityService';
import { DrizzleIdeaStore } from './DrizzleIdeaStore';
export let creativityService = null;
export let ideaStore = null;
export function initCreativity(filePath, deps, chatJson, temperature = 0.3, reportDir = '', taskRunner, observerDir, chatJsonWithCode) {
    if (!creativityService) {
        const store = new DrizzleIdeaStore();
        ideaStore = store;
        creativityService = new CreativityService(store, deps, chatJson, chatJsonWithCode, temperature, undefined, undefined, reportDir, taskRunner ?? undefined, observerDir);
    }
    return creativityService;
}
export { CreativityService, DrizzleIdeaStore };
export * from './types';
