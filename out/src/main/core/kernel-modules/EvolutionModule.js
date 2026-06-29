import { log } from '../../logger/Logger';
/**
 * EvolutionModule — SelfEvolutionService 的内核模块封装。
 *
 * 标准化生命周期，暴露有限监控和触发接口。
 */
export class EvolutionModule {
    constructor(evolutionService) {
        this.name = 'evolution';
        this.prefix = 'src/main/evolution/';
        this.hotReloadable = false;
        this.exports = ['SelfEvolutionService'];
        this.state = 'created';
        this.evolutionService = evolutionService;
    }
    getExport(name) {
        if (name === 'SelfEvolutionService')
            return this.evolutionService;
        return undefined;
    }
    async handleSyscall(method, params) {
        switch (method) {
            case 'get_state':
                return { state: this.evolutionService['state'] ?? 'unknown' };
            case 'trigger_cycle':
                return this.evolutionService.runAnalysisCycle();
            case 'get_snapshot':
                return {
                    state: this.evolutionService['state'],
                    currentMode: this.evolutionService['currentMode'],
                    safetyMode: this.evolutionService['safetyMode'],
                };
            default:
                throw new Error(`Unknown evolution syscall: ${method}`);
        }
    }
    async init() {
        if (this.state !== 'created')
            return;
        this.state = 'initializing';
        log('INFO', 'evolution_module.init');
        this.state = 'ready';
    }
    async start() {
        if (this.state !== 'ready')
            return;
        this.state = 'running';
        log('INFO', 'evolution_module.started');
    }
    async stop() {
        this.state = 'stopping';
        log('INFO', 'evolution_module.stopped');
        this.state = 'stopped';
    }
    async destroy() {
        log('INFO', 'evolution_module.destroyed');
    }
    async healthCheck() {
        return {
            healthy: true,
            detail: `Evolution module: state=${this.evolutionService['state'] ?? 'unknown'}`,
        };
    }
}
