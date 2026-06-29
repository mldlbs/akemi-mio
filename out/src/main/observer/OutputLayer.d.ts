import type { ObserverStore } from './ObserverStore';
import type { InsightOutput, TrendReport, OutputEnvelope, DagStateFile } from './types';
/**
 * OutputLayer — 输出系统（增强版）
 *
 * 升级点：
 * - anomalyScore 计算：基于冲突密度 + 事件速度 + 不确定性
 * - anomalyScore > 0.7 时标记 isAnomaly，供推送层判断
 */
export declare class OutputLayer {
    private store;
    constructor(store: ObserverStore);
    computeAnomalyScore(insight: InsightOutput): number;
    publishInsight(insight: InsightOutput & {
        anomalyScore?: number;
    }, dag: DagStateFile, startedAt: number): Promise<OutputEnvelope & {
        isAnomaly?: boolean;
    }>;
    publishTrendReport(report: TrendReport): Promise<OutputEnvelope>;
    exportForTelegram(envelope: OutputEnvelope): string;
    exportForApi(envelope: OutputEnvelope): Record<string, unknown>;
}
