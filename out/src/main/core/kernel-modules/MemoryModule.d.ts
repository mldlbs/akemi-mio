import type { MemoryService } from '../../memory/MemoryService';
import type { IModule, HealthCheckResult, SubsystemState } from '../lifecycle/types';
/**
 * MemoryModule — MemoryService 的内核模块封装。
 *
 * 标准化生命周期，暴露只读 query 和有限写入 API。
 */
export declare class MemoryModule implements IModule {
    readonly name = "memory";
    readonly prefix = "src/main/memory/";
    readonly hotReloadable = false;
    readonly exports: string[];
    state: SubsystemState;
    private memoryService;
    constructor(memoryService: MemoryService);
    getExport(name: string): unknown;
    handleSyscall(method: string, params: unknown): Promise<unknown>;
    init(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    destroy(): Promise<void>;
    healthCheck(): Promise<HealthCheckResult>;
}
