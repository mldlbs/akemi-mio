import { InsightScorer } from './InsightScorer';
import { INSIGHT_SYSTEM_PROMPT, buildInsightPrompt } from './InsightPrompt';
import { eventBus } from '../core/EventBus';
import { log } from '../logger/Logger';
export class InsightGenerator {
    constructor(llm) {
        this.scorer = new InsightScorer();
        /** 保留原有 detector 引用，但已不再主动运行它们 */
        this.detectors = [];
        this.llm = llm;
    }
    async generate(ctx) {
        const t0 = Date.now();
        log('INFO', 'insight_generation_start', {
            entries: ctx.memoryEntries.length,
            summaries: ctx.summaries.length,
            plans: ctx.plans.length,
        });
        eventBus.emit('insight.analysis.started', {});
        // 无数据时跳过
        if (ctx.memoryEntries.length === 0 && ctx.summaries.length === 0) {
            log('INFO', 'insight_generation_skip_no_data', { duration_ms: Date.now() - t0 });
            return [];
        }
        try {
            // 构造 LLM prompt
            const userPrompt = buildInsightPrompt(ctx);
            // 调 LLM
            const result = await this.llm.chatJson(userPrompt, {
                system: INSIGHT_SYSTEM_PROMPT,
                temperature: 0.3,
                timeoutMs: 15000,
            });
            if (result.error) {
                log('WARN', 'insight_llm_error', { error: result.error, duration_ms: Date.now() - t0 });
                return [];
            }
            const rawDetections = Array.isArray(result.data) ? result.data : [];
            if (rawDetections.length === 0) {
                log('INFO', 'insight_generation_empty', { duration_ms: Date.now() - t0 });
                return [];
            }
            eventBus.emit('insight.candidate.generated', { count: rawDetections.length });
            // 转换 LLM 输出为 RawDetection 格式，继续用 scorer
            const detections = rawDetections.map((d) => ({
                detector: 'insight_llm',
                type: (d.detector === 'conflict' ? 'conflict' : 'hot_topic'),
                severity: d.severity,
                title: d.title,
                description: d.description,
                evidence: d.evidence,
                novelty: d.novelty,
                impact: d.impact,
                actionability: d.actionability,
            }));
            const scored = this.scorer.score(detections, ctx);
            const filtered = this.scorer.filterLowValue(scored);
            log('INFO', 'insight_generation_done', {
                raw: rawDetections.length,
                scored: scored.length,
                filtered: filtered.length,
                duration_ms: Date.now() - t0,
            });
            return filtered;
        }
        catch (err) {
            log('ERROR', 'insight_generation_error', { error: String(err), duration_ms: Date.now() - t0 });
            return [];
        }
    }
}
