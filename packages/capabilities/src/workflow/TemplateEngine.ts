/**
 * 模板表达式求值器
 * 解析和求值 {{steps.<id>.result.<path>}} 模板语法
 *
 * 语法：
 *   {{steps.s4.result.score}}              — 引用某步骤的结构化输出
 *   {{steps.s4.result.platforms[0].name}}  — 数组索引访问
 *   {{steps.s4.result.score | 0}}          — 默认值（当结果为 null/undefined 时使用）
 *   {{input}}                               — 用户输入
 *
 * 非模板文本保持原样返回。
 */

const TEMPLATE_RE = /\{\{([^}]+)\}\}/g

/**
 * 解析模板字符串，替换所有 {{...}} 引用为 context 中的实际值
 *
 * @param template - 含 {{...}} 的模板字符串
 * @param context - 步骤结果上下文，形如 { steps: { s1: { result: { ... } } }, input: "..." }
 * @returns 替换后的字符串
 */
export function resolveTemplate(template: string, context: Record<string, any>): string {
  if (!template) return ''
  return template.replace(TEMPLATE_RE, (match, expr: string) => {
    const resolved = resolveExpression(expr.trim(), context)
    return resolved !== undefined && resolved !== null ? String(resolved) : match
  })
}

/**
 * 解析单个表达式（不含 {{ }} 包围）
 */
export function resolveExpression(expr: string, context: Record<string, any>): any {
  const [pathExpr, defaultVal] = splitDefault(expr)

  // 优先识别特殊变量
  if (pathExpr === 'input') return context['input'] ?? defaultVal

  // steps.<id>.result.<path> 或 steps.<id>.<field>
  if (pathExpr.startsWith('steps.')) {
    const parts = pathExpr.split('.')
    // parts = ['steps', 's4', 'result', 'score'] 或 ['steps', 's4', 'score']
    const stepId = parts[1]
    const stepCtx = context?.steps?.[stepId]
    if (!stepCtx) return defaultVal

    // 从第三个部分开始遍历（跳过 'steps', stepId）
    let val: any
    if (parts[2] === 'result') {
      val = stepCtx.result
      val = navigatePath(val, parts.slice(3))
    } else {
      // 直接取 field: steps.s4.status, steps.s4.error
      val = navigatePath(stepCtx, parts.slice(2))
    }
    return val ?? defaultVal
  }

  // context 顶级变量
  const val = navigatePath(context, pathExpr.split('.'))
  return val ?? defaultVal
}

/**
 * 将 "path | default" 分割为 [path, default]
 */
function splitDefault(expr: string): [string, any] {
  const idx = expr.lastIndexOf(' | ')
  if (idx === -1) return [expr, undefined]
  const rawPath = expr.slice(0, idx).trim()
  const rawDefault = expr.slice(idx + 3).trim()
  // 尝试解析默认值为 JSON 基本类型
  if (rawDefault === 'true') return [rawPath, true]
  if (rawDefault === 'false') return [rawPath, false]
  if (rawDefault === 'null') return [rawPath, null]
  if (/^-?\d+(\.\d+)?$/.test(rawDefault)) return [rawPath, Number(rawDefault)]
  if (rawDefault.startsWith("'") && rawDefault.endsWith("'")) return [rawPath, rawDefault.slice(1, -1)]
  if (rawDefault.startsWith('"') && rawDefault.endsWith('"')) return [rawPath, rawDefault.slice(1, -1)]
  return [rawPath, rawDefault]
}

/**
 * 按路径导航对象，支持数组索引
 * navigatePath({ a: [{ b: 1 }] }, ['a', '0', 'b']) => 1
 */
function navigatePath(obj: any, path: string[]): any {
  let current = obj
  for (const segment of path) {
    if (current === null || current === undefined) return undefined
    // 数组索引: items[0] -> 'items' 和 '0'
    const arrMatch = segment.match(/^(\w+)\[(\d+)\]$/)
    if (arrMatch) {
      current = current[arrMatch[1]]
      if (current === null || current === undefined) return undefined
      current = current[Number(arrMatch[2])]
    } else if (typeof current === 'object' && segment in current) {
      current = current[segment]
    } else {
      return undefined
    }
  }
  return current
}

/**
 * 检查模板字符串是否包含动态引用
 */
export function hasTemplateRefs(template: string): boolean {
  TEMPLATE_RE.lastIndex = 0
  return TEMPLATE_RE.test(template)
}
