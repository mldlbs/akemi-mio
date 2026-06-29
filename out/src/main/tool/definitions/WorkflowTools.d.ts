export declare const analyzeTaskTool: import("..").Tool<{
    task: string;
}, import("../../mcp").MCPToolResult>;
export declare const listWorkflowsTool: import("..").Tool<Record<string, any>, import("../../mcp").MCPToolResult>;
export declare const createWorkflowTool: import("..").Tool<{
    name: string;
    description: string;
    steps: any[];
    tags?: string[];
}, import("../../mcp").MCPToolResult>;
export declare const startWorkflowTool: import("..").Tool<{
    workflowId: string;
}, import("../../mcp").MCPToolResult>;
export declare const getWorkflowStatusTool: import("..").Tool<{
    runId?: string;
}, import("../../mcp").MCPToolResult>;
