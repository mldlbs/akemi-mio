import { MCPServerConfig, MCPToolDefinition } from './types';
import { ConstitutionEngine } from '../constitution/ConstitutionEngine';
import { CapabilityEngine } from '../capability/CapabilityEngine';
export declare class ServerManager {
    private servers;
    private local;
    private toolMap;
    private healthCheckTimer;
    private retryStates;
    private constitutionEngine;
    private capabilityEngine;
    /** 每个 MCP 服务器的独立熔断器 */
    private circuitBreakers;
    /** 重启预算：每小时最多 RESTART_BUDGET_MAX 次重启，超限后自动禁用 */
    private restartBudgets;
    private readonly RESTART_BUDGET_WINDOW;
    private readonly RESTART_BUDGET_MAX;
    /** Capability Registry: 记录每个服务器的期望和实际工具集，检测漂移 */
    private capabilityRegistry;
    constructor();
    setConstitutionEngine(engine: ConstitutionEngine): void;
    /** Phase 4: 设置 CapabilityEngine 用于工具调用授权 */
    setCapabilityEngine(engine: CapabilityEngine): void;
    /** 从 mcp_servers.json 自动恢复持久化的 MCP 服务器 */
    private initServers;
    /** 持久化当前所有外部 MCP 服务器配置到 mcp_servers.json */
    private persistServers;
    private indexLocalTools;
    private indexMgrTools;
    addServer(config: MCPServerConfig): Promise<void>;
    removeServer(name: string): Promise<void>;
    getAllSchemas(): Array<{
        type: 'function';
        function: {
            name: string;
            description: string;
            parameters: {
                type: 'object';
                properties: Record<string, {
                    type: string;
                    description: string;
                }>;
                required: string[];
            };
        };
    }>;
    getAllDefinitions(): MCPToolDefinition[];
    hasTool(name: string): boolean;
    callTool(name: string, args: Record<string, any>): Promise<string>;
    private handleMgrTool;
    private formatResult;
    listTools(): string[];
    listServers(): Array<{
        name: string;
        initialized: boolean;
        tools: number;
    }>;
    shutdownAll(): Promise<void>;
    /** 定期健康检查：检测死亡 MCP 进程并自动重启
     *  连接失败后使用指数退避：2s→4s→8s→...→最大60s
     *  成功恢复后重置计数器。
     *
     *  使用递归 setTimeout + jitter 避免大量服务器同时请求：
     *  基础间隔 120s ±15s jitter，熔断中的服务器跳过健康检查。 */
    private startHealthCheck;
    private scheduleHealthCheck;
    /** 记录服务器成功 — 重置熔断器 */
    private recordServerSuccess;
    /** 记录服务器失败 — 连续 3 次触发熔断 60s */
    private recordServerFailure;
    /** Capability Registry v0: 注册/更新服务器工具集，检测漂移 */
    private registerCapabilities;
    /** 获取所有服务器的能力健康汇总 */
    getCapabilitySummary(): {
        totalCapabilityHealth: number;
        servers: Array<{
            name: string;
            healthScore: number;
            driftDetected: boolean;
        }>;
    };
    /** 查询服务器的能力健康状态 */
    getCapabilityHealth(name: string): {
        healthScore: number;
        expectedTools: number;
        actualTools: number;
        missingTools: string[];
    } | null;
    /** 检查并记录重启预算。预算超限返回 false，不再自动重启 */
    private checkRestartBudget;
    /** 带指数退避的重启 */
    private restartServerWithBackoff;
    /** 重启单个 MCP 服务器：移除旧连接 → 重新从持久化配置注册 */
    private restartServer;
    /** Phase 4: 工具名 → CapabilityAction 映射 */
    private toolNameToCapability;
}
