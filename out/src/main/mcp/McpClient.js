import { StdioTransport, HttpTransport } from './transport';
let requestId = 0;
export class McpClient {
    constructor(config) {
        this.pending = new Map();
        this.tools = [];
        this.initialized = false;
        this.serverInfo = { name: '', version: '' };
        this.notificationHandler = null;
        this.name = config.name;
        this.rawCommand = config.rawCommand || '';
        this.cwd = config.cwd || '';
        this.requestTimeoutMs = config.requestTimeoutMs ?? 30000;
        this.headers = config.headers || {};
        if (config.transport === 'http' || config.transport === 'sse' || config.url) {
            this.transportType = config.transport === 'sse' ? 'sse' : config.url?.endsWith('/sse') ? 'sse' : 'http';
            this.url = config.url || config.command || '';
            this.transport = new HttpTransport(this.url, this.requestTimeoutMs, this.headers);
        }
        else {
            this.transportType = 'stdio';
            this.url = '';
            this.transport = new StdioTransport(config.command, config.args, config.env, config.cwd);
        }
        this.transport.onMessage((data) => this.handleResponse(data));
    }
    handleResponse(data) {
        // JSON-RPC notification (no id field) — server-initiated message
        const maybeNotification = data;
        if (data.id == null && maybeNotification.method) {
            this.notificationHandler?.(maybeNotification.method, maybeNotification.params);
            return;
        }
        const pending = this.pending.get(data.id);
        if (!pending)
            return;
        this.pending.delete(data.id);
        if (data.error) {
            pending.reject(new Error(data.error.message));
        }
        else {
            pending.resolve(data.result);
        }
    }
    /** 注册通知处理回调（处理 MCP Notification / 服务端主动推送的消息） */
    onNotification(handler) {
        this.notificationHandler = handler;
    }
    async request(method, params) {
        const id = ++requestId;
        const msg = { jsonrpc: '2.0', id, method, params };
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`MCP request timeout: ${method}`));
            }, this.requestTimeoutMs);
            this.pending.set(id, {
                resolve: (v) => {
                    clearTimeout(timeout);
                    resolve(v);
                },
                reject: (e) => {
                    clearTimeout(timeout);
                    reject(e);
                },
            });
            this.transport.send(JSON.stringify(msg)).catch(reject);
        });
    }
    async initialize() {
        if (this.initialized)
            return;
        const result = (await this.request('initialize', {
            protocolVersion: '0.1.0',
            capabilities: {},
            clientInfo: { name: 'akemi-mio', version: '1.0.0' },
        }));
        // 兼容性处理：部分 MCP 服务器可能未返回 serverInfo
        this.serverInfo = result.serverInfo || { name: this.name, version: '0.0.0' };
        // 服务端 capabilities 缺失时使用空对象兜底（兼容旧版 MCP 协议实现）
        if (!result.capabilities) {
            ;
            result.capabilities = {};
        }
        // SSE 传输需要建立长期连接以接收服务端推送通知
        if (this.transportType === 'sse') {
            try {
                await this.transport.connectSSE();
            }
            catch (err) {
                console.error(`[MCP] SSE connect failed for ${this.name}:`, err);
            }
        }
        this.initialized = true;
        console.log(`[MCP] Initialized: ${this.serverInfo.name} v${this.serverInfo.version}`);
    }
    async discoverTools() {
        if (!this.initialized)
            await this.initialize();
        const result = await this.request('tools/list');
        this.tools = result?.tools || [];
        return this.tools;
    }
    async callTool(name, args) {
        if (!this.initialized)
            await this.initialize();
        const result = await this.request('tools/call', { name, arguments: args });
        return result;
    }
    getToolDefinitions() {
        return this.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.inputSchema?.properties || {},
            required: t.inputSchema?.required || [],
            serverName: this.name,
        }));
    }
    isInitialized() {
        return this.initialized;
    }
    getServerInfo() {
        return this.serverInfo;
    }
    getLaunchCommand() {
        return this.rawCommand;
    }
    /** Ping 检查服务器是否存活 */
    async ping() {
        try {
            await this.request('ping', {});
            return true;
        }
        catch {
            return false;
        }
    }
    async shutdown() {
        // 拒绝所有 pending 请求，防止进行中的工具调用挂起直到超时
        const err = new Error('MCP client shutdown');
        for (const [, pending] of this.pending) {
            pending.reject(err);
        }
        this.pending.clear();
        try {
            await this.request('shutdown');
        }
        catch {
            /* ignore */
        }
        await this.transport.close();
        this.initialized = false;
    }
}
