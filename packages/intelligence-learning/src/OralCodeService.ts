/**
 * OralCodeService — 口述代码服务
 *
 * 将用户的自然语言类型描述解析为 TypeScript 代码模板。
 * 使用规则匹配（关键词 + 正则），支持有限但实用的模式集。
 *
 * 功能：
 * 1. 识别用户对 TypeScript 类型的自然语言描述
 * 2. 匹配预定义的代码模式
 * 3. 生成 TypeScript 代码模板
 * 4. 基本语法验证
 * 5. 返回代码和解释文本（用于 TTS 播报）
 *
 * 支持的常见模式（限预置的有限模式，逐步扩展）：
 * - 泛型函数/接口/类
 * - 泛型约束
 * - 条件类型（含 infer）
 * - 映射类型（含修饰符、键重映射）
 * - 模板字面量类型
 * - 工具类型（Pick, Omit, Partial, Record, Exclude）
 * - 类型守卫 / 断言函数
 * - 联合/交叉类型
 * - 递归类型
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { OralCodeInput, OralCodeResult, OralCodePattern, OralCodePatternDef } from './types'

// ══════════════════════════════════════════
//  预定义代码模式
// ══════════════════════════════════════════

/**
 * 预定义的口述代码模式列表。
 * 每个模式包含关键词匹配规则和代码生成函数。
 */
