// ===== buildTool() 工厂 =====
export function buildTool(def) {
    return {
        name: def.name,
        description: def.description,
        inputJSONSchema: def.inputJSONSchema,
        handler: def.handler,
        serverName: def.serverName ?? '@builtin/core',
        isReadOnly: def.isReadOnly ?? false,
        isEnabled: def.isEnabled ?? true,
    };
}
// ===== 向后兼容转换 =====
export function toMCPToolDefinition(tool) {
    return {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputJSONSchema.properties,
        required: tool.inputJSONSchema.required,
        serverName: tool.serverName ?? '@builtin/core',
    };
}
export function toMCPToolSchema(tool) {
    return {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputJSONSchema,
    };
}
export function formatToolResult(text) {
    return { content: [{ type: 'text', text }], isError: false };
}
export function formatToolError(text) {
    return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true };
}
