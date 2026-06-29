import type { SelfEvolutionService } from '../../evolution/SelfEvolutionService';
import type { IModule, HealthCheckResult, SubsystemState } from '../lifecycle/types';
/**
 * EvolutionModule — SelfEvolutionService 的内核模块封装。
 *
 * 标准化生命周期，暴露有限监控和触发接口。
 */
export declare class EvolutionModule implements IModule {
    readonly name = "evolution";
    readonly prefix = "src/main/evolution/";
    readonly hotReloadable = false;
    readonly exports: string[];
    state: SubsystemState;
    private evolutionService;
    constructor(evolutionService: SelfEvolutionService);
    getExport(name: string): unknown;
    handleSyscall(method: string, params: unknown): Promise<unknown>;
    init(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    destroy(): Promise<void>;
    healthCheck(): Promise<HealthCheckResult>;
}
