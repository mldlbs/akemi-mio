/** 一条观察碎片 */
export interface Observation {
    id: string;
    timestamp: string;
    source: string;
    content: string;
}
/** 发酵后形成的关联簇 */
export interface AssociationCluster {
    theme: string;
    observations: string[];
    associations: string[];
    strength: number;
}
/** 一次发酵结果 */
export interface AssociationResult {
    generatedAt: string;
    clusters: AssociationCluster[];
}
/** 每日观察文件结构 */
export interface DailyObservations {
    date: string;
    observations: Observation[];
}
/** 采集器接口 */
export interface Collector {
    readonly name: string;
    readonly intervalMs: number;
    collect(): Promise<Observation[]>;
}
export type TaskState = 'INIT' | 'COLLECTED' | 'TOPIC_SELECTED' | 'RESEARCHING' | 'ANALYZING' | 'WRITING' | 'STORED' | 'COMPLETED' | 'FAILED';
/** DAG 运行时文件持久化结构 */
export interface DagStateFile {
    taskId: string;
    state: TaskState;
    attempt: number;
    maxAttempts: number;
    startedAt: string;
    timeline: {
        state: TaskState;
        at: string;
        data?: unknown;
    }[];
    data: {
        trendReportPath?: string;
        topicSelectionPath?: string;
        researchResultPath?: string;
        brainOutputPaths?: string[];
        insightPath?: string;
    };
    error?: {
        message: string;
        at: string;
        phase: string;
    };
}
export interface TrendSignal {
    keyword: string;
    score: number;
    sourceDiversity: number;
    source: string;
    firstSeenAt: string;
    lastSeenAt: string;
    occurrenceCount: number;
    recentObservationIds: string[];
}
export interface TrendReport {
    generatedAt: string;
    signals: TrendSignal[];
    topN: number;
    sourceSummary: {
        feedsContacted: number;
        totalItemsReceived: number;
        uniqueKeywords: number;
    };
}
export interface TopicCandidate {
    topic: string;
    popularity: number;
    novelty: number;
    diversity: number;
    memoryGap: number;
    tension: number;
    probability: number;
}
export interface TopicSelection {
    selectedAt: string;
    topic: TopicCandidate;
    fallback: boolean;
    fallbackReason?: string;
}
export type ResearchPhaseName = 'expansion' | 'structural_modeling' | 'conflict_analysis';
export interface ResearchPhase {
    phase: ResearchPhaseName;
    startedAt: string;
    completedAt?: string;
    output?: string;
    error?: string;
}
export interface ResearchResult {
    topicId: string;
    phases: ResearchPhase[];
    facts: string[];
    timeline: {
        time: string;
        event: string;
    }[];
    causalLinks: {
        cause: string;
        effect: string;
        confidence: number;
    }[];
    perspectives: {
        viewpoint: string;
        source: string;
    }[];
    conflicts: {
        partyA: string;
        partyB: string;
        nature: string;
        evidence: string;
    }[];
}
export type BrainName = 'perception' | 'curiosity' | 'analyst' | 'writer';
export interface BrainOutput {
    brain: BrainName;
    generatedAt: string;
    content: string;
    confidence: number;
}
export type WritingMode = 'neutral' | 'analytical' | 'creative';
export interface InsightSection {
    title: string;
    content: string;
}
export interface BrainContributions {
    perception: number;
    curiosity: number;
    analyst: number;
    writer: number;
}
export interface InsightOutput {
    id: string;
    topic: string;
    mode: WritingMode;
    generatedAt: string;
    sections: InsightSection[];
    missingSections?: string[];
    metadata: {
        wordCount: number;
        confidence: number;
        brainContributions: BrainContributions;
        llmCalls: number;
        durationMs: number;
    };
}
export type WorldEntityType = 'person' | 'organization' | 'concept' | 'event' | 'technology';
export interface WorldEntity {
    id: string;
    name: string;
    type: WorldEntityType;
    firstSeen: string;
    lastSeen: string;
    occurrences: number;
    aliases: string[];
    properties: Record<string, unknown>;
}
export interface WorldEvent {
    id: string;
    title: string;
    entityIds: string[];
    timestamp: string;
    summary: string;
    significance: number;
}
export type TrendDirection = 'rising' | 'falling' | 'stable';
export interface WorldTrend {
    id: string;
    name: string;
    direction: TrendDirection;
    momentum: number;
    relatedEventIds: string[];
    relatedEntityIds: string[];
}
export interface NarrativeEvolution {
    at: string;
    summary: string;
}
export interface WorldNarrative {
    id: string;
    title: string;
    eventIds: string[];
    entityIds: string[];
    confidence: number;
    lastUpdated: string;
    evolution: NarrativeEvolution[];
}
export interface WorldUncertainty {
    id: string;
    topic: string;
    description: string;
    confidence: number;
    source: string;
    createdAt: string;
}
export type RelationType = 'conflict' | 'supports' | 'causes' | 'part_of' | 'opposes' | 'influences';
export interface WorldRelation {
    from: string;
    to: string;
    type: RelationType;
    weight: number;
}
export interface WorldModelSnapshot {
    entities: WorldEntity[];
    events: WorldEvent[];
    trends: WorldTrend[];
    narratives: WorldNarrative[];
    uncertainties?: WorldUncertainty[];
    relations?: WorldRelation[];
}
export type FeedbackDimension = 'usefulness' | 'novelty' | 'correctness';
export interface FeedbackSignal {
    source: string;
    dimension: FeedbackDimension;
    value: number;
    topicId: string;
    timestamp: string;
    comment?: string;
    latencyMs?: number;
}
export interface UserFeedback {
    topicId: string;
    rating: 1 | 2 | 3 | 4 | 5;
    comment?: string;
    timestamp: string;
}
export interface TrendLatencyRecord {
    topic: string;
    firstSeenAt: string;
    pipelineDetectedAt: string;
    latencyMs: number;
}
export interface EvolutionWeights {
    alpha: number;
    beta: number;
    gamma: number;
    delta: number;
    epsilon: number;
}
export interface EvolutionThresholds {
    writingGate: number;
    trendMinScore: number;
}
export interface EvolutionParams {
    weights: EvolutionWeights;
    thresholds: EvolutionThresholds;
    version: number;
    updatedAt: string;
}
export type OutputType = 'daily_research' | 'insight' | 'trend_report';
export interface OutputEnvelope {
    type: OutputType;
    version: string;
    generatedAt: string;
    payload: InsightOutput | TrendReport;
    dagState: {
        taskId: string;
        state: string;
    };
    metadata: {
        taskDurationMs: number;
        llmCalls: number;
        cycleStartedAt: string;
    };
}
export declare const DEFAULT_EVOLUTION_WEIGHTS: EvolutionWeights;
export declare const DEFAULT_EVOLUTION_THRESHOLDS: EvolutionThresholds;
export declare const DEFAULT_EVOLUTION_PARAMS: EvolutionParams;
export declare const WRITING_MODE_LABELS: Record<WritingMode, string>;
export declare const INSIGHT_SECTION_TITLES: Record<number, string>;
