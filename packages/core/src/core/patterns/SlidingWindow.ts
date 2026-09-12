/**
 * SlidingWindow — 通用滑动窗口
 *
 * 核心抽象：维护一个固定大小的最近 N 项窗口，自动淘汰旧项。
 * 替代手动管理的数组 + push + shift + 边界检查模式。
 *
 * 用法：
 *   const window = new SlidingWindow<string>(32)
 *   window.add('hello')
 *   window.add('world')
 *   window.getAll()        // ['hello', 'world']
 *   window.toArray()       // 同上
 *   window.size            // 2
 *
 * 设计原则：
 * - 无偏见：不关心窗口内元素类型，只负责维护大小约束
 * - 零开销抽象：O(1) push，O(1) shift
 * - 可组合：可配合 Array.map/filter/reduce 使用
 *
 * 来源分析（从以下模块提取的共性）：
 * - LearningVocabularyManager.recentInteractions — 滑动窗口频次分析
 * - TtsPiperBridge.recentLatencies — 滑动窗口延迟统计
 * - 其他模块也使用类似模式
 */

// ── 核心类 ──

export class SlidingWindow<T> {
  private readonly items: T[] = []
  private readonly maxSize: number

  /**
   * @param maxSize 窗口最大容量（默认 100）
   */
  constructor(maxSize = 100) {
    if (maxSize < 1) {
      throw new Error(`SlidingWindow maxSize 必须 >= 1，实际为 ${maxSize}`)
    }
    this.maxSize = maxSize
  }

  // ── 写入 ──

  /**
   * 向窗口添加一个元素。
   * 如果窗口已满，自动移除最早的元素。
   */
  add(item: T): void {
    this.items.push(item)
    if (this.items.length > this.maxSize) {
      this.items.shift()
    }
  }

  /**
   * 批量添加元素。
   * 与多次调用 add() 等价，但更高效。
   */
  addAll(items: T[]): void {
    for (const item of items) {
      this.add(item)
    }
  }

  // ── 读取 ──

  /** 获取窗口内所有元素（按添加顺序，最新在末尾） */
  getAll(): readonly T[] {
    return this.items
  }

  /** 获取窗口内所有元素的副本 */
  toArray(): T[] {
    return [...this.items]
  }

  /** 当前窗口大小 */
  get size(): number {
    return this.items.length
  }

  /** 窗口最大容量 */
  get capacity(): number {
    return this.maxSize
  }

  /** 窗口是否为空 */
  get isEmpty(): boolean {
    return this.items.length === 0
  }

  /** 窗口是否已满 */
  get isFull(): boolean {
    return this.items.length >= this.maxSize
  }

  // ── 聚合（懒计算，不缓存） ──

  /**
   * 计算窗口中元素的频次映射。
   * 适用于需要统计窗口中各元素出现次数的场景。
   *
   * @param keyFn 从元素中提取键的函数（默认使用元素本身作为键）
   * @returns 频次映射
   */
  getFrequency<K>(keyFn: (item: T) => K = (item) => item as unknown as K): Map<K, number> {
    const freq = new Map<K, number>()
    for (const item of this.items) {
      const key = keyFn(item)
      freq.set(key, (freq.get(key) || 0) + 1)
    }
    return freq
  }

  /**
   * 计算窗口中元素的数值聚合平均值。
   * 适用于需要计算平均延迟、平均分数的场景。
   *
   * @param valueFn 从元素中提取数值的函数
   * @returns 平均值，窗口为空时返回 0
   */
  getAverage(valueFn: (item: T) => number): number {
    if (this.items.length === 0) return 0
    const sum = this.items.reduce((s, item) => s + valueFn(item), 0)
    return sum / this.items.length
  }

  // ── 管理 ──

  /** 清空窗口 */
  clear(): void {
    this.items.length = 0
  }

  /**
   * 裁剪到最新 N 项（丢弃旧项）。
   * 如果当前大小 <= N，不做任何操作。
   */
  trimTo(count: number): void {
    while (this.items.length > count) {
      this.items.shift()
    }
  }
}
