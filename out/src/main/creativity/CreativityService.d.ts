import { EventBus } from '../core/EventBus';
import type { CreativitySource, CreativeIdea, IdeaStoreLike } from './types';
import type { TaskRunner } from '../core/tasks/unified/TaskRunner';
/**
 * CreativityService — 创造力引擎
 *
 * 职责：
 * - 收集多个来源的概念
 * - 周期性触发概念重组（LLM 驱动）
 * - 管理 Hypothesis 生命周期
 * - 在低负载时段进入 Dream Mode
 *
 * 这不是分析系统（Insight），这是发明系统。
 * 分析：发现问题
 * 创造：创造新东西
 */
export declare class CreativityService {
    private generator;
    private store;
    private eventBus;
    private normalTimer;
    private dreamTimer;
    private reportDir;
    private taskRunner?;
    private taskRunnerKeys;
    private sourceBuilder;
    private worldTrendProvider;
    /** 最近一次进化系统执行结果（Phase 3 反馈） */
    private evolutionOutcome;
    private evolutionDisposer;
    /** 轮换的策略序列：每次 cycle 按顺序切换 */
    private strategyCycle;
    private strategyIndex;
    /** 用户正在对话中 — 跳过创造性周期避免抢占 LLM */
    private conversationActive;
    private getSources;
    private getInsights;
    private getFailedHypotheses;
    constructor(store: IdeaStoreLike, deps: {
        getSources: () => CreativitySource[];
        getInsights: () => {
            title: string;
            description: string;
            score: number;
        }[];
        getFailedHypotheses: () => {
            title: string;
            idea: string;
            risk: string;
        }[];
    }, chatJson: (userText: string, options?: {
        system?: string;
        temperature?: number;
        timeoutMs?: number;
        requestId?: string;
    }) => Promise<{
        data?: any;
        error?: string;
    }>, chatJsonWithCode?: (userText: string, options?: {
        system?: string;
        temperature?: number;
        timeoutMs?: number;
        requestId?: string;
    }) => Promise<{
        data?: any;
        error?: string;
    }>, temperature?: number, seed?: number, bus?: EventBus, reportDir?: string, taskRunner?: TaskRunner, observerDir?: string);
    start(): void;
    stop(): void;
    /**
     * 正常创造力周期
     */
    private cycle;
    /**
     * 梦境创造力周期 — 更高随机性、纳入失败历史
     */
    private dreamCycle;
    private persist;
    private report;
    /** 写一份可读的报告到 evolution_workspace */
    private reportCycle;
    private cleanOldReports;
    forceCycle(): Promise<CreativeIdea[]>;
    forceDreamCycle(): Promise<CreativeIdea[]>;
    getStore(): IdeaStoreLike;
}
