/**
 * FeatureFlagSet — 通用功能开关管理
 *
 * 核心抽象：将 Feature Flag 的集合操作标准化。
 * 从 WorkspaceCleanupLayer / IndustrialOdeLayer 的 feature flag 共性中提取。
 *
 * 用法：
 *   type MyFeature = 'alpha' | 'beta' | 'gamma'
 *   const flags = new FeatureFlagSet<MyFeature>(['alpha'])
 *   flags.has('alpha')     // true
 *   flags.has('beta')      // false
 *   flags.enable('beta')
 *   flags.has('beta')      // true
 *   flags.disable('beta')
 *   flags.getActive()      // ['alpha']
 *
 * 设计原则：
 * - 无偏见：不关心 feature 的具体含义
 * - 类型安全：通过泛型 T 约束合法 feature 名称
 * - 支持运行时开关（enable/disable）
 * - 支持从环境变量解析（parseFromEnv util）
 * - 支持快照（snapshot/restore）用于状态保存
 */

// ════════════════════════════════════════════════════════════════
//  核心类
// ════════════════════════════════════════════════════════════════

export class FeatureFlagSet<T extends string = string> {
  /** 内部集合（Readonly 确保外部只读） */
  private flags: Set<T>

  /**
   * @param initial 初始启用的 feature 列表
   */
  constructor(initial?: T[]) {
    this.flags = new Set(initial ?? [])
  }

  /** 检查指定 feature 是否启用 */
  has(feature: T): boolean {
    return this.flags.has(feature)
  }

  /** 启用一个 feature */
  enable(feature: T): void {
    this.flags.add(feature)
  }

  /** 禁用一个 feature */
  disable(feature: T): void {
    this.flags.delete(feature)
  }

  /** 切换 feature 状态 */
  toggle(feature: T): boolean {
    if (this.flags.has(feature)) {
      this.flags.delete(feature)
      return false
    }
    this.flags.add(feature)
    return true
  }

  /** 获取所有已启用的 feature 列表 */
  getActive(): T[] {
    return Array.from(this.flags)
  }

  /** 获取启用 feature 数量 */
  get size(): number {
    return this.flags.size
  }

  /** 检查是否有任何 feature 启用 */
  get isActive(): boolean {
    return this.flags.size > 0
  }

  /** 批量启用 */
  enableAll(features: T[]): void {
    for (const f of features) {
      this.flags.add(f)
    }
  }

  /** 批量禁用 */
  disableAll(features: T[]): void {
    for (const f of features) {
      this.flags.delete(f)
    }
  }

  /** 清空所有 feature */
  clear(): void {
    this.flags.clear()
  }

  /** 创建当前状态的快照（可用于恢复） */
  snapshot(): T[] {
    return this.getActive()
  }

  /** 从快照恢复 */
  restore(snapshot: T[]): void {
    this.flags = new Set(snapshot)
  }

  /** 转为只读 Set（供外部消费） */
  toReadonlySet(): ReadonlySet<T> {
    return this.flags
  }
}

// ════════════════════════════════════════════════════════════════
//  环境变量解析工具
// ════════════════════════════════════════════════════════════════

export interface ParseFeaturesFromEnvOptions<T extends string> {
  /** 环境变量名 */
  envVar: string
  /** 允许的 feature 值集合（用于校验） */
  allowed: ReadonlySet<T> | T[]
  /** 分隔符，默认 ',' */
  separator?: string
  /** 是否移除空字符串，默认 true */
  trimEmpty?: boolean
  /** 是否过滤非法值，默认 true */
  validate?: boolean
}

/**
 * 从环境变量解析 feature 列表。
 *
 * 用法：
 *   const features = parseFeaturesFromEnv<MyFeature>({
 *     envVar: 'MY_FEATURES',
 *     allowed: ['alpha', 'beta', 'gamma'],
 *   })
 *   // 当 MY_FEATURES=alpha,gamma 时返回 ['alpha', 'gamma']
 */
export function parseFeaturesFromEnv<T extends string>(
  options: ParseFeaturesFromEnvOptions<T>,
): T[] {
  const raw = process.env[options.envVar] || ''
  if (!raw.trim()) return []

  const allowedSet = new Set(options.allowed)
  const separator = options.separator ?? ','
  const trimEmpty = options.trimEmpty ?? true
  const validate = options.validate ?? true

  return raw
    .split(separator)
    .map((s) => s.trim())
    .filter((s) => !trimEmpty || s.length > 0)
    .filter((s) => !validate || allowedSet.has(s as T)) as T[]
}
