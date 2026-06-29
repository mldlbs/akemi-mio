import type { OnOptions, EventMeta, EventStoreEngine } from './EventBusTypes';
export type EventName = 'task.lifecycle' | 'task.registered' | 'task.unregistered' | 'voice.recording.started' | 'voice.recording.stopped' | 'voice.recognition.completed' | 'agent.input.received' | 'agent.response.generated' | 'agent.error' | 'agent.tool.invoked' | 'agent.tool.completed' | 'agent.tool.failed' | 'agent.plan.created' | 'agent.plan.step' | 'agent.plan.completed' | 'tts.playback.started' | 'tts.playback.finished' | 'scheduler.tick' | 'scheduler.task.completed' | 'scheduler.task.failed' | 'engine.registered' | 'engine.unregistered' | 'engine.activated' | 'evolution.cycle.started' | 'evolution.cycle.completed' | 'insight.analysis.started' | 'insight.detector.completed' | 'insight.candidate.generated' | 'insight.found' | 'insight.analysis.completed' | 'creativity.cycle.started' | 'creativity.cycle.completed' | 'creativity.dream.completed' | 'creativity.ideas.generated' | 'plugin.registered' | 'plugin.unregistered' | 'plugin.error' | 'recovery.checkpoint.created' | 'recovery.session.restored' | 'recovery.error.classified' | 'recovery.recovery.started' | 'recovery.recovery.completed' | 'recovery.context.compress' | 'stability.score.updated' | 'stability.status.changed' | 'budget.exhausted' | 'budget.restored' | 'evolution.snapshot.created' | 'evolution.rollback.completed' | 'evolution.proposal.validated' | 'evolution.plan.outcome' | 'task.graph.cycle_detected' | 'goal.guardrail.rejection' | 'goal.guardrail.tripped' | 'agent.observe' | 'agent.think' | 'agent.reflect' | 'guardrail.readonly_stuck' | 'guardrail.tool_error' | 'guardrail.context_corrupted' | 'runtime.health.updated' | 'skill.enabled' | 'skill.disabled';
export interface EventPayload {
    'task.lifecycle': {
        taskId: string;
        type: string;
        status: string;
        durationMs?: number;
        error?: string;
    };
    'task.registered': {
        type: string;
        label: string;
    };
    'task.unregistered': {
        type: string;
    };
    'voice.recording.started': {};
    'voice.recording.stopped': {};
    'voice.recognition.completed': {
        text: string;
        duration: number;
    };
    'agent.input.received': {
        text: string;
        requestId: string;
        source: 'electron' | 'telegram';
    };
    'agent.response.generated': {
        text: string;
        requestId: string;
        source: 'electron' | 'telegram';
    };
    'agent.error': {
        error: string;
        requestId: string;
    };
    'agent.tool.invoked': {
        tool: string;
        args: Record<string, any>;
    };
    'agent.tool.completed': {
        tool: string;
        result: string;
    };
    'agent.tool.failed': {
        tool: string;
        error: string;
    };
    'agent.plan.created': {
        planId: string;
        title: string;
    };
    'agent.plan.step': {
        planId: string;
        stepIndex: number;
        status: string;
    };
    'agent.plan.completed': {
        planId: string;
    };
    'tts.playback.started': {
        text: string;
    };
    'tts.playback.finished': {};
    'scheduler.tick': {
        taskId: string;
        cron: string;
    };
    'scheduler.task.completed': {
        taskId: string;
        result?: string;
    };
    'scheduler.task.failed': {
        taskId: string;
        error: string;
    };
    'engine.registered': {
        name: string;
        type: string;
    };
    'engine.unregistered': {
        name: string;
    };
    'engine.activated': {
        name: string;
        previous: string | null;
    };
    'evolution.cycle.started': {
        timestamp: number;
        mode?: string;
        failures?: number;
        strategyName?: string;
        historyCount?: number;
    };
    'evolution.cycle.completed': {
        success: boolean;
        summary: string;
        timestamp: number;
        mode?: string;
        planTitle?: string;
        planProgress?: string;
        durationMs?: number;
    };
    'creativity.cycle.started': {};
    'creativity.cycle.completed': {
        count: number;
        hasValue: boolean;
    };
    'creativity.dream.completed': {
        count: number;
        topNovelty: number;
    };
    'creativity.ideas.generated': {
        count: number;
        ideas: {
            id: string;
            title: string;
            idea: string;
            expectedBenefit: string;
            risk: string;
            sourceLabels: string[];
            novelty: number;
            feasibility: number;
            impact: number;
        }[];
    };
    'creativity.hypothesis.selected': {
        id: string;
        title: string;
        idea: string;
        novelty: number;
        feasibility: number;
        impact: number;
        sourceLabels: string[];
        expectedBenefit: string;
        risk: string;
    };
    'insight.analysis.started': {};
    'insight.detector.completed': {
        detector: string;
        findings: number;
    };
    'insight.candidate.generated': {
        count: number;
    };
    'insight.found': {
        count: number;
        insights: {
            id: string;
            title: string;
            score: number;
            confidence: number;
        }[];
    };
    'insight.analysis.completed': {
        count: number;
        hasValue: boolean;
    };
    'plugin.registered': {
        name: string;
        version: string;
        toolCount: number;
    };
    'plugin.unregistered': {
        name: string;
        reason?: string;
    };
    'plugin.error': {
        name: string;
        error: string;
        phase: string;
    };
    'recovery.checkpoint.created': {
        runId: string;
        trigger: string;
        path: string;
    };
    'recovery.session.restored': {
        runId: string;
        hasUnfinishedPlan: boolean;
    };
    'recovery.error.classified': {
        category: string;
        strategy: string;
        retryDelayMs: number;
    };
    'recovery.recovery.started': {
        oldRunId: string;
        error: string;
    };
    'recovery.recovery.completed': {
        newRunId: string;
        success: boolean;
    };
    'recovery.context.compress': {
        beforeTokens: number;
        afterTokens: number;
    };
    'skill.installed': {
        name: string;
        version: string;
        tools: number;
    };
    'skill.uninstalled': {
        name: string;
    };
    'skill.enabled': {
        name: string;
    };
    'skill.disabled': {
        name: string;
        reason?: string;
    };
    'skill.error': {
        name: string;
        error: string;
        phase: string;
    };
    'stability.score.updated': {
        score: number;
        trend: string;
        status: string;
    };
    'stability.status.changed': {
        previous: string;
        current: string;
        score: number;
    };
    'budget.exhausted': {
        resource: string;
        utilization: number;
    };
    'budget.restored': {
        resource: string;
        utilization: number;
    };
    'evolution.snapshot.created': {
        tag: string;
        branch: string;
        timestamp: number;
    };
    'evolution.rollback.completed': {
        level: string;
        ref: string;
        success: boolean;
        error?: string;
    };
    'evolution.proposal.validated': {
        proposalId: string;
        passed: boolean;
        regressionRisk: string;
    };
    'evolution.plan.outcome': {
        success: boolean;
        summary: string;
        planTitle?: string;
        stepsCompleted: number;
        stepsTotal: number;
        hadTimeout: boolean;
        hadRetry: boolean;
        durationMs: number;
    };
    'task.graph.cycle_detected': {
        cycle: string[];
    };
    'goal.guardrail.rejection': {
        reason: string;
        toolName: string;
        step: number;
    };
    'goal.guardrail.tripped': {
        count: number;
        threshold: number;
    };
    'agent.observe': {
        requestId: string;
        step: number;
        proceduresFound: number;
        patternsFound: number;
        durationMs: number;
    };
    'agent.think': {
        requestId: string;
        step: number;
        toolCallCount: number;
        strategyPrompted: boolean;
    };
    'agent.reflect': {
        requestId: string;
        step: number;
        toolResults: number;
        successCount: number;
        summary: string;
        durationMs: number;
    };
    'guardrail.readonly_stuck': {
        count: number;
        consecutiveRounds: number;
    };
    'guardrail.tool_error': {
        tool: string;
        error: string;
        consecutiveErrors: number;
    };
    'guardrail.context_corrupted': {
        error: string;
        details?: string;
    };
    'runtime.health.updated': {
        compositeScore: number;
        compositeLevel: string;
        sessionScore: number;
        capabilityScore: number;
        taskScore: number;
        modelScore: number;
        recommendedActions: string[];
        timestamp: number;
    };
}
export type Listener<E extends EventName> = (payload: EventPayload[E]) => void;
/**
 * 订阅追踪器 — 收集所有 EventBus 订阅的清理函数，统一 dispose
 */