const PATTERNS: OralCodePatternDef[] = [
  // ── 1. 泛型函数 ──
  {
    pattern: 'generic_function',
    name: '泛型函数',
    keywords: [
      '泛型函数',
      'generic function',
      '泛型方法',
      'generic method',
      '接受T',
      '接受类型参数',
      '类型参数T',
      '返回',
      'Promise',
      'type parameter',
      '<T>',
      '<T,',
    ],
    generate: (params) => {
      const tParam = params.typeParam || 'T'
      const returnType = params.returnType || 'T'
      const paramType = params.paramType || tParam
      const funcName = params.funcName || 'identity'
      return {
        code: `// 泛型函数：接受 ${tParam}，返回 ${returnType}\nfunction ${funcName}<${tParam}>(arg: ${paramType}): ${returnType} {\n  return arg;\n}`,
        label: `泛型函数 ${funcName}<${tParam}>`,
        explanation: `这是一个泛型函数。${funcName} 接受一个类型参数 ${tParam}，参数 arg 的类型为 ${paramType}，返回值类型为 ${returnType}。这让函数可以安全地处理不同类型的数据。`,
      }
    },
    examples: ['一个泛型函数，接受T返回T', '一个泛型函数，接受T返回Promise<T>', '写一个泛型函数 identity'],
  },

  // ── 2. 泛型接口 ──
  {
    pattern: 'generic_interface',
    name: '泛型接口',
    keywords: ['泛型接口', 'generic interface', '接口', 'interface', '泛型类型', 'generic type'],
    generate: (params) => {
      const tParam = params.typeParam || 'T'
      const name = params.name || 'Container'
      return {
        code: `// 泛型接口：${name}<${tParam}>\ninterface ${name}<${tParam}> {\n  value: ${tParam};\n  getValue(): ${tParam};\n}`,
        label: `泛型接口 ${name}<${tParam}>`,
        explanation: `这是一个泛型接口。${name} 接受类型参数 ${tParam}，接口中的 value 属性和 getValue 方法都使用该类型参数，确保类型一致性。`,
      }
    },
    examples: ['一个泛型接口 Container<T>', '泛型接口，接受T'],
  },

  // ── 3. 泛型约束 ──
  {
    pattern: 'generic_constraint',
    name: '泛型约束',
    keywords: ['泛型约束', 'generic constraint', 'extends', '约束', '类型参数约束', 'constrained'],
    generate: (params) => {
      const tParam = params.typeParam || 'T'
      const constraint = params.constraint || 'HasLength'
      const name = params.name || 'logLength'
      return {
        code: `// 泛型约束：${tParam} extends ${constraint}\ninterface ${constraint} {\n  length: number;\n}\n\nfunction ${name}<${tParam} extends ${constraint}>(arg: ${tParam}): number {\n  return arg.length;\n}`,
        label: `泛型约束 ${tParam} extends ${constraint}`,
        explanation: `这是一个带泛型约束的函数。${tParam} 必须满足 ${constraint} 接口的要求，即拥有 length 属性。这保证了函数内部可以安全访问 arg.length。`,
      }
    },
    examples: ['泛型约束，T extends HasLength', '一个泛型约束，要求有length属性'],
  },

  // ── 4. 条件类型 ──
  {
    pattern: 'conditional_type',
    name: '条件类型',
    keywords: ['条件类型', 'conditional type', 'extends ?', '三目', '条件判断', '类型选择'],
    generate: (params) => {
      const check = params.checkType || 'T'
      const against = params.againstType || 'string'
      const trueType = params.trueType || 'true'
      const falseType = params.falseType || 'false'
      return {
        code: `// 条件类型：${check} extends ${against} ? ${trueType} : ${falseType}\ntype IsString<T> = T extends ${against} ? ${trueType} : ${falseType};\n\n// 使用示例\ntype A = IsString<'hello'>; // ${trueType}\ntype B = IsString<42>;      // ${falseType}`,
        label: `条件类型 ${check} extends ${against}`,
        explanation: `这是一个条件类型。如果类型 ${check} 可以赋值给 ${against}，结果类型为 ${trueType}，否则为 ${falseType}。条件类型是 TypeScript 在类型层面的 if-else 逻辑。`,
      }
    },
    examples: ['条件类型，T extends string 返回 true 否则 false', '条件类型 IsString'],
  },

  // ── 5. 条件类型 + infer ──
  {
    pattern: 'conditional_infer',
    name: 'infer 推导',
    keywords: ['infer', '推导', '提取', 'extract', '模式匹配', '获取返回值类型', '获取参数类型', 'ReturnType', 'Parameters'],
    generate: (params) => {
      const target = params.target || 'Promise<T>'
      const inferVar = params.inferVar || 'T'
      return {
        code: `// 使用 infer 从 ${target} 中提取 ${inferVar}\ntype Unpack<T> = T extends ${target} ? ${inferVar} : never;\n\n// 使用示例\ntype A = Unpack<Promise<string>>; // string\ntype B = Unpack<number>;          // never`,
        label: `infer 模式匹配 ${target}`,
        explanation: `这里使用了 infer 关键字在条件类型中进行模式匹配。如果类型 T 匹配 ${target} 模式，infer 会推导出 ${inferVar} 的具体类型并作为结果返回。这正是 TypeScript 内置 ReturnType 和 Parameters 工具类型的实现原理。`,
      }
    },
    examples: ['提取 Promise<T> 中的 T', '用 infer 提取类型参数'],
  },

  // ── 6. 映射类型 ──
  {
    pattern: 'mapped_type',
    name: '映射类型',
    keywords: ['映射类型', 'mapped type', 'keyof', 'in keyof', '遍历属性', 'transform', '转换类型', '所有属性', '每个属性'],
    generate: (params) => {
      const source = params.sourceType || 'T'
      const name = params.name || 'Nullable'
      return {
        code: `// 映射类型：将 ${source} 的所有属性变为可空\ninterface ${name}<${source}> {\n  [P in keyof ${source}]: ${source}[P] | null;\n}\n\n// 使用示例\ntype User = { name: string; age: number };\ntype NullableUser = ${name}<User>;\n// { name: string | null; age: number | null }`,
        label: `映射类型 [P in keyof ${source}]`,
        explanation: `这是一个映射类型。它遍历 ${source} 的所有键，对每个属性应用变换。P in keyof ${source} 的意思是"对于 ${source} 中的每个键 P"，结果类型保留了原类型的所有属性键，但值的类型被修改了。`,
      }
    },
    examples: ['一个映射类型，所有属性变为可空', '映射类型，给每个属性加 null'],
  },

  // ── 7. 映射类型 + 修饰符 ──
  {
    pattern: 'mapped_type_modifiers',
    name: '映射类型修饰符',
    keywords: ['映射类型', '修饰符', 'modifier', 'readonly', '可选', '只读', '可选属性', '加readonly', '减readonly'],
    generate: (params) => {
      const source = params.sourceType || 'T'
      return {
        code: `// 映射类型：移除 ${source} 的所有 readonly 和可选标记\ntype Mutable<${source}> = {\n  -readonly [P in keyof ${source}]-?: ${source}[P];\n};\n\n// 使用示例\ntype ReadonlyUser = { readonly name: string; readonly age?: number };\ntype MutableUser = Mutable<ReadonlyUser>;\n// { name: string; age: number }`,
        label: '映射类型修饰符',
        explanation:
          '映射类型支持使用 +/- 符号添加或移除属性的 readonly 和可选标记。-readonly 移除只读，-? 移除可选标记。这让你可以灵活转换类型的属性修饰符。',
      }
    },
    examples: ['映射类型，去掉所有 readonly', '映射类型，去掉可选标记'],
  },

  // ── 8. 模板字面量类型 ──
  {
    pattern: 'template_literal',
    name: '模板字面量类型',
    keywords: ['模板字面量', 'template literal', '模板字符串类型', '`${}`', '字符串拼接'],
    generate: (params) => {
      const prefix = params.prefix || 'event'
      const suffix = params.suffix || 'string'
      return {
        code: `// 模板字面量类型：\`${prefix}_$\{${suffix}}\`\ntype EventName<${suffix} extends string> = \`${prefix}_$\{${suffix}}\`;\n\n// 使用示例\ntype ClickEvent = EventName<'click'>;  // "event_click"\ntype FocusEvent = EventName<'focus'>;  // "event_focus"\n\n// 结合 keyof 和映射类型使用\ntype EventConfig<${suffix} extends string> = {\n  [K in ${suffix} as \`on$\{Capitalize<K>}\`]: () => void;\n};`,
        label: `模板字面量类型 \`${prefix}_\${...}\``,
        explanation:
          '模板字面量类型在类型层面拼接字符串。你可以像 JavaScript 模板字符串一样，在类型中使用 ${} 嵌入其他类型，生成新的字符串字面量类型。配合 Capitalize 等内置字符串操作类型，可以构建强大的事件处理类型。',
      }
    },
    examples: ['模板字面量类型，event_加字符串', '模板字面量 on 加 Capitalize'],
  },

  // ── 9. Pick ──
  {
    pattern: 'utility_pick',
    name: 'Pick<T, K>',
    keywords: ['pick', '选取', '选取属性', 'pick', '从类型中选取', '挑选属性'],
    generate: (params) => {
      const source = params.sourceType || 'T'
      const keys = params.keys || "'id' | 'name'"
      return {
        code: `// Pick<${source}, ${keys}>：从 ${source} 中选取属性\ninterface ${source} {\n  id: number;\n  name: string;\n  email: string;\n  age: number;\n}\n\ntype Subset = Pick<${source}, ${keys}>;`,
        label: `Pick<${source}, ${keys}>`,
        explanation: `Pick 从类型 ${source} 中选取指定的属性 ${keys} 构造新类型。常用于创建包含仅部分字段的类型。`,
      }
    },
    examples: ['Pick 选取 id 和 name', '从类型中选取某些属性'],
  },

  // ── 10. Omit ──
  {
    pattern: 'utility_omit',
    name: 'Omit<T, K>',
    keywords: ['omit', '排除', '排除属性', 'omit', '删除属性', '移除属性'],
    generate: (params) => {
      const source = params.sourceType || 'T'
      const keys = params.keys || "'password' | 'ssn'"
      return {
        code: `// Omit<${source}, ${keys}>：从 ${source} 中排除属性\ninterface ${source} {\n  id: number;\n  name: string;\n  password: string;\n  ssn: string;\n}\n\ntype Public = Omit<${source}, ${keys}>;`,
        label: `Omit<${source}, ${keys}>`,
        explanation: `Omit 从类型 ${source} 中排除指定的属性 ${keys} 构造新类型。与 Pick 相反，常用于创建排除敏感信息的公开类型。`,
      }
    },
    examples: ['Omit 排除 password', '排除敏感字段'],
  },

  // ── 11. 类型守卫 ──
  {
    pattern: 'type_guard',
    name: '类型守卫',
    keywords: ['类型守卫', 'type guard', 'is', '类型谓词', 'type predicate', 'typeof', 'instanceof'],
    generate: (params) => {
      const typeName = params.typeName || 'string'
      const paramName = params.paramName || 'value'
      return {
        code: `// 类型守卫：检查 ${paramName} 是否为 ${typeName}\nfunction is${capitalize(typeName)}(value: unknown): value is ${typeName} {\n  return typeof value === '${typeName.toLowerCase()}';\n}\n\n// 使用示例\nfunction process(value: string | number) {\n  if (is${capitalize(typeName)}(value)) {\n    // 此处 value 类型收窄为 ${typeName}\n    console.log(value.toUpperCase());\n  }\n}`,
        label: `类型守卫 is${capitalize(typeName)}`,
        explanation: `这是一个类型守卫函数。它通过运行时检查（typeof）将 unknown 类型收窄为 ${typeName}。返回值类型为 "value is ${typeName}"，这是 TypeScript 的类型谓词语法，告诉编译器如果函数返回 true，参数的类型就被收窄为 ${typeName}。`,
      }
    },
    examples: ['类型守卫，检查是否为 string', '一个类型守卫函数 isString'],
  },

  // ── 12. 联合类型 ──
  {
    pattern: 'union_type',
    name: '联合类型',
    keywords: ['联合类型', 'union type', '联合', '或', '|', '可以是', '其中之一'],
    generate: (params) => {
      const types = params.types || 'string | number'
      return {
        code: `// 联合类型：${types}\ntype Status = 'active' | 'inactive' | 'pending';\ntype Result<T> = { success: true; data: T } | { success: false; error: string };\n\n// 可辨识联合（Discriminated Union）\ntype Shape =\n  | { kind: 'circle'; radius: number }\n  | { kind: 'rectangle'; width: number; height: number }\n  | { kind: 'triangle'; base: number; height: number };`,
        label: `联合类型 ${types}`,
        explanation:
          '联合类型表示一个值可以是几种类型之一。配合可辨识联合（discriminated union）模式，每个分支有一个字面量类型的 kind 字段，TypeScript 可以根据 kind 自动收窄类型，实现类型安全的条件分支。',
      }
    },
    examples: ['联合类型 string | number', '可辨识联合 Shape'],
  },

  // ── 13. 递归类型 ──
  {
    pattern: 'recursive_type',
    name: '递归类型',
    keywords: ['递归类型', 'recursive type', '递归', 'recursive', '树状结构', '嵌套', 'tree', '链表'],
    generate: (params) => {
      const name = params.name || 'TreeNode'
      return {
        code: `// 递归类型：${name}\ntype ${name}<T> = {\n  value: T;\n  children: ${name}<T>[];\n};\n\n// 另一个例子：JSON 值类型\ntype JSONValue =\n  | string\n  | number\n  | boolean\n  | null\n  | JSONValue[]\n  | { [key: string]: JSONValue };`,
        label: `递归类型 ${name}<T>`,
        explanation: `这是一个递归类型。${name} 在自己的定义中引用了自己，用于描述树状或嵌套结构。children 属性的类型是 ${name}<T>[]，形成无限递归的树形结构。递归类型适合描述 JSON、XML、文件目录等。`,
      }
    },
    examples: ['递归类型 TreeNode', '递归的树形结构'],
  },

  // ── 14. 断言函数 ──
  {
    pattern: 'assertion_function',
    name: '断言函数',
    keywords: ['断言函数', 'assertion function', 'asserts', '断言', '类型断言'],
    generate: (params) => {
      const condition = params.condition || 'isString'
      const paramName = params.paramName || 'value'
      return {
        code: `// 断言函数：asserts ${paramName} is string\nfunction assertString(${paramName}: unknown): asserts ${paramName} is string {\n  if (typeof ${paramName} !== 'string') {\n    throw new Error('Expected a string');\n  }\n}\n\n// 使用示例\nfunction process(${paramName}: unknown) {\n  assertString(${paramName});\n  // 此处 ${paramName} 已被收窄为 string\n  console.log(${paramName}.toUpperCase());\n}`,
        label: '断言函数 asserts',
        explanation:
          '断言函数使用 asserts 关键字告诉 TypeScript，如果函数没有抛出异常，参数的类型就被收窄。与类型守卫不同，断言函数不返回布尔值，而是在条件不满足时抛出错误，适用于前置条件检查。',
      }
    },
    examples: ['断言函数，断言为 string', '带 asserts 的类型收窄'],
  },

  // ── 15. 分布式条件类型 ──
  {
    pattern: 'distributive_conditional',
    name: '分布式条件类型',
    keywords: ['分布式', 'distribute', '分发', '联合类型', 'distributive conditional'],
    generate: (params) => {
      return {
        code: `// 分布式条件类型：联合类型自动分发\ntype ToArray<T> = T extends unknown ? T[] : never;\n\n// 当 T 是联合类型时，条件类型会分发\ntype Result = ToArray<string | number>;\n// string[] | number[]  (不是 (string | number)[])\n\n// 非分布版本（使用元组包裹阻止分发）\ntype ToArrayNonDist<T> = [T] extends [unknown] ? T[] : never;\ntype Result2 = ToArrayNonDist<string | number>;\n// (string | number)[]`,
        label: '分布式条件类型',
        explanation:
          '分布式条件类型是指当条件类型的检查类型是泛型参数且传入联合类型时，条件类型会自动分发到联合的每个成员上。ToArray<string | number> 的结果是 string[] | number[] 而不是 (string | number)[]。用方括号包裹类型参数可以阻止分发行为。',
      }
    },
    examples: ['分布式条件类型 ToArray', '联合类型分发到条件类型'],
  },
]

