export declare const centosExecTool: import("..").Tool<{
    command: string;
    timeout?: number;
}, import("../../mcp").MCPToolResult>;
export declare const centosReadFileTool: import("..").Tool<{
    path: string;
}, import("../../mcp").MCPToolResult>;
export declare const centosWriteFileTool: import("..").Tool<{
    path: string;
    content: string;
}, import("../../mcp").MCPToolResult>;
export declare const centosGrepTool: import("..").Tool<{
    pattern: string;
    path?: string;
}, import("../../mcp").MCPToolResult>;
export declare const centosSearchFilesTool: import("..").Tool<{
    pattern: string;
}, import("../../mcp").MCPToolResult>;
