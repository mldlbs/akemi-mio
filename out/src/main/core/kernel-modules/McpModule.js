import { log } from '../../logger/Logger';
/**
 * McpModule — MCP ServerManager 的内核模块封装。
 *
 * 标准化生命周期，暴露 MCP 服务器查询和工具列表接口。
 */
export class McpModule {
    constructor(mcpManager) {
        this.name = 'mcp';
        this.prefix = 'src/main/mcp/';
        this.hotReloadable = false;
        this.exports = ['ServerManager'];
        this.state = 'created';
        this.mcpManager = mcpManager;
    }
    getExport(name) {
        if (name === 'ServerManager')
            return this.mcpManager;
        return undefined;
    }
    async handleSyscall(method, _params) {
        switch (method) {
            case 'list_servers':
                return this.mcpManager.listServers();
            case 'list_tools':
                return this.mcpManager.listTools();
            case 'get_server_count':
                return { count: this.mcpManager.listServers().length };
            default:
                throw new Error(`Unknown mcp syscall: ${method}`);
        }
    }
    async init() {
        if (this.state !== 'created')
            return;
        this.state = 'initializing';
        log('INFO', 'mcp_module.init');
        this.state = 'ready';
    }
    async start() {
        if (this.state !== 'ready')
            return;
        this.state = 'running';
        log('INFO', 'mcp_module.started');
    }
    async stop() {
        this.state = 'stopping';
        log('INFO', 'mcp_module.stopped');
        this.state = 'stopped';
    }
    async destroy() {
        log('INFO', 'mcp_module.destroyed');
    }
    async healthCheck() {
        return {
            healthy: true,
            detail: `MCP module: ${this.mcpManager.listServers().length} servers`,
        };
    }
}
