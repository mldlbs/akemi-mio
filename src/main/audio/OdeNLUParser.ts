/**
 * OdeNLUParser — 数学自然语言 → ODE 结构化参数 解析器
 *
 * 功能：
 * 1. 中文/英文自然语言 ODE 问题描述提取
 * 2. 中文数学术语归一化（"平方"→"**2", "根号"→"sqrt" 等）
 * 3. 方程、初值、区间、方法、步长多维度提取
 * 4. 部分参数提取后返回 Partial 状态，供 VoiceOdeSession 追问
 *
 * 覆盖的输入模式：
 * - "求解 dy/dx = x^2 + y，初值 y(0)=1，从 0 到 2"
 * - "dy/dx等于x平方加y，y0等于1，区间0到2"
 * - "solve y' = x + y, y(0)=0, from 0 to 1, step 0.01"
 * - "用欧拉法 求 y' = sin(x), y(0)=0，步长0.1"
 */

import { log } from '../logger/Logger'

// ════════════════════════════════════════════════════════════════════
//  类型
// ════════════════════════════════════════════════════════════════════

export interface OdeParseResult {
  /** 方程右侧 f(x,y) — 已归一化为 Python/SymPy 表达式 */
  equation?: string
  /** 初始条件，格式 "y(x0)=y0" */
  initialCondition?: string
  /** 求解区间 [a, b] */
  interval?: [number, number]
  /** 数值方法 */
  method?: 'euler' | 'rk4'
  /** 步长 */
  stepSize?: number
  /** 原始文本中是否明确指定了方法 */
  methodExplicit?: boolean
  /** 未解析的原始文本片段 */
  rawText: string
}

export interface OdeParseDiagnostic {
  /** 解析耗时 ms */
  elapsedMs: number
  /** 匹配到的模式数 */
  matchedPatterns: string[]
  /** 归一化后的文本 */
  normalized: string
  /** 是否有任何字段被提取 */
  hasAny: boolean
  /** 缺少的必填字段 */
  missingRequired: string[]
}

export type OdeRequiredField = 'equation' | 'initialCondition' | 'interval'

/** 必填字段列表 */
const REQUIRED_FIELDS: OdeRequiredField[] = ['equation', 'initialCondition', 'interval']

// ════════════════════════════════════════════════════════════════════
//  中文数学术语 → Python/SymPy 表达式映射
// ════════════════════════════════════════════════════════════════════

interface MathTermMapping {
  pattern: RegExp
  replacement: string
}

