import type { Observation, AssociationResult, DailyObservations, TrendReport, TopicSelection, ResearchResult, BrainOutput, InsightOutput, WorldModelSnapshot, EvolutionParams, FeedbackSignal, UserFeedback, TrendLatencyRecord } from './types';
/**
 * ObserverStore — 观察数据的持久化层
 *
 * 扩展后同时支持：
 * - 原有：observations / associations / essays
 * - 新增：trends / topics / research / brains / insights /
 *          world_model / evolution (params + feedback)
 */
export declare class ObserverStore {
    readonly baseDir: string;
    readonly observationsDir: string;
    readonly associationsDir: string;
    readonly essaysDir: string;
    readonly trendsDir: string;
    readonly topicsDir: string;
    readonly researchDir: string;
    readonly brainsDir: string;
    readonly insightsDir: string;
    readonly worldModelDir: string;
    readonly evolutionDir: string;
    constructor(baseDir?: string);
    /** 生成去重指纹 */
    private fingerprint;
    store(observations: Observation[]): void;
    readDaily(date: string): DailyObservations;
    readRecent(days: number): Observation[];
    saveAssociation(result: AssociationResult): void;
    readRecentAssociations(limit?: number): AssociationResult[];
    saveEssay(content: string, type?: 'draft' | 'published'): string;
    saveTrendReport(report: TrendReport): string;
    readTrendReport(date?: string): TrendReport | null;
    saveTopicSelection(selection: TopicSelection): string;
    readTopicSelection(date?: string): TopicSelection | null;
    /** 获取最近 days 天的选题，用于多样性计算 */
    getRecentTopics(days?: number): TopicSelection[];
    saveResearchResult(topicId: string, result: ResearchResult): string;
    readResearchResult(topicId: string): ResearchResult | null;
    saveBrainOutputs(topicId: string, outputs: BrainOutput[]): string;
    readBrainOutputs(topicId: string): BrainOutput[] | null;
    saveInsight(insight: InsightOutput): string;
    readInsight(id: string): InsightOutput | null;
    saveWorldModel(snapshot: WorldModelSnapshot): void;
    readWorldModel(): WorldModelSnapshot;
    saveEvolutionParams(params: EvolutionParams): void;
    readEvolutionParams(): EvolutionParams | null;
    saveFeedback(signal: FeedbackSignal): void;
    readFeedback(date?: string): FeedbackSignal[];
    readRecentFeedback(days?: number): FeedbackSignal[];
    saveUserFeedback(feedback: UserFeedback): void;
    readUserFeedback(topicId: string): UserFeedback | null;
    getAllUserFeedback(): UserFeedback[];
    saveTrendLatency(record: TrendLatencyRecord): void;
    readRecentLatency(days?: number): TrendLatencyRecord[];
}
