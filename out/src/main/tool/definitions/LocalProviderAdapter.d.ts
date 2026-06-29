import type { MCPToolDefinition, MCPToolResult } from '../../mcp/types';
/**
 * 保持向后兼容的适配器 — 将新 Tool 系统转换为 LocalProvider 的旧接口。
 * ServerManager 无需修改即可继续使用。
 */
export declare class LocalProviderAdapter {
    readonly name = "@builtin/core";
    getToolDefinitions(): MCPToolDefinition[];
    callTool(name: string, args: Record<string, any>): Promise<MCPToolResult>;
}