export declare class SubscriptionTracker {
    private disposers;
    add(disposer: () => void): void;
    dispose(): void;
    get count(): number;
}
export declare class EventBus {
    private emitter;
    private static instance;
    private static readonly MAX_LISTENERS;
    /** priority-ordered listeners per event */
    private priorityListeners;
    /** 记录每个事件的订阅来源（label → disposer），用于诊断 */
    private subscriptionLabels;
    private store;
    static getInstance(): EventBus;
    /** Enable event persistence. Call once at boot before any subscribers. */
    enablePersistence(store: EventStoreEngine): void;
    on<E extends EventName>(event: E, listener: Listener<E>, labelOrOpts?: string | OnOptions): () => void;
    /** Register subscription with auto-cleanup via tracker */
    track<E extends EventName>(event: E, listener: Listener<E>, tracker: SubscriptionTracker, labelOrOpts?: string | OnOptions): void;
    off<E extends EventName>(event: E, listener: Listener<E>): void;
    once<E extends EventName>(event: E, listener: Listener<E>): () => void;
    emit<E extends EventName>(event: E, payload: EventPayload[E], meta?: EventMeta): void;
    removeAll(event?: EventName): void;
    listenerCount(event: EventName): number;
    /** 诊断：当前所有活跃订阅概况 */
    getStats(): Record<string, {
        count: number;
        labels: string[];
        priorityBuckets: Record<string, number>;
    }>;
}
export declare const eventBus: EventBus;
