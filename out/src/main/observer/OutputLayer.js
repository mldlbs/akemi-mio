import { log } from '../logger/Logger';
const ANOMALY_THRESHOLD = 0.7;
/**
 * OutputLayer — 输出系统（增强版）
 *
 * 升级点：
 * - anomalyScore 计算：基于冲突密度 + 事件速度 + 不确定性
 * - anomalyScore > 0.7 时标记 isAnomaly，供推送层判断
 */
export class OutputLayer {
    constructor(store) {
        this.store = store;
    }
    computeAnomalyScore(insight) {
        const world = this.store.readWorldModel();
        const conflicts = world.narratives.filter((n) => n.title === insight.topic).length > 0 ? 0.5 : 0.2;
        const eventVelocity = world.events.length > 5 ? Math.min(1, world.events.length / 30) : 0.1;
        const uncertainties = (world.uncertainties?.length ?? 0) > 3 ? 0.6 : 0.2;
        return parseFloat(((conflicts + eventVelocity + uncertainties) / 3).toFixed(2));
    }
    async publishInsight(insight, dag, startedAt) {
        const anomalyScore = this.computeAnomalyScore(insight);
        insight.anomalyScore = anomalyScore;
        const isAnomaly = anomalyScore > ANOMALY_THRESHOLD;
        const envelope = {
            type: 'daily_research',
            version: '1.0',
            generatedAt: new Date().toISOString(),
            payload: insight,
            dagState: { taskId: dag.taskId, state: dag.state },
            metadata: {
                taskDurationMs: Date.now() - startedAt,
                llmCalls: insight.metadata.llmCalls,
                cycleStartedAt: dag.startedAt,
            },
            isAnomaly,
        };
        log('INFO', 'output_insight_published', {
            topic: insight.topic,
            anomalyScore,
            isAnomaly,
            duration: `${(envelope.metadata.taskDurationMs / 1000).toFixed(0)}s`,
        });
        if (isAnomaly) {
            log('WARN', 'output_anomaly_detected', { topic: insight.topic, score: anomalyScore });
        }
        return envelope;
    }
    async publishTrendReport(report) {
        return {
            type: 'trend_report',
            version: '1.0',
            generatedAt: report.generatedAt,
            payload: report,
            dagState: { taskId: '', state: 'COMPLETED' },
            metadata: { taskDurationMs: 0, llmCalls: 0, cycleStartedAt: report.generatedAt },
        };
    }
    exportForTelegram(envelope) {
        const p = envelope.payload;
        if (envelope.type === 'daily_research' && p.sections) {
            const anomalyTag = p.anomalyScore && p.anomalyScore > ANOMALY_THRESHOLD ? ' 🚨' : '';
            const parts = [`#obs — ${p.topic}${anomalyTag}\n`];
            for (const s of p.sections)
                parts.push(`*${s.title}*\n${s.content.slice(0, 800)}\n`);
            const text = parts.join('\n');
            return text.length > 4096 ? text.slice(0, 4000) + '\n\n...（截断）' : text;
        }
        return `#obs — Trend Report (${envelope.generatedAt})`;
    }
    exportForApi(envelope) {
        return envelope;
    }
}
