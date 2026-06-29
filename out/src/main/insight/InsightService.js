import { eventBus } from '../core/EventBus';
import { log } from '../logger/Logger';
import { InsightGenerator } from './InsightGenerator';
import { DEFAULT_TRIGGER_POLICY, MIN_REPORT_SCORE, MIN_REPORT_CONFIDENCE } from './types';
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
export class InsightService {
    constructor(store, presence, deps, llm, policy, bus, taskRunner) {
        this.checkTimer = null;
        this.lastAnalysis = 0;
        this.messagesAtLastAnalysis = 0;
        this.eventsAtLastAnalysis = 0;
        this.minAnalysisInterval = 4 * 60 * 60 * 1000;
        this.messageCount = 0;
        this.eventCount = 0;
        this.store = store;
        this.presence = presence;
        this.generator = new InsightGenerator(llm);
        this.eventBus = bus || eventBus;
        this.policy = { ...DEFAULT_TRIGGER_POLICY, ...policy };
        this.taskRunner = taskRunner;
        this.getMemoryEntries = deps.getMemoryEntries;
        this.getSummaries = deps.getSummaries;
        this.getInteractionCount = deps.getInteractionCount;
        this.getPlans = deps.getPlans;
        this.eventBus.on('agent.input.received', () => {
            this.messageCount++;
            this.eventCount++;
        });
        this.eventBus.on('agent.tool.invoked', () => {
            this.eventCount++;
        });
        this.eventBus.on('agent.tool.completed', () => {
            this.eventCount++;
        });
        this.presence.onTransition((from, to) => {
            if (from === 'away' && to === 'active') {
                this.onReturn();
            }
        });
    }
    start() {
        if (this.taskRunner) {
            this.taskRunner.register('insight.analysis', async () => {
                this.presence.tick();
                this.tryAnalyze();
                return { success: true };
            }, CHECK_INTERVAL_MS);
            return;
        }
        if (this.checkTimer)
            return;
        // 固定间隔 + 随机偏移 ±2 分钟，避免与系统时钟同步
        const jitter = Math.floor((Math.random() - 0.5) * 4 * 60 * 1000);
        const interval = CHECK_INTERVAL_MS + jitter;
        this.checkTimer = setInterval(() => {
            this.presence.tick();
            this.tryAnalyze();
        }, interval);
        log('INFO', 'insight_service_started', { policy: this.policy, interval_ms: interval });
    }
    stop() {
        if (this.taskRunner) {
            this.taskRunner.stopType('insight.analysis');
            return;
        }
        if (this.checkTimer) {
            clearInterval(this.checkTimer);
            this.checkTimer = null;
        }
        log('INFO', 'insight_service_stopped');
    }
    tryAnalyze() {
        if (!this.presence.isAway())
            return;
        const sinceLastAnalysis = Date.now() - this.lastAnalysis;
        if (sinceLastAnalysis < this.minAnalysisInterval)
            return;
        const newMessages = this.messageCount - this.messagesAtLastAnalysis;
        const newEvents = this.eventCount - this.eventsAtLastAnalysis;
        const awayMinutes = this.presence.getAwayDurationMs() / (60 * 1000);
        if (awayMinutes < this.policy.minIdleMinutes)
            return;
        if (newMessages < this.policy.minNewMessages)
            return;
        if (newEvents < this.policy.minNewEvents)
            return;
        this.messagesAtLastAnalysis = this.messageCount;
        this.eventsAtLastAnalysis = this.eventCount;
        this.lastAnalysis = Date.now();
        this.runAnalysis();
    }
    async runAnalysis() {
        log('INFO', 'insight_analysis_start');
        try {
            const ctx = {
                memoryEntries: this.getMemoryEntries(),
                summaries: this.getSummaries(),
                interactionCount: this.getInteractionCount(),
                plans: this.getPlans(),
                eventCount: this.eventCount,
            };
            const insights = await this.generator.generate(ctx);
            if (insights.length === 0) {
                log('INFO', 'insight_analysis_none');
                this.eventBus.emit('insight.analysis.completed', { count: 0, hasValue: false });
                return;
            }
            this.store.addMany(insights);
            const highValue = insights.filter((i) => i.score >= MIN_REPORT_SCORE && i.confidence >= MIN_REPORT_CONFIDENCE);
            if (highValue.length > 0) {
                this.eventBus.emit('insight.found', {
                    count: highValue.length,
                    insights: highValue.map((i) => ({ id: i.id, title: i.title, score: i.score, confidence: i.confidence })),
                });
                log('INFO', 'insight_analysis_value_found', { count: highValue.length });
            }
            this.eventBus.emit('insight.analysis.completed', { count: insights.length, hasValue: highValue.length > 0 });
        }
        catch (err) {
            log('ERROR', 'insight_analysis_error', { error: String(err) });
            this.eventBus.emit('insight.analysis.completed', { count: 0, hasValue: false });
        }
    }
    onReturn() {
        const report = this.buildReturnReport();
        if (!report.hasValue) {
            log('INFO', 'insight_return_silent');
            return;
        }
        log('INFO', 'insight_return_report', { count: report.insights.length, message: report.message.slice(0, 100) });
        for (const insight of report.insights) {
            this.store.markReported(insight.id);
        }
    }
    buildReturnReport() {
        const pending = this.store.getHighValueUnreported(MIN_REPORT_SCORE, MIN_REPORT_CONFIDENCE);
        if (pending.length === 0) {
            return { hasValue: false, insights: [], message: '' };
        }
        // 概率加权选择：得分越高的 insight 被选中的概率越大
        // 同时加入时间衰减：越旧的 insight 选择概率递减
        const now = Date.now();
        const weights = pending.map((insight, i) => {
            const scoreWeight = insight.score / 100;
            // 时间衰减：每 24 小时衰减 20%
            const ageHours = (now - insight.createdAt) / (1000 * 60 * 60);
            const decayFactor = Math.max(0.1, 1 - (ageHours / 24) * 0.2);
            return scoreWeight * decayFactor;
        });
        const totalWeight = weights.reduce((a, b) => a + b, 0);
        let random = Math.random() * totalWeight;
        let selected = pending[0];
        for (let i = 0; i < pending.length; i++) {
            random -= weights[i];
            if (random <= 0) {
                selected = pending[i];
                break;
            }
        }
        return {
            hasValue: true,
            insights: pending,
            message: `欢迎回来。\n\n我发现了一个可能值得关注的问题。\n\n${selected.title}\n${selected.description}`,
        };
    }
    getReturnReport() {
        return this.buildReturnReport();
    }
    getStore() {
        return this.store;
    }
    forceAnalysis() {
        this.messagesAtLastAnalysis = this.messageCount;
        this.eventsAtLastAnalysis = this.eventCount;
        this.lastAnalysis = Date.now();
        return this.runAnalysis();
    }
}
