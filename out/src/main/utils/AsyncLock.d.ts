/**
 * 轻量级进程内异步互斥锁，用于保护 PlanManager 等共享资源的并发访问。
 * 同一时刻只允许一个异步操作持有锁。
 */
export declare class AsyncLock {
    private locked;
    private queue;
    acquire(): Promise<void>;
    release(): void;
    /**
     * 执行临界区操作，自动获取/释放锁。
     * 保证无论成功还是异常都会释放锁。
     */
    run<T>(fn: () => Promise<T>): Promise<T>;
    isLocked(): boolean;
}