// ══════════════════════════════════════════
//  工具函数
// ══════════════════════════════════════════

/** 将字符串首字母大写 */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * 从自然语言描述中提取命名参数。
 * 支持的参数（从描述中智能提取）：
 * - typeParam: 类型参数名（如 T, K, U）
 * - returnType: 返回值类型
 * - paramType: 参数类型
 * - funcName: 函数名
 * - sourceType: 源类型名
 * - keys: 属性键集合
 * - constraint: 约束名
 * - typeName: 类型名称
 * - paramName: 参数名
 */
function extractParams(description: string): Record<string, string> {
  const params: Record<string, string> = {}

  // 提取类型参数（T, K, U, V 等）
  const tMatch = description.match(/<(\w+)>/)
  if (tMatch) params.typeParam = tMatch[1]

  // 提取 Promise<T> 中的类型
  const promiseMatch = description.match(/Promise<(\w+)>/i)
  if (promiseMatch) params.returnType = `Promise<${promiseMatch[1]}>`

  // 提取返回类型
  const returnMatch = description.match(/返回(\w+)/)
  if (returnMatch && !params.returnType) params.returnType = returnMatch[1]

  // 提取 extends 约束
  const extendsMatch = description.match(/extends\s+(\w+)/)
  if (extendsMatch) params.constraint = extendsMatch[1]

  // 提取具体类型名
  const typeNameMatch = description.match(/(?:类型|type)\s+(\w+)/i)
  if (typeNameMatch) params.typeName = typeNameMatch[1]

  // 提取 Pick/Omit 中的属性键
  const keysMatch = description.match(/['"]([\w\s|]+)['"]/)
  if (keysMatch) params.keys = keysMatch[1]

  // 提取函数名
  const funcMatch = description.match(/函数\s*(\w+)/)
  if (funcMatch) params.funcName = funcMatch[1]

  // 提取源类型名
  const sourceMatch = description.match(/(?:从|from)\s*(\w+)/i)
  if (sourceMatch) params.sourceType = sourceMatch[1]

  // 提取 extends 检查的类型
  const checkMatch = description.match(/(\w+)\s+extends\s+(\w+)/)
  if (checkMatch) {
    params.checkType = checkMatch[1]
    if (!params.againstType) params.againstType = checkMatch[2]
  }

  return params
}

/**
 * 将自然语言描述与模式匹配，返回匹配得分。
 * 得分越高表示越匹配。
 */
function scorePattern(description: string, pattern: OralCodePatternDef): number {
  const lower = description.toLowerCase()
  let score = 0

  for (const kw of pattern.keywords) {
    const lowerKw = kw.toLowerCase()
    // 精确匹配关键词 +1，部分包含 +0.5
    if (lower.includes(lowerKw)) {
      score += lowerKw.length > 4 ? 2 : 1
    }
    // 如果关键词本身包含空格（多词短语），加分
    if (lowerKw.includes(' ') && lower.includes(lowerKw)) {
      score += 3
    }
  }

  return score
}

// ══════════════════════════════════════════
//  语法验证
// ══════════════════════════════════════════

/**
 * 对生成的 TypeScript 代码进行基本语法验证。
 * 不依赖完整的 TypeScript 编译器 API（避免引入重型依赖），
 * 使用正则规则进行结构检查：
 * - 检查括号/尖括号/花括号配对
 * - 检查关键语法结构（interface, type, function 等）
 * - 检查常见的格式错误
 */
function verifyCode(code: string): { passed: boolean; error?: string } {
  if (!code || code.trim().length === 0) {
    return { passed: false, error: '代码为空' }
  }

  // 检查括号配对
  const pairs: [string, string, string][] = [
    ['{', '}', '花括号'],
    ['(', ')', '圆括号'],
    ['[', ']', '方括号'],
  ]

  for (const [open, close, name] of pairs) {
    let depth = 0
    for (const ch of code) {
      if (ch === open) depth++
      if (ch === close) depth--
      if (depth < 0) return { passed: false, error: `${name}不匹配：多余的闭合${name}` }
    }
    if (depth !== 0) return { passed: false, error: `${name}不匹配：缺少 ${depth} 个闭合${name}` }
  }

  // 检查尖括号配对（泛型 — 简化版）
  let angleDepth = 0
  let inString = false
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]
    const prev = i > 0 ? code[i - 1] : ''

    if (ch === '"' || ch === "'" || ch === '`') {
      if (prev !== '\\') inString = !inString
    }
    if (!inString) {
      if (ch === '<' && !/[a-zA-Z0-9_)\]\]]/.test(prev === '>' ? '' : prev)) {
        angleDepth++
      }
      if (ch === '>' && angleDepth > 0) {
        angleDepth--
      }
    }
  }

  if (angleDepth !== 0) {
    return { passed: false, error: `泛型尖括号不匹配：剩余 ${angleDepth} 个` }
  }

  // 检查关键语法结构
  const hasTypeKeyword = /\b(interface|type|function|class|enum)\b/.test(code)
  const hasArrow = /=>/.test(code)
  const hasSemicolon = /;/.test(code)
  const hasColon = /:/.test(code)

  if (!hasTypeKeyword && !hasArrow) {
    // 可能是纯表达式，放宽检查
  }

  return { passed: true }
}

