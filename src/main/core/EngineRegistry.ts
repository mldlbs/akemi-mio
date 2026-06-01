/**
 * 轻量引擎注册表 — 支持 ASR/TTS/LLM 引擎注册和运行时切换
 */
export interface Engine {
  name: string
  type: string
  priority: number
  available: boolean
}

export class EngineRegistry<T extends Engine> {
  private engines: Map<string, T> = new Map()
  private active: string | null = null
  private strictOrder: string[] = []

  register(engine: T): void {
    this.engines.set(engine.name, engine)
    if (!this.active) this.active = engine.name
  }

  unregister(name: string): boolean {
    this.engines.delete(name)
    if (this.active === name) {
      this.active = this.engines.keys().next().value || null
    }
    return true
  }

  setActive(name: string): boolean {
    if (!this.engines.has(name)) return false
    this.active = name
    return true
  }

  getActive(): T | undefined {
    return this.active ? this.engines.get(this.active) : undefined
  }

  setOrder(names: string[]): void {
    this.strictOrder = [...names]
  }

  /**
   * 按优先级（或 strictOrder）返回可用引擎列表
   * 用于级联降级：第一个引擎失败时自动尝试下一个
   */
  getCascade(): T[] {
    if (this.strictOrder.length > 0) {
      return this.strictOrder
        .map(n => this.engines.get(n)!)
        .filter(e => e && e.available)
    }
    return Array.from(this.engines.values())
      .filter(e => e.available)
      .sort((a, b) => b.priority - a.priority)
  }

  list(): T[] {
    return Array.from(this.engines.values())
  }

  get(name: string): T | undefined {
    return this.engines.get(name)
  }
}
