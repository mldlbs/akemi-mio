export interface RawDetection {
    detector: string;
    type: 'conflict' | 'hot_topic' | 'stalled_goal' | 'drift' | 'friction';
    severity: 'low' | 'medium' | 'high';
    title: string;
    description: string;
    evidence: string[];
    novelty: number;
    impact: number;
    actionability: number;
}
export interface Insight {
    id: string;
    detector: string;
    title: string;
    description: string;
    evidence: string[];
    score: number;
    confidence: number;
    createdAt: number;
}
export interface InsightStoreLike {
    addMany: (insights: Insight[]) => void;
    getUnreported: () => Insight[];
    getHighValueUnreported: (scoreThreshold?: number, confidenceThreshold?: number) => Insight[];
    markReported: (id: string) => void;
    markAllReported: () => void;
    getAll: () => Insight[];
    prune: (maxAgeDays?: number) => number;
    count: () => number;
}
export interface InsightStoreData {
    version: number;
    insights: Insight[];
    reportedIds: string[];
}
export interface DetectionContext {
    memoryEntries: {
        type: string;
        content: string;
        createdAt: number;
    }[];
    summaries: string[];
    interactionCount: number;
    plans: {
        title: string;
        status: string;
        updatedAt: number;
        steps: {
            status: string;
        }[];
        createdAt: number;
    }[];
    eventCount: number;
}
export interface InsightTriggerPolicy {
    minIdleMinutes: number;
    minNewMessages: number;
    minNewEvents: number;
}
export interface ReturnReport {
    hasValue: boolean;
    insights: Insight[];
    message: string;
}
export type PresenceState = 'active' | 'away';
export declare const STORE_VERSION = 1;
export declare const DEFAULT_TRIGGER_POLICY: InsightTriggerPolicy;
export declare const MIN_REPORT_SCORE = 50;
export declare const MIN_REPORT_CONFIDENCE = 0.7;
