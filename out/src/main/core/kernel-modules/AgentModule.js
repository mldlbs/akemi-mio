import { log } from '../../logger/Logger';
/**
 * AgentModule — AgentService 的内核模块封装。
 *
 * 通过 IModule 标准化生命周期，暴露有限的 syscall API。
 */
export class AgentModule {
    constructor(agentService) {
        this.name = 'agent';
        this.prefix = 'src/main/agent/';
        this.hotReloadable = false;
        this.exports = ['AgentService'];
        this.state = 'created';
        this.agentService = agentService;
    }
    getExport(name) {
        if (name === 'AgentService')
            return this.agentService;
        return undefined;
    }
    async handleSyscall(method, params) {
        switch (method) {
            case 'get_status':
                return { busy: this.agentService['isBusy']?.() ?? false };
            case 'get_context_stats':
                return { messageCount: this.agentService.getContext().getMessages().length ?? 0 };
            case 'inject_system_message': {
                const p = params;
                if (!p?.message)
                    throw new Error('inject_system_message requires "message" param');
                this.agentService.getContext().addSystemMessage?.(p.message);
                return { ok: true };
            }
            case 'clear_context':
                this.agentService.clearContext();
                return { ok: true };
            default:
                throw new Error(`Unknown agent syscall: ${method}`);
        }
    }
    async init() {
        if (this.state !== 'created')
            return;
        this.state = 'initializing';
        log('INFO', 'agent_module.init');
        this.state = 'ready';
    }
    async start() {
        if (this.state !== 'ready')
            return;
        this.state = 'running';
        log('INFO', 'agent_module.started');
    }
    async stop() {
        this.state = 'stopping';
        this.agentService.saveRecoverySnapshot?.('shutdown', 'module_stop');
        log('INFO', 'agent_module.stopped');
        this.state = 'stopped';
    }
    async destroy() {
        log('INFO', 'agent_module.destroyed');
    }
    async healthCheck() {
        return {
            healthy: true,
            detail: `Agent module, ${this.agentService.getContext()?.getMessages().length ?? 0} messages`,
        };
    }
}
