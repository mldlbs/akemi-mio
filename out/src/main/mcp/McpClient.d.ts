import { Transport } from './transport';
import { MCPToolSchema, MCPToolResult, MCPServerConfig, MCPToolDefinition } from './types';
export declare class McpClient {
    readonly name: string;
    readonly rawCommand: string;
    readonly cwd: string;
    readonly transportType: 'stdio' | 'http' | 'sse';
    readonly url: string;
    readonly requestTimeoutMs: number;
    readonly headers: Record<string, string>;
    readonly transport: Transport;
    private pending;
    private tools;
    private initialized;
    private serverInfo;
    private notificationHandler;
    constructor(config: MCPServerConfig);
    private handleResponse;
    /** 注册通知处理回调（处理 MCP Notification / 服务端主动推送的消息） */
    onNotification(handler: (method: string, params?: any) => void): void;
    private request;
    initialize(): Promise<void>;
    discoverTools(): Promise<MCPToolSchema[]>;
    callTool(name: string, args: Record<string, any>): Promise<MCPToolResult>;
    getToolDefinitions(): MCPToolDefinition[];
    isInitialized(): boolean;
    getServerInfo(): {
        name: string;
        version: string;
    };
    getLaunchCommand(): string;
    /** Ping 检查服务器是否存活 */
    ping(): Promise<boolean>;
    shutdown(): Promise<void>;
}
