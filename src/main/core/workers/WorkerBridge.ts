import { log } from '../../logger/Logger'

/**
 * WorkerBridge — Worker 透明桥接层
 *
 * 提供统一的调用接口，自动决定请求通过 Worker 线程执行还是回退到进程内执行。
 * 当 Worker 不可用时（未注册、崩溃或禁用），静默回退到 in-process 实现。
 */
export class WorkerBridge<T extends Record<string, Function>> {
  constructor(
    public readonly name: string,
    private isWorkerActive: () => boolean,
    private sendToWorker: (method: string, args: any[]) => Promise<any>,
    private fallback: T,
  ) {}

  async execute<K extends keyof T>(method: K, ...args: Parameters<T[K]>): Promise<ReturnType<T[K]>> {
    if (this.isWorkerActive()) {
      try {
        const result = await this.sendToWorker(method as string, args)
        return result as ReturnType<T[K]>
      } catch (err) {
        log('WARN', 'workerbridge.worker_failed_fallback', {
          name: this.name,
          method: method as string,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const fn = this.fallback[method]
    if (typeof fn !== 'function') {
      throw new Error(`WorkerBridge: method "${String(method)}" not found on ${this.name}`)
    }
    return fn(...args) as ReturnType<T[K]>
  }

  get workerAvailable(): boolean {
    return this.isWorkerActive()
  }
}
