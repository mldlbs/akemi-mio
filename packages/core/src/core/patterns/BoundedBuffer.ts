/**
 * BoundedBuffer — 通用有界缓冲区
 *
 * 核心抽象：维护一个固定最大长度的缓冲区，超出时自动从头部移除最旧元素。
 * 替代手动管理的 `array.push() + splice(0, len - MAX)` 模式。
 *
 * 与 SlidingWindow 的区别：
 * - SlidingWindow 每次 add 都 push+shift（每次 O(n)）
 * - BoundedBuffer 仅在超过容量时批量 trim（分摊 O(1)），更适合突发性批量写入
 *
 * 用法：
 *   const buf = new BoundedBuffer<string>(100)
 *   buf.add('a')
 *   buf.addAll(['b', 'c'])
 *   buf.toArray()          // ['a', 'b', 'c']
 *   buf.size               // 3
 *   buf.isFull             // false
 *
 * 设计原则：
 * - 无偏见：不关心元素类型
 * - 批量 trim 仅在超过容量时触发，非每次写入
 * - 支持紧凑模式：在超过 capacity * 1.5 时才 trim 到 capacity
 *
 * 来源分析（从以下模块提取的共性）：
 * - MCPFeedbackLoopService.executionQueue — 500 条上限 + splice trim
 * - MCPPlanRadarFeedbackLoop.executionQueue — 500 条上限 + splice trim
 * - MCPPlanRadarFeedbackLoop.radarScanResults — 50 条上限 + splice trim
 * - MCPPlanRadarFeedbackLoop.adjustmentHistory — 50 条上限 + splice trim
 * - PlanStartupRadarPlugin.scanObservations — observationWindowSize + splice trim
 */

// ── 核心类 ──

export class BoundedBuffer<T> {
  private readonly items: T[] = []
  private readonly maxSize: number
  private readonly trimThreshold: number

  /**
   * @param maxSize 缓冲区最大容量（默认 100）
   * @param trimThreshold 触发 trim 的阈值倍数（默认 1.0）
   *   1.0 = 超出 maxSize 立即 trim，1.5 = 超出 maxSize*1.5 才 trim
   */
  constructor(maxSize = 100, trimThreshold = 1.0) {
    if (maxSize < 1) {
      throw new Error(`BoundedBuffer maxSize 必须 >= 1，实际为 ${maxSize}`)
    }
    if (trimThreshold < 1.0) {
      throw new Error(`BoundedBuffer trimThreshold 必须 >= 1.0，实际为 ${trimThreshold}`)
    }
    this.maxSize = maxSize
    this.trimThreshold = trimThreshold
  }

  // ── 写入 ──

  /**
   * 向缓冲区添加一个元素。
   * 仅在超过 trimThreshold 阈值时触发批量 trim。
   */
  add(item: T): void {
    this.items.push(item)
    this.maybeTrim()
  }

  /**
   * 批量添加元素。
   * 仅在最终长度超过 trimThreshold 阈值时触发批量 trim。
   */
  addAll(items: T[]): void {
    if (items.length === 0) return
    for (const item of items) {
      this.items.push(item)
    }
    this.maybeTrim()
  }

  // ── 读取 ──

  /** 获取缓冲区所有元素（按添加顺序，最新在末尾） */
  getAll(): readonly T[] {
    return this.items as readonly T[]
  }

  /** 获取缓冲区所有元素的副本 */
  toArray(): T[] {
    return [...this.items]
  }

  /** 获取最新添加的元素（末尾），缓冲区为空时返回 undefined */
  last(): T | undefined {
    return this.items[this.items.length - 1]
  }

  /** 获取最早添加的元素（头部），缓冲区为空时返回 undefined */
  first(): T | undefined {
    return this.items[0]
  }

  /** 当前缓冲区大小 */
  get size(): number {
    return this.items.length
  }

  /** 缓冲区最大容量 */
  get capacity(): number {
    return this.maxSize
  }

  /** 缓冲区是否为空 */
  get isEmpty(): boolean {
    return this.items.length === 0
  }

  /** 缓冲区是否已满（达到或超过 maxSize） */
  get isFull(): boolean {
    return this.items.length >= this.maxSize
  }

  // ── 聚合 ──

  /**
   * 遍历缓冲区元素。
   * 等效于 this.toArray().forEach()，但避免创建副本。
   */
  forEach(callback: (item: T, index: number) => void): void {
    for (let i = 0; i < this.items.length; i++) {
      callback(this.items[i], i)
    }
  }

  /**
   * 过滤缓冲区元素。
   * 返回新数组，不影响缓冲区内部。
   */
  filter(predicate: (item: T) => boolean): T[] {
    return this.items.filter(predicate)
  }

  /**
   * 映射缓冲区元素。
   * 返回新数组，不影响缓冲区内部。
   */
  map<U>(transform: (item: T) => U): U[] {
    return this.items.map(transform)
  }

  /**
   * 对缓冲区元素做归约。
   */
  reduce<U>(reducer: (acc: U, item: T) => U, initial: U): U {
    return this.items.reduce(reducer, initial)
  }

  // ── 管理 ──

  /** 清空缓冲区 */
  clear(): void {
    this.items.length = 0
  }

  /**
   * 裁剪到最新 N 项（丢弃头部旧项）。
   * 如果当前大小 <= N，不做任何操作。
   */
  trimTo(count: number): void {
    if (count < 0) count = 0
    while (this.items.length > count) {
      this.items.shift()
    }
  }

  /** 裁剪到 maxSize */
  trimToCapacity(): void {
    this.trimTo(this.maxSize)
  }

  // ── 内部 ──

  /**
   * 检查是否需要触发批量 trim。
   * 仅在当前长度超过 maxSize * trimThreshold 时执行。
   */
  private maybeTrim(): void {
    const threshold = Math.floor(this.maxSize * this.trimThreshold)
    if (this.items.length > threshold) {
      this.trimTo(this.maxSize)
    }
  }
}

// ── 工厂函数 ──

/**
 * 创建一个 BoundedBuffer 实例。
 * 函数式风格的工厂，适用于快速内联创建。
 */
export function createBoundedBuffer<T>(maxSize?: number, trimThreshold?: number): BoundedBuffer<T> {
  return new BoundedBuffer<T>(maxSize, trimThreshold)
}
