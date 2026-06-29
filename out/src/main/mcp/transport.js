import { spawn } from 'child_process';
import { request as httpsRequest } from 'https';
import { request as httpRequest } from 'http';
export class StdioTransport {
    constructor(command, args = [], env, cwd) {
        this.buffer = '';
        this.handler = null;
        this.lineHandler = null;
        this.spawnError = null;
        const mergedEnv = { ...process.env, ...env };
        this.process = spawn(command, args, {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: mergedEnv,
            windowsHide: true,
        });
        this.process.on('error', (err) => {
            this.spawnError = err;
        });
        this.process.stdout?.on('data', (chunk) => {
            this.buffer += chunk.toString();
            const lines = this.buffer.split('\n');
            this.buffer = lines.pop() || '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed)
                    continue;
                try {
                    const data = JSON.parse(trimmed);
                    this.handler?.(data);
                    this.lineHandler?.(trimmed);
                }
                catch {
                    // skip incomplete lines
                }
            }
        });
        this.process.stderr?.on('data', (chunk) => {
            const text = chunk.toString().trim();
            if (text)
                console.error(`[MCP:stdio] ${text}`);
        });
        this.process.on('exit', (code) => {
            console.error(`[MCP:stdio] process exited with code ${code}`);
        });
    }
    async send(message) {
        if (this.spawnError)
            throw this.spawnError;
        return new Promise((resolve, reject) => {
            if (!this.process.stdin?.writable) {
                reject(new Error('stdin not writable'));
                return;
            }
            this.process.stdin.write(message + '\n', (err) => {
                if (err)
                    reject(err);
                else
                    resolve();
            });
        });
    }
    onMessage(handler) {
        this.handler = handler;
    }
    onRawLine(handler) {
        this.lineHandler = handler;
    }
    async close() {
        if (this.spawnError)
            return;
        if (!this.process.killed) {
            this.process.kill();
        }
    }
}
/**
 * HttpTransport — 通过 HTTP/SSE 连接远程 MCP 服务器
 *
 * 遵循 MCP HTTP 传输规范：
 * - 请求通过 POST 发送到 endpoint
 * - 响应通过 SSE (text/event-stream) 接收
 */
export class HttpTransport {
    constructor(url, requestTimeoutMs = 30000, headers = {}) {
        this.handler = null;
        this.reader = null;
        this.abortController = new AbortController();
        this.closed = false;
        this.connected = false;
        // 标准化 URL，移除尾部 /
        this.url = url.replace(/\/+$/, '');
        this.requestTimeoutMs = requestTimeoutMs;
        this.headers = headers;
    }
    async send(message) {
        if (this.closed)
            throw new Error('Transport closed');
        const isSSE = this.url.endsWith('/sse');
        let url;
        if (isSSE) {
            // SSE endpoint 使用 POST 到 message endpoint
            url = this.url.replace(/\/sse$/, '/message');
        }
        else {
            url = this.url;
        }
        const parsed = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const requestFn = isHttps ? httpsRequest : httpRequest;
        return new Promise((resolve, reject) => {
            const options = {
                hostname: parsed.hostname,
                port: parsed.port || (isHttps ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    'Content-Length': Buffer.byteLength(message, 'utf-8'),
                    ...this.headers,
                },
                signal: this.abortController.signal,
                timeout: this.requestTimeoutMs,
            };
            const req = requestFn(options, (res) => {
                let body = '';
                res.on('data', (chunk) => {
                    body += chunk.toString();
                });
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            const data = JSON.parse(body);
                            this.handler?.(data);
                        }
                        catch {
                            // 非 JSON 响应可能是 SSE 或心跳
                            if (body.startsWith('data: ')) {
                                this.parseSSELine(body);
                            }
                        }
                        resolve();
                    }
                    else {
                        reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
                    }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });
            req.write(message);
            req.end();
        });
    }
    /** 启动 SSE 连接监听（仅用于长期订阅的 SSE 端点） */
    async connectSSE() {
        if (this.connected)
            return;
        if (!this.url.endsWith('/sse')) {
            // 非 SSE 模式不需要长期连接
            this.connected = true;
            return;
        }
        const parsed = new URL(this.url);
        const isHttps = parsed.protocol === 'https:';
        const requestFn = isHttps ? httpsRequest : httpRequest;
        return new Promise((resolve, reject) => {
            const options = {
                hostname: parsed.hostname,
                port: parsed.port || (isHttps ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: 'GET',
                headers: {
                    Accept: 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    ...this.headers,
                },
                signal: this.abortController.signal,
            };
            const req = requestFn(options, (res) => {
                if (!res.statusCode || res.statusCode >= 300) {
                    reject(new Error(`SSE connection failed: HTTP ${res.statusCode}`));
                    return;
                }
                this.connected = true;
                resolve();
                let buffer = '';
                res.on('data', (chunk) => {
                    buffer += chunk.toString();
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';
                    for (const line of lines) {
                        this.parseSSELine(line);
                    }
                });
                res.on('end', () => {
                    if (buffer.trim())
                        this.parseSSELine(buffer.trim());
                });
            });
            req.on('error', reject);
            req.end();
        });
    }
    parseSSELine(line) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':'))
            return;
        // SSE data: 前缀处理
        const dataPrefix = 'data: ';
        if (trimmed.startsWith(dataPrefix)) {
            const jsonStr = trimmed.slice(dataPrefix.length).trim();
            try {
                const data = JSON.parse(jsonStr);
                this.handler?.(data);
            }
            catch {
                // 忽略非 JSON SSE 事件
            }
        }
    }
    onMessage(handler) {
        this.handler = handler;
    }
    async close() {
        this.closed = true;
        this.abortController.abort();
        this.connected = false;
        this.handler = null;
    }
}
