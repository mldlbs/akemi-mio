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
  name: string
  type: string
  priority: number
  available: boolean
}

export class EngineRegistry<T extends Engine> {
  private engines: Map<string, T> = new Map()
  private active: string | null = null
  private strictOrder: string[] = []
  private eventBus: { emit: (event: string, payload: any) => void }
  private cascadeCache: T[] | null = null

  constructor(eventBus?: { emit: (event: string, payload: any) => void }) {
    this.eventBus = eventBus || { emit: () => {} }
  }

  private invalidateCache(): void {
    this.cascadeCache = null
  }

  register(engine: T): void {
    this.engines.set(engine.name, engine)
    if (!this.active) {
      this.active = engine.name
      this.eventBus.emit('engine.activated', { name: engine.name, previous: null })
    }
    this.eventBus.emit('engine.registered', { name: engine.name, type: engine.type })
    this.invalidateCache()
  }

  unregister(name: string): boolean {
    const existed = this.engines.has(name)
    this.engines.delete(name)
    if (this.active === name) {
      const previous = this.active
      this.active = this.engines.keys().next().value || null
      this.eventBus.emit('engine.activated', { name: this.active, previous })
    }
    if (existed) {
      this.eventBus.emit('engine.unregistered', { name })
    }
    this.invalidateCache()
    return true
  }

  setActive(name: string): boolean {
    if (!this.engines.has(name)) return false
    const previous = this.active
    this.active = name
    this.eventBus.emit('engine.switched', { name, previous })
    this.invalidateCache()
    return true
  }

  getActive(): T | undefined {
    return this.active ? this.engines.get(this.active) : undefined
  }

  setOrder(names: string[]): void {
    this.strictOrder = [...names]
    this.invalidateCache()
  }

  /**
   * 按优先级（或 strictOrder）返回可用引擎列表
   * 用于级联降级：第一个引擎失败时自动尝试下一个
   * 结果缓存至下一次注册/注销/切换操作
   */
  getCascade(): T[] {
    if (this.cascadeCache) return this.cascadeCache

    let result: T[]
    if (this.strictOrder.length > 0) {
      result = this.strictOrder
        .map(n => this.engines.get(n)!)
        .filter(e => e && e.available)
    } else {
      result = Array.from(this.engines.values())
        .filter(e => e.available)
        .sort((a, b) => b.priority - a.priority)
    }
    this.cascadeCache = result
    return result
  }

  list(): T[] {
    return Array.from(this.engines.values())
  }

  get(name: string): T | undefined {
    return this.engines.get(name)
  }
}
