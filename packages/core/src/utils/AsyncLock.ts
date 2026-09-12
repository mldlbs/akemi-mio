/**
 * 轻量级进程内异步互斥锁，用于保护 PlanManager 等共享资源的并发访问。
 * 同一时刻只允许一个异步操作持有锁。
 */
export class AsyncLock {
  private locked: boolean = false
  private queue: Array<() => void> = []

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true
      return
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve)
    })
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!
      next()
    } else {
      this.locked = false
    }
  }

  /**
   * 执行临界区操作，自动获取/释放锁。
   * 保证无论成功还是异常都会释放锁。
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  isLocked(): boolean {
    return this.locked
  }
}
