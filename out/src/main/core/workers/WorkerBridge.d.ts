/**
 * WorkerBridge — Worker 透明桥接层
 *
 * 提供统一的调用接口，自动决定请求通过 Worker 线程执行还是回退到进程内执行。
 * 当 Worker 不可用时（未注册、崩溃或禁用），静默回退到 in-process 实现。
 */
export declare class WorkerBridge<T extends Record<string, (...args: any[]) => any>> {
    readonly name: string;
    private isWorkerActive;
    private sendToWorker;
    private fallback;
    constructor(name: string, isWorkerActive: () => boolean, sendToWorker: (method: string, args: any[]) => Promise<any>, fallback: T);
    execute<K extends keyof T>(method: K, ...args: Parameters<T[K]>): Promise<ReturnType<T[K]>>;
    get workerAvailable(): boolean;
}
