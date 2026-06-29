import { EventBus } from '../core/EventBus';
import { PresenceService } from './PresenceService';
import type { InsightTriggerPolicy, ReturnReport, InsightStoreLike } from './types';
import type { TaskRunner } from '../core/tasks/unified/TaskRunner';
export declare class InsightService {
    private generator;
    private store;
    private presence;
    private eventBus;
    private policy;
    private checkTimer;
    private taskRunner?;
    private lastAnalysis;
    private messagesAtLastAnalysis;
    private eventsAtLastAnalysis;
    private minAnalysisInterval;
    private messageCount;
    private eventCount;
    private getMemoryEntries;
    private getSummaries;
    private getInteractionCount;
    private getPlans;
    constructor(store: InsightStoreLike, presence: PresenceService, deps: {
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
    }, policy?: Partial<InsightTriggerPolicy>, bus?: EventBus, taskRunner?: TaskRunner);
    start(): void;
    stop(): void;
    private tryAnalyze;
    private runAnalysis;
    private onReturn;
    private buildReturnReport;
    getReturnReport(): ReturnReport;
    getStore(): InsightStoreLike;
    forceAnalysis(): Promise<void>;
}
