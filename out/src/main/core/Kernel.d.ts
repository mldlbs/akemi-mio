import type { IModule, ISubsystem, HealthCheckResult, SubsystemState } from '../core/lifecycle/types';
/**
 * Kernel — Agent OS 微内核。
 *
 * 职责：
 * 1. 管理所有内核模块的生命周期（注册/注销/热重载）
 * 2. 提供系统调用路由（通过 SyscallBus）
 * 3. 报告内核状态和模块摘要
 *
 * 生命周期：init() → start() → [运行] → stop() → destroy()
 */
export interface KernelModule {
    name: string;
    prefix: string;
    description: string;
    hotReloadable: boolean;
    exports: string[];
}
export declare const KERNEL_PREFIXES: string[];
export declare const KERNEL_NAMES: Set<string>;
export declare class Kernel implements ISubsystem {
    readonly name = "Kernel";
    state: SubsystemState;
    private modules;
    private static instance;
    private _frozen;
    static getInstance(): Kernel;
    /** 冻结模块注册表，防止运行时修改核心模块 */
    freezeModuleRegistry(): void;
    /** 验证内核完整性 */
    verifyIntegrity(): {
        ok: boolean;
        issues: string[];
    };
    /** 注册一个模块，调用其 init() */
    registerModule(module: IModule): Promise<void>;
    /** 注销一个模块，调用 stop() + destroy() */
    unregisterModule(name: string): Promise<void>;
    /** 热重载模块（仅 hotReloadable 模块） */
    hotReload(name: string): Promise<boolean>;
    /** 处理内核级系统调用 */
    handleSyscall(method: string, params: unknown): Promise<unknown>;
    /** 获取模块 */
    getModule(name: string): IModule | undefined;
    /** 获取所有已注册模块列表 */
    getModules(): IModule[];
    init(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    destroy(): Promise<void>;
    healthCheck(): Promise<HealthCheckResult>;
    getFormattedSummary(): string;
}
