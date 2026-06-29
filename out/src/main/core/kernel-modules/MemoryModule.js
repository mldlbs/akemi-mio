import { log } from '../../logger/Logger';
/**
 * MemoryModule — MemoryService 的内核模块封装。
 *
 * 标准化生命周期，暴露只读 query 和有限写入 API。
 */
export class MemoryModule {
    constructor(memoryService) {
        this.name = 'memory';
        this.prefix = 'src/main/memory/';
        this.hotReloadable = false;
        this.exports = ['MemoryService'];
        this.state = 'created';
        this.memoryService = memoryService;
    }
    getExport(name) {
        if (name === 'MemoryService')
            return this.memoryService;
        return undefined;
    }
    async handleSyscall(method, params) {
        switch (method) {
            case 'get_stats':
                return {
                    totalEntries: this.memoryService.getEntries().length,
                    interactionCount: this.memoryService.getInteractionCount(),
                };
            case 'get_recent_summaries': {
                const p = params;
                return this.memoryService.summary.getRecent(p?.limit ?? 10);
            }
            case 'flush':
                this.memoryService.flush();
                return { ok: true };
            default:
                throw new Error(`Unknown memory syscall: ${method}`);
        }
    }
    async init() {
        if (this.state !== 'created')
            return;
        this.state = 'initializing';
        log('INFO', 'memory_module.init');
        this.state = 'ready';
    }
    async start() {
        if (this.state !== 'ready')
            return;
        this.state = 'running';
        log('INFO', 'memory_module.started');
    }
    async stop() {
        this.state = 'stopping';
        this.memoryService.shutdown?.();
        log('INFO', 'memory_module.stopped');
        this.state = 'stopped';
    }
    async destroy() {
        log('INFO', 'memory_module.destroyed');
    }
    async healthCheck() {
        return {
            healthy: true,
            detail: `Memory module: ${this.memoryService.getEntries().length} entries`,
        };
    }
}
