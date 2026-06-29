import { MCPToolDefinition, MCPToolResult, MCPToolSchema } from '../mcp/types';
import type { CapabilityAction } from '../capability/types';
export interface Tool<I = Record<string, any>, O = MCPToolResult> {
    name: string;
    description: string;
    inputJSONSchema: {
        type: 'object';
        properties: Record<string, any>;
        required: string[];
    };
    handler: (args: I) => Promise<O>;
    /** MCP serverName 标识，默认 '@builtin/core' */
    serverName?: string;
    /** 只读工具（无需写入权限检查） */
    isReadOnly?: boolean;
    /** 是否启用 */
    isEnabled?: boolean;
    /** Phase 4: 工具所需的能力（用于 CapabilityEngine 授权检查） */
    requiredCapability?: CapabilityAction;
}
export type ToolDef<I = Record<string, any>, O = MCPToolResult> = {
    name: string;
    description: string;
    inputJSONSchema: Tool['inputJSONSchema'];
    handler: (args: I) => Promise<O>;
    serverName?: string;
    isReadOnly?: boolean;
    isEnabled?: boolean;
};
export declare function buildTool<I = Record<string, any>, O = MCPToolResult>(def: ToolDef<I, O>): Tool<I, O>;
export declare function toMCPToolDefinition(tool: Tool): MCPToolDefinition;
export declare function toMCPToolSchema(tool: Tool): MCPToolSchema;
export declare function formatToolResult(text: string): MCPToolResult;
export declare function formatToolError(text: string): MCPToolResult;