const MATH_TERM_MAPPINGS: MathTermMapping[] = [
  // 幂运算（优先匹配复合形式）
  { pattern: /的(\d+)次方/g, replacement: '**$1' },
  { pattern: /平方/g, replacement: '**2' },
  { pattern: /立方/g, replacement: '**3' },
  { pattern: /四次方/g, replacement: '**4' },

  // 根号
  { pattern: /根号下\s*([a-zA-Z0-9_{}().+\-*/^]+)/g, replacement: 'sqrt($1)' },
  { pattern: /根号\s*([a-zA-Z0-9_{}().+\-*/^]+)/g, replacement: 'sqrt($1)' },
  { pattern: /根号/g, replacement: 'sqrt(' }, // fallback — 可能缺右括号

  // 常数
  { pattern: /圆周率/g, replacement: 'pi' },
  { pattern: /π/g, replacement: 'pi' },

  // 指数/对数
  { pattern: /e\^\(/g, replacement: 'exp(' },
  { pattern: /e\^([a-zA-Z0-9_{}().+\-*/]+)/g, replacement: 'exp($1)' },
  { pattern: /e的\s*([^，。,.\s]+)\s*次方/g, replacement: 'exp($1)' },
  { pattern: /自然对数/g, replacement: 'log' },
  { pattern: /ln\s*\(/g, replacement: 'log(' },

  // 三角函数
  { pattern: /正弦/g, replacement: 'sin' },
  { pattern: /余弦/g, replacement: 'cos' },
  { pattern: /正切/g, replacement: 'tan' },

  // 基本运算符（中文 → 符号）
  { pattern: /等于/g, replacement: '=' },
  { pattern: /除以/g, replacement: '/' },
  { pattern: /乘以/g, replacement: '*' },
  { pattern: /乘/g, replacement: '*' },
  { pattern: /加/g, replacement: '+' },
  { pattern: /减/g, replacement: '-' },

  // 导数表示法归一化
  { pattern: /d[yY]\/d[xX]/g, replacement: 'dy/dx' },
  { pattern: /d[yY]\/dx/g, replacement: 'dy/dx' },
  { pattern: /dy\/d[xX]/g, replacement: 'dy/dx' },
  { pattern: /y'/g, replacement: 'dy/dx' },
  { pattern: /y′/g, replacement: 'dy/dx' },
  { pattern: /y＇/g, replacement: 'dy/dx' },

  // 常见数学记法
  { pattern: /(\d+)\.(\d+)/g, replacement: '$1.$2' }, // 保留小数
]

// ════════════════════════════════════════════════════════════════════
//  提取正则
// ════════════════════════════════════════════════════════════════════

/** 方程提取 — 匹配 "dy/dx = f(x,y)" 或 "y' = f(x,y)" 形式的完整方程 */
const EQUATION_FULL_RE = /(?:dy\/dx|y'|y′|y＇)\s*=\s*(.+?)(?=\s+(?:初值|y\(|初始|边界|起始|从|在|区间|步长|step|from|with|using|use|method|,|$))/

/** 方程提取 — 仅 RHS，在已清除导数码头的文本中 */
const EQUATION_RHS_RE = /(?:^|，|,)\s*(.+?)\s*(?=(?:初值|y\(|y0|初始|起始|从|在|区间|步长|step|from|with|using|use|method)$)/

/** 初值提取 */
const INITIAL_COND_RE = /y\s*\(\s*(-?\d+\.?\d*)\s*\)\s*=\s*(-?\d+\.?\d*)/

/** 初值提取（中文简写）— y0 = 1 */
const INITIAL_COND_SHORT_RE = /y0\s*等于\s*(-?\d+\.?\d*)/

/** 初值提取（英文简写）— y0 = 1 */
const INITIAL_COND_EN_RE = /y0\s*=\s*(-?\d+\.?\d*)/

/** 区间提取（中文）— 从 X 到 Y */
const INTERVAL_CN_RE = /从\s*(-?\d+\.?\d*)\s*(?:到|至|～|~)\s*(-?\d+\.?\d*)/

/** 区间提取（英文）— from X to Y */
const INTERVAL_EN_RE = /from\s+(-?\d+\.?\d*)\s+to\s+(-?\d+\.?\d*)/

/** 区间提取 — 区间[ X , Y ] */
const INTERVAL_BRACKET_RE = /区间\s*[\[\(]\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*[\])]/

/** 方法提取（中文） */
const METHOD_EULER_CN_RE = /欧拉|euler|前向/
const METHOD_RK4_CN_RE = /rk4|rk-4|龙格|库塔|runge|龙格-库塔|四阶/

/** 步长提取 */
const STEP_SIZE_RE = /(?:步长|step\s*size|h\s*=?)\s*[=:：]?\s*(\d+\.?\d*(?:e[+-]?\d+)?)/

/** 求解/计算触发词 */
const SOLVE_TRIGGER_RE = /(?:求解|计算|求|解|solve|compute|calculate|integrate)/

// ════════════════════════════════════════════════════════════════════
//  缺失检测提示模板
// ════════════════════════════════════════════════════════════════════

export const MISSING_FIELD_PROMPTS: Record<OdeRequiredField, string[]> = {
  equation: [
    '请告诉我微分方程是什么？例如 "dy/dx = x + y"',
    '方程未识别，请说清楚右侧表达式，如 "dy/dx 等于 x 平方加 y"',
  ],
  initialCondition: [
    '还需要初始条件，例如 "y(0) = 1"',
    '请提供初值，例如 "y0 等于 1"',
  ],
  interval: [
    '请指定求解区间，例如 "从 0 到 2"',
    '还需要 x 的范围，例如 "从 0 到 2"',
  ],
}

// ════════════════════════════════════════════════════════════════════
//  主解析器
// ════════════════════════════════════════════════════════════════════

export class OdeNLUParser {
  /**
   * 解析自然语言 ODE 描述文本，提取结构化参数。
   *
   * @param text 用户语音转写文本
   * @returns 解析结果 + 诊断信息
   */
  parse(text: string): { result: OdeParseResult; diagnostic: OdeParseDiagnostic } {
    const t0 = Date.now()
    const matchedPatterns: string[] = []
    const raw = text.trim()

    if (!raw) {
      return {
        result: { rawText: raw },
        diagnostic: {
          elapsedMs: 0,
          matchedPatterns: [],
          normalized: '',
          hasAny: false,
          missingRequired: [...REQUIRED_FIELDS],
        },
      }
    }

    // ── 1. 归一化：中文数学术语 → SymPy 表达式 ──
    let normalized = raw
    for (const mapping of MATH_TERM_MAPPINGS) {
      if (mapping.pattern.test(normalized)) {
        mapping.pattern.lastIndex = 0
        normalized = normalized.replace(mapping.pattern, mapping.replacement)
        matchedPatterns.push(`math_term:${mapping.replacement}`)
      }
    }

    const result: OdeParseResult = { rawText: raw }

    // ── 2. 提取方程 ──

    // 先尝试完整格式 "dy/dx = expr"
    const fullEqMatch = normalized.match(EQUATION_FULL_RE)
    if (fullEqMatch) {
      result.equation = fullEqMatch[1].trim()
      matchedPatterns.push('equation_full')
    } else {
      // 尝试提取等号左侧为导数，右侧为表达式
      const eqParts = normalized.split('=')
      if (eqParts.length >= 2) {
        const lhs = eqParts[0].trim()
        const rhs = eqParts.slice(1).join('=').trim() // 可能有多个等号
        if (lhs.includes('dy/dx') || lhs.includes("y'") || lhs.includes('导数')) {
          // 清理 RHS：去掉尾部的其他参数描述
          let cleaned = rhs
          const tailCut = cleaned.match(
            /^(.*?)(?:\s+(?:初值|y\(|初始|起始|从|在|区间|步长|step|from|with|using|use|method)|$)/,
          )
          if (tailCut) cleaned = tailCut[1].trim()
          result.equation = cleaned
          matchedPatterns.push('equation_with_derivative')
        }
      }
    }

    // 如果还没提取到，尝试把文本中数学相关部分作为方程
    if (!result.equation) {
      const rhsMatch = normalized.match(EQUATION_RHS_RE)
      if (rhsMatch) {
        result.equation = rhsMatch[1].trim()
        matchedPatterns.push('equation_rhs')
      }
    }

    // ── 3. 提取初值 ──

    const icMatch = normalized.match(INITIAL_COND_RE)
    if (icMatch) {
      result.initialCondition = `y(${icMatch[1]})=${icMatch[2]}`
      matchedPatterns.push('initial_cond_standard')
    } else {
      const icShortMatch = normalized.match(INITIAL_COND_SHORT_RE)
      if (icShortMatch) {
        result.initialCondition = `y(0)=${icShortMatch[1]}`
        matchedPatterns.push('initial_cond_short')
      } else {
        const icEnMatch = normalized.match(INITIAL_COND_EN_RE)
        if (icEnMatch) {
          result.initialCondition = `y(0)=${icEnMatch[1]}`
          matchedPatterns.push('initial_cond_en')
        }
      }
    }

    // ── 4. 提取区间 ──

    let intervalMatch = normalized.match(INTERVAL_CN_RE)
    if (intervalMatch) {
      result.interval = [parseFloat(intervalMatch[1]), parseFloat(intervalMatch[2])]
      matchedPatterns.push('interval_cn')
    } else {
      intervalMatch = normalized.match(INTERVAL_EN_RE)
      if (intervalMatch) {
        result.interval = [parseFloat(intervalMatch[1]), parseFloat(intervalMatch[2])]
        matchedPatterns.push('interval_en')
      } else {
        intervalMatch = normalized.match(INTERVAL_BRACKET_RE)
        if (intervalMatch) {
          result.interval = [parseFloat(intervalMatch[1]), parseFloat(intervalMatch[2])]
          matchedPatterns.push('interval_bracket')
        }
      }
    }

    // ── 5. 提取方法 ──

    if (METHOD_EULER_CN_RE.test(normalized)) {
      result.method = 'euler'
      result.methodExplicit = true
      matchedPatterns.push('method_euler')
    } else if (METHOD_RK4_CN_RE.test(normalized)) {
      result.method = 'rk4'
      result.methodExplicit = true
      matchedPatterns.push('method_rk4')
    }

    // ── 6. 提取步长 ──

    const stepMatch = normalized.match(STEP_SIZE_RE)
    if (stepMatch) {
      result.stepSize = parseFloat(stepMatch[1])
      matchedPatterns.push('step_size')
    }

    // ── 7. 诊断 ──

    const missingRequired = REQUIRED_FIELDS.filter((f) => !result[f])
    const hasAny = result.equation !== undefined || result.initialCondition !== undefined || result.interval !== undefined

    const diagnostic: OdeParseDiagnostic = {
      elapsedMs: Date.now() - t0,
      matchedPatterns,
      normalized,
      hasAny,
      missingRequired,
    }

    log('INFO', 'ode_nlu_parse', {
      text_len: raw.length,
      has_equation: !!result.equation,
      has_ic: !!result.initialCondition,
      has_interval: !!result.interval,
      has_method: !!result.method,
      has_step: !!result.stepSize !== undefined,
      matched_patterns: matchedPatterns.length,
      missing: missingRequired.join(','),
      elapsed_ms: diagnostic.elapsedMs,
    })

    return { result, diagnostic }
  }

  /**
   * 判断参数是否完整（可执行求解）。
   * 方程、初值、区间为必填。
   */
  isComplete(parsed: OdeParseResult): boolean {
    return REQUIRED_FIELDS.every((f) => parsed[f] !== undefined && parsed[f] !== '')
  }

  /**
   * 获取缺失字段的询问提示。
   * @param parsed 当前已解析的结果
   * @returns 询问文本数组（可用于 TTS 播报）
   */
  getMissingPrompts(parsed: OdeParseResult): string[] {
    const prompts: string[] = []
    for (const field of REQUIRED_FIELDS) {
      if (!parsed[field] || parsed[field] === '') {
        prompts.push(MISSING_FIELD_PROMPTS[field][0])
      }
    }
    return prompts
  }

  /**
   * 校验区间有效性。
   */
  validateInterval(interval: [number, number]): string | null {
    const [a, b] = interval
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return '区间端点必须是有效数字'
    }
    if (b <= a) {
      return `无效区间: 终点(${b})必须大于起点(${a})`
    }
    if (b - a > 1_000_000) {
      return '区间范围过大（超过 1,000,000），请缩小求解区间'
    }
    return null
  }

  /**
   * 校验步长有效性。
   */
  validateStepSize(stepSize: number, interval: [number, number]): string | null {
    if (!Number.isFinite(stepSize) || stepSize <= 0) {
      return '步长必须是正数'
    }
    if (stepSize < 0.0001) {
      return '步长过小，建议使用 ≥ 0.0001'
    }
    if (interval && stepSize > interval[1] - interval[0]) {
      return `步长 ${stepSize} 超过了求解区间长度 ${interval[1] - interval[0]}`
    }
    return null
  }

  /**
   * 累积解析：将新文本合并到已有解析结果中。
   * 已存在的字段不会被覆盖，除非新文本提供了更完整的信息。
   */
  merge(existing: OdeParseResult, newText: string): OdeParseResult {
    const { result: parsed } = this.parse(newText)
    const merged: OdeParseResult = { ...existing, rawText: newText }

    // 方程：新解析到的覆盖，除非旧版本已经更完整
    if (parsed.equation && !existing.equation) {
      merged.equation = parsed.equation
    }

    // 初值
    if (parsed.initialCondition && !existing.initialCondition) {
      merged.initialCondition = parsed.initialCondition
    }

    // 区间：覆盖
    if (parsed.interval && !existing.interval) {
      merged.interval = parsed.interval
    }

    // 方法
    if (parsed.method && (!existing.method || parsed.methodExplicit)) {
      merged.method = parsed.method
      merged.methodExplicit = parsed.methodExplicit
    }

    // 步长
    if (parsed.stepSize !== undefined && existing.stepSize === undefined) {
      merged.stepSize = parsed.stepSize
    }

    return merged
  }
}

/** 全局单例 */
export const odeNluParser = new OdeNLUParser()
