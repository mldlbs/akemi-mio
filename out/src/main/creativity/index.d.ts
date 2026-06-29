import { CreativityService } from './CreativityService';
import { DrizzleIdeaStore } from './DrizzleIdeaStore';
import type { CreativitySource } from './types';
import type { TaskRunner } from '../core/tasks/unified/TaskRunner';
export declare let creativityService: CreativityService | null;
export declare let ideaStore: DrizzleIdeaStore | null;
export declare function initCreativity(filePath: string, deps: {
    getSources: () => CreativitySource[];
    getInsights: () => {
        title: string;
        description: string;
        score: number;
    }[];
    getFailedHypotheses: () => {
        title: string;
        idea: string;
        risk: string;
    }[];
}, chatJson: (userText: string, options?: {
    system?: string;
    temperature?: number;
    timeoutMs?: number;
    requestId?: string;
}) => Promise<{
    data?: any;
    error?: string;
}>, temperature?: number, reportDir?: string, taskRunner?: TaskRunner | null, observerDir?: string, chatJsonWithCode?: (userText: string, options?: {
    system?: string;
    temperature?: number;
    timeoutMs?: number;
    requestId?: string;
}) => Promise<{
    data?: any;
    error?: string;
}>): CreativityService;
export { CreativityService, DrizzleIdeaStore };
export * from './types';
