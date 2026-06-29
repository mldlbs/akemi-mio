import { type CoreIdentity, type EvolvedTrait, type GrowthMetrics, type TraitUpdateInput, type SessionType } from './IdentitySchema';
export declare class IdentityModule {
    private core;
    private traits;
    private metrics;
    /**
     * 从 CONSTITUTION.md 初始化/更新身份。
     * 首次运行：解析文件 → 写入 DB → 加载到内存
     * 后续运行：计算 hash → 比对 DB → 若有变化则重新解析，否则从 DB 直接加载
     */
    initialize(constitutionPath: string): Promise<void>;
    /** 构建可注入 system prompt 的自我认知段落 */
    getFormattedContext(): string;
    getCoreIdentity(): CoreIdentity | null;
    getTraits(): EvolvedTrait[];
    getMetrics(): GrowthMetrics | null;
    /** 完整的身份快照（用于外部查询、MetricsCollector、API 暴露） */
    getSnapshot(): {
        core: CoreIdentity | null;
        traits: EvolvedTrait[];
        metrics: GrowthMetrics | null;
    };
    /**
     * 根据本次回合的反馈更新特质。
     * 使用指数移动平均 (EMA) 平滑更新。
     */
    updateTraits(input: TraitUpdateInput): void;
    /** 记录一次完整会话结束 */
    recordSession(type: SessionType, averageScore: number): void;
    /** 记录一次工具调用 */
    recordToolCall(): void;
    /** 记录目标漂移事件 */
    recordGoalDrift(): void;
    private reasonToTrait;
    private computeTrend;
    private parseConstitution;
    private splitSections;
    private parseYamlField;
    private parseBulletList;
    private hashContent;
    private loadFromDb;
    private loadTraits;
    private loadMetrics;
    private upsertCore;
    private upsertMetrics;
    private persistTrait;
    private persistMetrics;
    private ensureMetricsLoaded;
    private emptyMetrics;
    private rowToMap;
}
