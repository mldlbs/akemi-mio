/**
 * DecisionStore — P1 决策记录
 *
 * 在每次交互后记录关键决策（工具选择、策略路由、计划调整、恢复），
 * 供 Evolution 和 FailureAnalyzer 查询。
 *
 * ReflectLoop 写入（不再写入 EngineeringMemory 的 failure_pattern）。
 */
export type DecisionCategory = 'tool_select' | 'strategy' | 'plan_route' | 'goal_adjust' | 'recovery';
export type DecisionOutcome = 'pending' | 'success' | 'failure';
export interface FailurePatternGroup {
    pattern: string;
    count: number;
    commonContext: string;
    sampleChoices: string[];
    lastSeen: number;
}
export interface DecisionRecord {
    id: string;
    timestamp: number;
    agentId: string;
    category: DecisionCategory;
    context: string;
    choice: string;
    alternatives: string[];
    outcome: DecisionOutcome;
    confidence: number;
    relatedPlanId?: string;
    createdAt: number;
}
export interface DecisionQuery {
    categories?: DecisionCategory[];
    agentId?: string;
    since?: number;
    until?: number;
    limit?: number;
    outcome?: DecisionOutcome;
}
export declare class DecisionStore {
    /** 写入一条决策记录 */
    record(input: {
        agentId: string;
        category: DecisionCategory;
        context: string;
        choice: string;
        alternatives?: string[];
        confidence?: number;
        relatedPlanId?: string;
        outcome?: DecisionOutcome;
    }): string;
    /** 更新决策结果 */
    updateOutcome(id: string, outcome: DecisionOutcome): void;
    /** 查询决策记录 */
    query(q?: DecisionQuery): DecisionRecord[];
    /** 获取格式化上下文（供 Evolution 和 FailureAnalyzer 使用） */
    getFormattedContext(category?: DecisionCategory, limit?: number): string;
    private prune;
    /** 查询近期失败决策，按 category 分组提取公共模式 */
    getFailurePatterns(options?: {
        since?: number;
        minCount?: number;
    }): FailurePatternGroup[];
    /** 聚合最近 N 天决策摘要 */
    getCrossSessionSummary(days?: number): string;
    private findCommonContext;
}
