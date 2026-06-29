import { MCPResponse } from './types';
export interface Transport {
    send(message: string): Promise<void>;
    onMessage(handler: (data: MCPResponse) => void): void;
    close(): Promise<void>;
}
export declare class StdioTransport implements Transport {
    private process;
    private buffer;
    private handler;
    private lineHandler;
    private spawnError;
    constructor(command: string, args?: string[], env?: Record<string, string>, cwd?: string);
    send(message: string): Promise<void>;
    onMessage(handler: (data: MCPResponse) => void): void;
    onRawLine(handler: (line: string) => void): void;
    close(): Promise<void>;
}
/**
 * HttpTransport — 通过 HTTP/SSE 连接远程 MCP 服务器
 *
 * 遵循 MCP HTTP 传输规范：
 * - 请求通过 POST 发送到 endpoint
 * - 响应通过 SSE (text/event-stream) 接收
 */
export declare class HttpTransport implements Transport {
    private url;
    private requestTimeoutMs;
    private headers;
    private handler;
    private reader;
    private abortController;
    private closed;
    private connected;
    constructor(url: string, requestTimeoutMs?: number, headers?: Record<string, string>);
    send(message: string): Promise<void>;
    /** 启动 SSE 连接监听（仅用于长期订阅的 SSE 端点） */
    connectSSE(): Promise<void>;
    private parseSSELine;
    onMessage(handler: (data: MCPResponse) => void): void;
    close(): Promise<void>;
}