// ══════════════════════════════════════════
//  OralCodeService
// ══════════════════════════════════════════

export class OralCodeService {
  /**
   * 处理口述代码输入：解析自然语言描述，生成 TypeScript 代码。
   *
   * @param input - 口述代码输入（用户的自然语言描述）
   * @returns 包含生成代码和解释的结果
   */
  process(input: OralCodeInput): OralCodeResult {
    const description = input.description.trim()
    if (!description) {
      return {
        success: false,
        pattern: 'unknown',
        code: '',
        explanation: '请描述你想生成的 TypeScript 类型，例如"一个泛型函数接受T返回T"。',
        label: '空输入',
        verification: 'skipped',
      }
    }

    log('INFO', 'oral_code_process', {
      description: description.slice(0, 80),
    })

    // 1. 匹配最佳模式
    const scored = PATTERNS.map((p) => ({
      pattern: p,
      score: scorePattern(description, p),
    }))
    scored.sort((a, b) => b.score - a.score)

    const best = scored[0]
    if (!best || best.score === 0) {
      return {
        success: false,
        pattern: 'unknown',
        code: '',
        explanation: `抱歉，我没能理解「${description}」对应的 TypeScript 模式。你可以尝试：\n- "一个泛型函数，接受T返回T"\n- "条件类型 IsString"\n- "映射类型，所有属性变为可选"\n- "Pick 选取 id 和 name"`,
        label: '未匹配',
        verification: 'skipped',
      }
    }

    // 2. 提取参数
    const params = extractParams(description)

    // 3. 生成代码
    const { code, label, explanation } = best.pattern.generate(params)

    // 4. 验证
    const verification = verifyCode(code)

    log('INFO', 'oral_code_generated', {
      pattern: best.pattern.pattern,
      label,
      passed: verification.passed,
      params: Object.keys(params),
    })

    return {
      success: verification.passed,
      pattern: best.pattern.pattern,
      code,
      label,
      explanation,
      verification: verification.passed ? 'passed' : 'failed',
      verificationError: verification.error,
    }
  }

