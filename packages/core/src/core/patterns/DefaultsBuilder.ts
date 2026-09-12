/**
 * DefaultsBuilder — 通用默认值构建工具
 *
 * 核心抽象：将"定义对象 + 默认值 → 完整对象"的创建模式标准化。
 * 从 buildTool() / buildCollector() / buildExecutor() / Layer create*() 的共性中提取。
 *
 * 用法：
 *   interface ToolDef { name: string; isEnabled?: boolean; serverName?: string }
 *   const full = applyDefaults({ name: 'myTool' }, { isEnabled: true, serverName: '@builtin/core' })
 *   // → { name: 'myTool', isEnabled: true, serverName: '@builtin/core' }
 *
 * 设计原则：
 * - 无偏见：不关心对象的具体结构
 * - 纯函数：无副作用
 * - 浅合并：只处理第一层属性
 * - 不覆盖已存在的值
 */

// ════════════════════════════════════════════════════════════════
//  applyDefaults — 将默认值应用到偏定义对象
// ════════════════════════════════════════════════════════════════

/**
 * 将默认值应用到偏定义对象上。
 * 只有当目标字段为 undefined 时，才使用默认值。
 *
 * @param def 偏定义对象（可选字段可能为 undefined）
 * @param defaults 默认值对象
 * @returns 完整对象
 */
export function applyDefaults<T extends object>(def: T, defaults: Partial<T>): T {
  const result = { ...def } as T
  const res = result as Record<string, any>
  const defs = defaults as Record<string, any>
  for (const key of Object.keys(defs)) {
    if (res[key] === undefined) {
      res[key] = defs[key]
    }
  }
  return result
}

// ════════════════════════════════════════════════════════════════
//  createWithDefaults — 工厂辅助函数
// ════════════════════════════════════════════════════════════════

/**
 * 从定义创建完整对象（函数签名版本）。
 * 适用于工厂函数：接收定义+默认值，返回完整对象。
 *
 * @param def 偏定义
 * @param defaults 默认值
 * @returns 完整对象
 */
export function createWithDefaults<TDef extends Record<string, any>, TFull extends TDef>(def: TDef, defaults: Partial<TFull>): TFull {
  return applyDefaults(def as unknown as TFull, defaults)
}

// ════════════════════════════════════════════════════════════════
//  buildWithDefaults — 更严格的双步构建
// ════════════════════════════════════════════════════════════════

/**
 * 从定义创建完整对象，并确保输出类型与输入类型分离。
 *
 * 适用于构建器模式：ToolDef → Tool, CollectorDef → SignalCollector
 * 允许在构建后额外添加派生字段。
 *
 * @param def 定义对象
 * @param defaults 默认值
 * @param overrides 额外覆盖或派生字段
 * @returns 完整对象
 */
export function buildWithDefaults<TDef extends Record<string, any>, TFull extends object>(
  def: TDef,
  defaults: Partial<TFull>,
  overrides?: Partial<TFull>,
): TFull {
  const base = applyDefaults(def as unknown as TFull, defaults)
  if (overrides) {
    return { ...base, ...overrides } as TFull
  }
  return base
}
