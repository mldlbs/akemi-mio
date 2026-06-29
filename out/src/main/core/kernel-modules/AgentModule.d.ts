import type { AgentService } from '../../agent/AgentService';
import type { IModule, HealthCheckResult, SubsystemState } from '../lifecycle/types';
/**
 * AgentModule — AgentService 的内核模块封装。
 *
 * 通过 IModule 标准化生命周期，暴露有限的 syscall API。
 */
export declare class AgentModule implements IModule {
    readonly name = "agent";
    readonly prefix = "src/main/agent/";
    readonly hotReloadable = false;
    readonly exports: string[];
    state: SubsystemState;
    private agentService;
    constructor(agentService: AgentService);
    getExport(name: string): unknown;
    handleSyscall(method: string, params: unknown): Promise<unknown>;
    init(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    destroy(): Promise<void>;
    healthCheck(): Promise<HealthCheckResult>;
}