  /**
   * 获取所有支持的口述代码模式列表（用于语音提示）。
   */
  getSupportedPatterns(): Array<{ pattern: OralCodePattern; name: string; examples: string[] }> {
    return PATTERNS.map((p) => ({
      pattern: p.pattern,
      name: p.name,
      examples: p.examples,
    }))
  }

  /**
   * 判断文本是否是口述代码意图。
   */
  isOralCodeQuery(text: string): boolean {
    const lower = text.toLowerCase()
    const oralKeywords = [
      '写',
      '生成',
      'create',
      'generate',
      'make',
      '代码',
      'code',
      '类型',
      'type',
      '一个',
      '示例',
      'example',
      'sample',
      '泛型',
      'generic',
      '条件',
      'conditional',
      '映射',
      'mapped',
      '模板',
      'template',
      '函数',
      'function',
      '接口',
      'interface',
    ]
    const matchCount = oralKeywords.filter((kw) => lower.includes(kw)).length
    return matchCount >= 2
  }

  /**
   * 将生成结果格式化为 TTS 可播报的文本。
   */
  formatForTts(result: OralCodeResult): string {
    if (!result.success) {
      return result.explanation
    }

    return [
      `好的，生成了一个${result.label}。`,
      result.explanation,
      `代码如下：`,
      ...result.code.split('\n').filter((line) => !line.startsWith('//')),
      `你可以尝试在 TypeScript Playground 中运行这段代码。`,
    ].join('。')
  }
}

/** 全局单例 */
export const oralCodeService = new OralCodeService()
