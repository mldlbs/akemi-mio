import { EventBus } from '../core/EventBus';
import { EngineeringMemory } from '../memory/EngineeringMemory';
interface FailureRecord {
    type: 'tool' | 'llm' | 'intent' | 'timeout' | 'crash';
    name: string;
    error: string;
    context: string;
    timestamp: number;
}
interface FailurePattern {
    fingerprint: string;
    count: number;
    firstSeen: number;
    lastSeen: number;
    types: Set<string>;
    names: Set<string>;
    errors: string[];
}
/**
 * FailureAnalyzer — 监听 EventBus 失败事件，聚合失败模式。
 *
 * 与 ReflectLoop 的区别：
 * - ReflectLoop: 每次交互后即时反思（per-interaction）
 * - FailureAnalyzer: 跨交互聚合失败模式（cross-interaction）
 *
 * 两类输出：
 * 1. EngineeringMemory 条目（供 LLM 自我修正）
 * 2. 格式化上下文（注入 system prompt 让 Agent 知道自己容易在哪出问题）
 */
export declare class FailureAnalyzer {
    private failures;
    private patterns;
    private engineering;
    private eventBus;
    private maxRecords;
    private unsubscribers;
    constructor(engineering?: EngineeringMemory, bus?: EventBus);
    setEngineering(eng: EngineeringMemory): void;
    /** 开始监听 EventBus 失败事件 */
    start(): void;
    /** 停止监听 */
    stop(): void;
    /** 手动记录一条失败 */
    record(failure: FailureRecord): void;
    private updatePattern;
    private static readonly DECAY_HALF_LIFE_MS;
    /** Apply time-decay to pattern weight: weight = count * 0.5^(age / halfLife) */
    private applyDecayWeight;
    /** 获取热点失败模式（按时间衰减加权频次排序） */
    getHotPatterns(topK?: number): FailurePattern[];
    /** 将热点模式写入 EngineeringMemory */
    persistHotPatterns(): number;
    /** 格式化上下文，注入 system prompt */
    getFormattedContext(): string;
    getStats(): {
        total: number;
        patterns: number;
        topFailures: string[];
    };
}
export {};
