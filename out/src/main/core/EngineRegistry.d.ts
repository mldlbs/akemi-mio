/**
 * 轻量引擎注册表 — 支持 ASR/TTS/LLM 引擎注册和运行时切换
 * 所有状态变更均通过 EventBus 广播，便于 UI 更新和日志记录
 *
 * 广播事件：
 *   engine.registered   — 引擎注册（含首次激活）
 *   engine.activated    — 首个引擎自动激活
 *   engine.switched     — 显式切换活跃引擎
 *   engine.unregistered — 引擎注销（含自动切换）
 */
export interface Engine {
    name: string;
    type: string;
    priority: number;
    available: boolean;
}
export declare class EngineRegistry<T extends Engine> {
    private engines;
    private active;
    private strictOrder;
    private eventBus;
    private cascadeCache;
    constructor(eventBus?: {
        emit: (event: string, payload: any) => void;
    });
    private invalidateCache;
    register(engine: T): void;
    unregister(name: string): boolean;
    setActive(name: string): boolean;
    getActive(): T | undefined;
    setOrder(names: string[]): void;
    /**
     * 按优先级（或 strictOrder）返回可用引擎列表
     * 用于级联降级：第一个引擎失败时自动尝试下一个
     * 结果缓存至下一次注册/注销/切换操作
     */
    getCascade(): T[];
    list(): T[];
    get(name: string): T | undefined;
}
