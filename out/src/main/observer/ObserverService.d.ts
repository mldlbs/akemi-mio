import { ObserverLlmService } from './ObserverLlmService';
import { FermentationEngine } from './FermentationEngine';
import { DagStateMachine } from './DagStateMachine';
import { TrendEngine } from './TrendEngine';
import { WorldModelStore } from './WorldModelStore';
import { SelfEvolutionEngine } from './SelfEvolutionEngine';
import type { Collector, FeedbackSignal, EvolutionParams, OutputEnvelope, WritingMode } from './types';
/**
 * ObserverService — 观察者服务（升级版）
 *
 * 混合模式：同时支持 legacy 发酵和新的 DAG 驱动 pipeline。
 * - collectors 独立运行定时采集
 * - legacy ferment 保留（forceFerment 向后兼容）
 * - pipeline 每 4 小时执行一次完整 DAG
 */
export declare class ObserverService {
    private llm;
    private store;
    private fermentation;
    private writingGate;
    private collectors;
    private dag;
    private trend;
    private tension;
    private research;
    private multiBrain;
    private composer;
    private worldModel;
    private selfEvo;
    private output;
    private collectorTimers;
    private pipelineTimer;
    private disposed;
    private lastPipelineDate;
    private pipelineRunning;
    constructor(baseDir?: string);
    addCollector(collector: Collector): void;
    getLlm(): ObserverLlmService;
    getFermentation(): FermentationEngine;
    getDag(): DagStateMachine;
    getTrend(): TrendEngine;
    getWorldModel(): WorldModelStore;
    getSelfEvo(): SelfEvolutionEngine;
    submitFeedback(signal: FeedbackSignal): Promise<EvolutionParams>;
    runPipeline(mode?: WritingMode): Promise<OutputEnvelope | null>;
    start(): Promise<void>;
    stop(): void;
    forceCollect(): Promise<void>;
    forceFerment(): Promise<void>;
    forcePipeline(mode?: WritingMode): Promise<OutputEnvelope | null>;
    private tickPipeline;
}
