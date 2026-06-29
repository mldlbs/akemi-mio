import type { ServerManager } from '../../mcp/ServerManager';
import type { IModule, HealthCheckResult, SubsystemState } from '../lifecycle/types';
/**
 * McpModule — MCP ServerManager 的内核模块封装。
 *
 * 标准化生命周期，暴露 MCP 服务器查询和工具列表接口。
 */
export declare class McpModule implements IModule {
    readonly name = "mcp";
    readonly prefix = "src/main/mcp/";
    readonly hotReloadable = false;
    readonly exports: string[];
    state: SubsystemState;
    private mcpManager;
    constructor(mcpManager: ServerManager);
    getExport(name: string): unknown;
    handleSyscall(method: string, _params: unknown): Promise<unknown>;
    init(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    destroy(): Promise<void>;
    healthCheck(): Promise<HealthCheckResult>;
}
