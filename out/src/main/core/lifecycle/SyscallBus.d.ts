import type { IModule, SyscallResponse } from './types';
/**
 * SyscallBus — 内核系统调用总线
 *
 * 在已注册的内核模块之间路由系统调用。
 * 提供超时、日志和事件发射。
 */
export declare class SyscallBus {
    private modules;
    private static readonly DEFAULT_TIMEOUT;
    /** 注册一个模块使其可接收系统调用 */
    register(module: IModule): void;
    /** 注销模块 */
    unregister(name: string): void;
    /** 获取已注册模块列表 */
    getRegisteredModules(): string[];
    /** 检查模块是否已注册 */
    isRegistered(name: string): boolean;
    /**
     * 向目标模块发起系统调用
     * 超时默认 30 秒
     */
    call(targetModule: string, method: string, params: unknown, caller: string, timeoutMs?: number): Promise<SyscallResponse>;
    private executeWithTimeout;
}
