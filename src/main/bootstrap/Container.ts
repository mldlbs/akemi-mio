/**
 * 极简服务容器 — factory + lazy init。
 * 不用 DI 框架，只是一个带延迟初始化的 Map。
 */
export class Container {
  private factories = new Map<string, () => unknown>()
  private instances = new Map<string, unknown>()

  register<T>(key: string, factory: () => T): void {
    this.factories.set(key, factory)
    // 清除旧实例，下次 resolve 重新创建
    this.instances.delete(key)
  }

  resolve<T>(key: string): T {
    if (!this.instances.has(key)) {
      const factory = this.factories.get(key)
      if (!factory) throw new Error(`Service not registered: ${key}`)
      this.instances.set(key, factory())
    }
    return this.instances.get(key) as T
  }

  has(key: string): boolean {
    return this.factories.has(key)
  }

  /** 解析并初始化所有已注册服务（强制实例化） */
  resolveAll(): void {
    for (const key of this.factories.keys()) {
      this.resolve(key)
    }
  }

  /** 重置指定服务（下次 resolve 重新创建） */
  reset(key: string): void {
    this.instances.delete(key)
  }
}
