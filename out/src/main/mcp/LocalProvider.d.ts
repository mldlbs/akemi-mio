import type { MCPToolDefinition, MCPToolResult } from './types';
export declare function setMemoryService(ms: any): void;
/**
 * LocalProvider — 向后兼容适配器。
 * 所有工具实现已迁移到 src/main/tool/definitions/ 下独立文件，
 * 通过 LocalProviderAdapter 统一派发。
 */
export declare class LocalProvider {
    readonly name = "@builtin/core";
    getToolDefinitions(): MCPToolDefinition[];
    callTool(name: string, args: Record<string, any>): Promise<MCPToolResult>;
}
export declare const WORKSPACE_DIR: string;
