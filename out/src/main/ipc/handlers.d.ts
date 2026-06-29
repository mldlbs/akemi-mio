import { AgentService } from '../agent/AgentService';
import { StateManager } from '../core/StateManager';
import { TtsService } from '../tts/TtsService';
import { SelfEvolutionService } from '../evolution';
import { MetricsCollector } from '../observability/MetricsCollector';
/**
 * 可变的服务引用容器 — 允许延迟初始化的服务绑定 IPC handler
 */
export interface ServiceRef<T> {
    current: T | null;
}
export declare function createServiceRef<T>(): ServiceRef<T>;
export declare function registerHandlers(agentService: AgentService, stateManager: StateManager, ttsService: TtsService, evolutionRef?: ServiceRef<SelfEvolutionService>, metricsCollector?: MetricsCollector): void;
