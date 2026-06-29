import type { ObserverLlmService } from './ObserverLlmService';
import type { ObserverStore } from './ObserverStore';
import type { TrendReport } from './types';
/**
 * TrendEngine — 热点引擎
 *
 * 从近期 observations 中提取关键词、计算热度评分、
 * 通过 LLM 语义去重后输出 TrendReport。
 *
 * 评分公式（适配无 views/engagement 的数据源）：
 *   score = log(freq+1)×0.4 + diversity×0.3 + sourceWeight×0.2 + recency×0.1
 */
export declare class TrendEngine {
    private llm;
    private store;
    constructor(llm: ObserverLlmService, store: ObserverStore);
    /**
     * 执行趋势检测
     * @param days  回看天数，默认 3
     */
    detectTrends(days?: number): Promise<TrendReport>;
    private extractKeywords;
    private deduplicate;
    private fallbackCounting;
}
