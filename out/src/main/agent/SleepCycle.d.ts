/**
 * SleepCycle — 低负载维护循环
 *
 * 职责：
 * - 低负载时触发后台任务（记忆固化、模式挖掘）
 * - 委托 MetaController.backgroundOptimization() 做 P1→P2 提纯
 * - 保留 FailureAnalyzer 模式持久化（与 MetaController 互补）
 *
 * v2 改动：consolidation/memory merge 委托给 MetaController，
 * SleepCycle 保持轻量调度入口角色。
 */
import { MemoryService } from '../memory/MemoryService';
import type { MetaController } from '../memory/MetaController';
import { FailureAnalyzer } from './FailureAnalyzer';
export declare class SleepCycle {
    private memoryService;
    private failureAnalyzer;
    private metaController;
    setDeps(memory: MemoryService, failureAnalyzer: FailureAnalyzer): void;
    setMetaController(mc: MetaController): void;
    run(isBusy: () => boolean): Promise<void>;
    private consolidateMemory;
    private mineFailurePatterns;
}
