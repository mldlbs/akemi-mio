/**
 * configMerge — 类型安全的深度部分合并工具
 *
 * 核心抽象：将 Partial 配置覆盖合并到默认配置，支持嵌套对象。
 * 替代各模块中「...DEFAULT, ...partial」的浅合并模式。
 *
 * 用法：
 *   interface Config { a: number; b: { c: string; d: number } }
 *   const def: Config = { a: 1, b: { c: 'x', d: 2 } }
 *   deepMerge(def, { b: { c: 'y' } })
 *   // → { a: 1, b: { c: 'y', d: 2 } }
 *
 * 设计原则：
 * - 类型安全：输入和输出类型一致
 * - 深度合并：嵌套对象递归合并，不是覆盖
 * - 不可变：不修改原对象
 * - 跳过 undefined：覆盖中的 undefined 字段不会覆盖默认值
 *
 * 来源分析（PiperTTS + Plan:TypeScript）：
 * - 几乎所有配置类都使用 {...DEFAULT, ...partial} 浅合并
 * - 部分配置有嵌套结构（如 HybridPipelineConfig 等），浅合并会导致嵌套字段丢失
 */

// ══════════════════════════════════════════
//  工具类型
// ══════════════════════════════════════════

/** 递归 Partial 类型，支持嵌套对象的部分覆盖 */
export type PartialDeep<T> = T extends object ? { [P in keyof T]?: PartialDeep<T[P]> } : T

// ══════════════════════════════════════════
//  核心合并函数
// ══════════════════════════════════════════

/**
 * 深度合并默认配置与部分覆盖。
 *
 * 合并规则：
 * 1. 如果 overrides 为 null/undefined，返回 defaults 的浅拷贝
 * 2. 如果某一字段在 overrides 中为 undefined，使用 defaults 中的值
 * 3. 如果某一字段在两者中都是对象且非数组，递归深度合并
 * 4. 数组直接替换（不合并）
 * 5. 基本类型直接替换
 *
 * @param defaults 默认配置
 * @param overrides 部分覆盖（可选）
 * @returns 合并后的完整配置
 */
export function deepMerge<T extends object>(defaults: T, overrides?: PartialDeep<T> | null): T {
  if (overrides === null || overrides === undefined) {
    return { ...defaults }
  }

  const result = { ...defaults } as T

  for (const key of Object.keys(overrides) as Array<keyof T>) {
    const overrideVal = (overrides as Partial<T>)[key]
    const defaultVal = defaults[key]

    if (overrideVal === undefined) {
      // undefined → 使用默认值
      continue
    }

    if (isPlainObject(defaultVal) && isPlainObject(overrideVal)) {
      // 两者都是对象 → 递归深度合并
      result[key] = deepMerge(defaultVal as Record<string, unknown>, overrideVal as Record<string, unknown>) as T[typeof key]
    } else {
      // 基本类型或数组 → 直接替换
      result[key] = overrideVal as T[typeof key]
    }
  }

  return result
}

/**
 * 浅合并（与 {...a, ...b} 等价，但跳过 undefined）。
 * 适用于不需要深度合并的简单配置。
 *
 * @param defaults 默认值
 * @param overrides 覆盖值（可选）
 * @returns 合并后的配置
 */
export function shallowMerge<T extends object>(defaults: T, overrides?: Partial<T> | null): T {
  if (overrides === null || overrides === undefined) {
    return { ...defaults }
  }

  const result = { ...defaults } as T
  for (const key of Object.keys(overrides) as Array<keyof T>) {
    if (overrides[key] !== undefined) {
      result[key] = overrides[key] as T[typeof key]
    }
  }
  return result
}

// ══════════════════════════════════════════
//  辅助
// ══════════════════════════════════════════

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === 'object' && !Array.isArray(val)
}
