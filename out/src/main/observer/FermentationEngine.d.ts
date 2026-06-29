import type { ObserverLlmService } from './ObserverLlmService';
import type { ObserverStore } from './ObserverStore';
import type { AssociationResult } from './types';
/**
 * FermentationEngine — 发酵引擎
 *
 * 读取近期 observations，调用 Observer-Mio 做关联，
 * 输出 association clusters。
 * strength > 0.7 的 cluster 触发写作。
 */
export declare class FermentationEngine {
    private llm;
    private store;
    private writingThreshold;
    constructor(llm: ObserverLlmService, store: ObserverStore);
    /**
     * 执行一次发酵
     * @param sessionLabel 时段标签: 'morning' | 'afternoon' | 'night'
     */
    ferment(sessionLabel: string): Promise<AssociationResult>;
    getWritingThreshold(): number;
    setWritingThreshold(t: number): void;
}
