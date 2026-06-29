/**
 * MetaController — P3 记忆层级编排
 *
 * 职责：
 * 1. P0→P1 沉淀：每个交互结束时判断是否需要生成摘要和决策记录
 * 2. P1→P2 提纯：周期性将摘要/决策提纯为长期记忆
 * 3. 策略自适应：根据负载和命中率调整各层参数
 * 4. 后台优化：去重/沉默证据清洗/老旧决策过期
 *
 * 区别于 MetaCycle（长期自我评估，LLM 驱动的身份/特质/模式分析），
 * MetaController 是轻量策略引擎，纯本地逻辑，<10ms。
 */
import { log } from '../logger/Logger';
export const DEFAULT_POLICY = {
    summaryFrequency: 5,
    summaryTokenThreshold: 0.7,
    decisionLogChance: 1.0,
    consolidationInterval: 30 * 60 * 1000,
    consolidationMinEntries: 10,
    pruneAggressiveness: 0.5,
    lastAdaptation: Date.now(),
};
export class MetaController {
    constructor(policy) {
        this.stats = {
            totalInteractions: 0,
            summariesCreated: 0,
            decisionsLogged: 0,
            consolidationsRun: 0,
            lastConsolidation: 0,
            memoryHitRate: 0,
            totalQueries: 0,
            hitQueries: 0,
        };
        this.summary = null;
        this.decisions = null;
        this.memory = null;
        this.tickSinceLastSummary = 0;
        this.policy = { ...DEFAULT_POLICY, ...policy };
    }
    setDeps(deps) {
        this.summary = deps.summary;
        this.decisions = deps.decisions;
        this.memory = deps.memory;
    }
    getPolicy() {
        return this.policy;
    }
    getStats() {
        return this.stats;
    }
    // ══════════════════════════════════════════
    //  P0→P1 沉淀
    // ══════════════════════════════════════════
    onInteractionEnd(context) {
        this.stats.totalInteractions++;
        this.tickSinceLastSummary++;
        if (this.shouldSummarize(context)) {
            this.createSummary(context);
        }
        if (this.shouldLogDecision()) {
            this.logDecision(context);
        }
        if (this.stats.totalInteractions % 10 === 0) {
            this.adaptPolicy();
        }
    }
    shouldSummarize(context) {
        const freqTrigger = this.tickSinceLastSummary >= this.policy.summaryFrequency;
        const tokenRatio = context.tokenBudget > 0 ? context.tokenUsed / context.tokenBudget : 0;
        const tokenTrigger = tokenRatio >= this.policy.summaryTokenThreshold;
        return freqTrigger || tokenTrigger;
    }
    shouldLogDecision() {
        if (this.policy.decisionLogChance >= 1.0)
            return true;
        return Math.random() < this.policy.decisionLogChance;
    }
    createSummary(context) {
        this.tickSinceLastSummary = 0;
        const turnEnd = Date.now();
        const summaryText = context.assistantReply
            ? `用户: ${context.userMessage.slice(0, 60)} → ${context.assistantReply.slice(0, 60)}`
            : context.userMessage.slice(0, 80);
        this.summary?.addSummary(summaryText, this.stats.totalInteractions, turnEnd, {
            topics: [],
            decisions: context.planActive ? ['计划活跃中'] : [],
            keyEntities: [],
        });
        this.stats.summariesCreated++;
    }
    logDecision(context) {
        this.decisions?.record({
            agentId: context.agentId || 'chat',
            category: context.planActive ? 'plan_route' : 'tool_select',
            context: context.userMessage.slice(0, 200),
            choice: context.planActive ? '按当前计划执行' : '自然对话回复',
            confidence: 0.5,
        });
        this.stats.decisionsLogged++;
    }
    // ══════════════════════════════════════════
    //  P1→P2 提纯 + 后台优化
    // ══════════════════════════════════════════
    async backgroundOptimization() {
        const now = Date.now();
        if (now - this.stats.lastConsolidation < this.policy.consolidationInterval)
            return;
        log('INFO', 'meta_controller_optimization_start');
        const t0 = Date.now();
        const allSummaries = this.summary?.getAll() || [];
        if (allSummaries.length >= this.policy.consolidationMinEntries) {
            this.consolidateSummaries(allSummaries);
        }
        this.memory?.flush();
        if (this.stats.totalInteractions > 0 && this.policy.pruneAggressiveness > 0) {
            this.decisions?.query({ limit: 100 });
        }
        this.stats.lastConsolidation = now;
        this.stats.consolidationsRun++;
        log('INFO', 'meta_controller_optimization_done', {
            elapsed: Date.now() - t0,
            summaries: allSummaries.length,
        });
    }
    consolidateSummaries(all) {
        const MAX_SUMMARIES = 50;
        if (all.length < MAX_SUMMARIES * 0.5)
            return;
        const keep = all.slice(-30);
        const old = all.slice(0, all.length - 30);
        if (old.length < 2)
            return;
        const mergedTopics = [...new Set(old.flatMap((s) => s.topics || []))].slice(0, 10);
        const mergedDecisions = old
            .flatMap((s) => s.decisions || [])
            .filter(Boolean)
            .slice(0, 5);
        const combined = `【历史合并】${old.length} 条对话摘要的综合记录。`;
        this.summary?.addSummary(combined, old[0]?.turnStart || 0, old[old.length - 1]?.turnEnd || Date.now(), {
            topics: mergedTopics,
            decisions: mergedDecisions,
            keyEntities: [],
        });
        log('INFO', 'summaries_consolidated', { old: old.length, kept: keep.length });
    }
    // ══════════════════════════════════════════
    //  策略自适应
    // ══════════════════════════════════════════
    recordMemoryQuery(hit) {
        this.stats.totalQueries++;
        if (hit)
            this.stats.hitQueries++;
        if (this.stats.totalQueries > 50) {
            this.stats.totalQueries = 25;
            this.stats.hitQueries = Math.round(this.stats.hitQueries / 2);
        }
        this.stats.memoryHitRate = this.stats.totalQueries > 0 ? this.stats.hitQueries / this.stats.totalQueries : 0;
    }
    adaptPolicy() {
        const now = Date.now();
        if (now - this.policy.lastAdaptation < 60000)
            return;
        this.policy.lastAdaptation = now;
        if (this.stats.memoryHitRate > 0.8 && this.stats.totalQueries > 10) {
            this.policy.summaryFrequency = Math.min(this.policy.summaryFrequency + 1, 15);
        }
        if (this.stats.memoryHitRate < 0.4 && this.stats.totalQueries > 10) {
            this.policy.summaryFrequency = Math.max(this.policy.summaryFrequency - 1, 2);
        }
        log('INFO', 'meta_policy_adapted', {
            summaryFrequency: this.policy.summaryFrequency,
            hitRate: this.stats.memoryHitRate.toFixed(2),
        });
    }
}
