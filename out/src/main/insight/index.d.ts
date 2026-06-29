import { InsightService } from './InsightService';
import { DrizzleInsightStore } from './DrizzleInsightStore';
import { InsightGenerator } from './InsightGenerator';
import { InsightScorer } from './InsightScorer';
import { PresenceService } from './PresenceService';
import type { TaskRunner } from '../core/tasks/unified/TaskRunner';
export declare let insightService: InsightService | null;
export declare let insightStore: DrizzleInsightStore | null;
export declare let presenceService: PresenceService | null;
export declare function initInsight(filePath: string, deps: {
    getMemoryEntries: () => {
        type: string;
        content: string;
        createdAt: number;
    }[];
    getSummaries: () => string[];
    getInteractionCount: () => number;
    getPlans: () => {
        title: string;
        status: string;
        updatedAt: number;
        steps: {
            status: string;
        }[];
        createdAt: number;
    }[];
}, llm: {
    chatJson: (userText: string, options?: {
        system?: string;
        temperature?: number;
        timeoutMs?: number;
        requestId?: string;
    }) => Promise<{
        data?: any;
        error?: string;
    }>;
}, taskRunner?: TaskRunner | null): InsightService;
export { InsightService, DrizzleInsightStore, InsightGenerator, InsightScorer, PresenceService };
export type { Insight, RawDetection, DetectionContext, InsightTriggerPolicy, ReturnReport, PresenceState } from './types';
