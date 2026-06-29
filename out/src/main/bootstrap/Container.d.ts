/**
 * 极简服务容器 — factory + lazy init。
 * 不用 DI 框架，只是一个带延迟初始化的 Map。
 */
export declare class Container {
    private factories;
    private instances;
    register<T>(key: string, factory: () => T): void;
    resolve<T>(key: string): T;
    has(key: string): boolean;
    /** 解析并初始化所有已注册服务（强制实例化） */
    resolveAll(): void;
    /** 重置指定服务（下次 resolve 重新创建） */
    reset(key: string): void;
}
