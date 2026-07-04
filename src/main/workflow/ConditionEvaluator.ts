/**
 * 条件表达式 DSL 求值器
 *
 * 语法（源自 GitHub Actions 风格表达式）：
 *   > 7                  — 大于
 *   >= 4 and <= 7        — 区间
 *   == 'approve'         — 字符串相等
 *   != ''                — 非空
 *   == true              — 布尔相等
 *   contains 'keyword'   — 字符串包含
 *   startsWith 'prefix'  — 前缀匹配
 *
 * 操作符优先级（从高到低）：
 *   1. 括号 ()
 *   2. not
 *   3. >, >=, <, <=, ==, !=, contains, startsWith
 *   4. and
 *   5. or
 */

type CompareOp = '>' | '>=' | '<' | '<=' | '==' | '!=' | 'contains' | 'startsWith'
type Token =
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'bool'; value: boolean }
  | { type: 'op'; value: CompareOp }
  | { type: 'logical'; value: 'and' | 'or' | 'not' }
  | { type: 'lparen' }
  | { type: 'rparen' }

/**
 * 对实际值执行条件判断
 *
 * @param condition - DSL 条件表达式，如 "> 7"、"== 'approve'"
 * @param actual - 实际值（已从模板解析出来的）
 * @returns 条件是否满足
 */
export function evaluateCondition(condition: string, actual: any): boolean {
  if (!condition || condition === '') return true
  const trimmed = condition.trim()

  // 纯布尔/存在性检查
  if (trimmed === 'true') return actual === true
  if (trimmed === 'false') return actual === false
  if (trimmed === 'null' || trimmed === 'undefined') return actual === null || actual === undefined

  // 单一操作符表达式: "> 7", "== 'approve'"
  const result = trySimpleCompare(trimmed, actual)
  if (result !== undefined) return result

  // 复合表达式: ">= 4 and <= 7", "(> 5 or == 'special')"
  return evaluateCompound(trimmed, actual)
}

function trySimpleCompare(expr: string, actual: any): boolean | undefined {
  const patterns: { re: RegExp; op: CompareOp }[] = [
    { re: /^>\s*([\d.]+)$/, op: '>' },
    { re: /^>=\s*([\d.]+)$/, op: '>=' },
    { re: /^<\s*([\d.]+)$/, op: '<' },
    { re: /^<=\s*([\d.]+)$/, op: '<=' },
    { re: /^==\s*(.+)$/, op: '==' },
    { re: /^!=\s*(.+)$/, op: '!=' },
    { re: /^contains\s+(.+)$/, op: 'contains' },
    { re: /^startsWith\s+(.+)$/, op: 'startsWith' },
  ]

  for (const p of patterns) {
    const m = expr.match(p.re)
    if (!m) continue
    const rhs = parseLiteral(m[1])
    return applyCompare(p.op, actual, rhs)
  }
  return undefined
}

function parseLiteral(s: string): any {
  const v = s.trim()
  if (v === 'true') return true
  if (v === 'false') return false
  if (v === 'null') return null
  if (v === 'undefined') return undefined
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    return v.slice(1, -1)
  }
  return v
}

function applyCompare(op: CompareOp, actual: any, expected: any): boolean {
  switch (op) {
    case '>':
      return typeof actual === 'number' && typeof expected === 'number' ? actual > expected : false
    case '>=':
      return typeof actual === 'number' && typeof expected === 'number' ? actual >= expected : false
    case '<':
      return typeof actual === 'number' && typeof expected === 'number' ? actual < expected : false
    case '<=':
      return typeof actual === 'number' && typeof expected === 'number' ? actual <= expected : false
    case '==':
      return actual == expected
    case '!=':
      return actual != expected
    case 'contains':
      return typeof actual === 'string' && typeof expected === 'string' ? actual.toLowerCase().includes(expected.toLowerCase()) : false
    case 'startsWith':
      return typeof actual === 'string' && typeof expected === 'string' ? actual.toLowerCase().startsWith(expected.toLowerCase()) : false
    default:
      return false
  }
}

/**
 * 复合表达式求值
 */
function evaluateCompound(expr: string, actual: any): boolean {
  const tokens = tokenize(expr)
  if (tokens.length === 0) return false
  let pos = 0
  return parseOr(tokens, actual, () => pos)
}

function tokenize(expr: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < expr.length) {
    if (expr[i] === ' ') {
      i++
      continue
    }
    if (expr[i] === '(') {
      tokens.push({ type: 'lparen' })
      i++
      continue
    }
    if (expr[i] === ')') {
      tokens.push({ type: 'rparen' })
      i++
      continue
    }

    if (/[\d.]/.test(expr[i])) {
      const numMatch = expr.slice(i).match(/^[\d.]+/)
      if (numMatch) {
        tokens.push({ type: 'number', value: Number(numMatch[0]) })
        i += numMatch[0].length
        continue
      }
    }

    const opMatch = expr.slice(i).match(/^(>=|<=|==|!=|>|<)/)
    if (opMatch) {
      tokens.push({ type: 'op', value: opMatch[1] as CompareOp })
      i += opMatch[1].length
      continue
    }

    const wordMatch = expr.slice(i).match(/^(contains|startsWith|not|and|or)\b/)
    if (wordMatch) {
      const word = wordMatch[1]
      if (word === 'and' || word === 'or' || word === 'not') {
        tokens.push({ type: 'logical', value: word })
      } else {
        tokens.push({ type: 'op', value: word as CompareOp })
      }
      i += wordMatch[1].length
      continue
    }

    if (expr[i] === "'" || expr[i] === '"') {
      const quote = expr[i]
      let j = i + 1
      while (j < expr.length && expr[j] !== quote) j++
      tokens.push({ type: 'string', value: expr.slice(i + 1, j) })
      i = j + 1
      continue
    }

    const litMatch = expr.slice(i).match(/^(true|false|null|undefined)\b/)
    if (litMatch) {
      tokens.push({ type: 'bool', value: litMatch[1] === 'true' })
      i += litMatch[1].length
      continue
    }

    const bare = expr.slice(i).match(/^[^\s()]+/)
    if (bare) {
      tokens.push({ type: 'string', value: bare[0] })
      i += bare[0].length
      continue
    }
    i++
  }
  return tokens
}

function parseOr(tokens: Token[], actual: any, pos: () => number): boolean {
  return parseLoop(tokens, actual, pos, 'or', parseAnd)
}

function parseAnd(tokens: Token[], actual: any, pos: () => number): boolean {
  return parseLoop(tokens, actual, pos, 'and', parseNot)
}

function parseNot(tokens: Token[], actual: any, pos: () => number): boolean {
  if (hasMore(pos, tokens) && is('logical', 'not')(tokens[pos()])) {
    pos = inc(pos)
    return !parsePrimary(tokens, actual, pos)
  }
  return parsePrimary(tokens, actual, pos)
}

function parsePrimary(tokens: Token[], actual: any, pos: () => number): boolean {
  if (!hasMore(pos, tokens)) return false

  if (is('lparen')(tokens[pos()])) {
    pos = inc(pos)
    const result = parseOr(tokens, actual, pos)
    if (hasMore(pos, tokens) && is('rparen')(tokens[pos()])) pos = inc(pos)
    return result
  }

  // op value（左操作数是 actual）
  if (isOp(tokens[pos()])) {
    const op = (tokens[pos()] as any).value as CompareOp
    pos = inc(pos)
    const rhs = literalValue(tokens, pos)
    pos = inc(pos)
    return applyCompare(op, actual, rhs)
  }

  // value op value
  const lhs = literalValue(tokens, pos)
  if (lhs === undefined) pos = inc(pos)
  else pos = inc(pos)
  if (hasMore(pos, tokens) && isOp(tokens[pos()])) {
    const op = (tokens[pos()] as any).value as CompareOp
    pos = inc(pos)
    const rhs = literalValue(tokens, pos)
    if (rhs !== undefined) pos = inc(pos)
    return applyCompare(op, lhs, rhs)
  }

  // 裸 bool
  if (is('bool')(tokens[pos()])) {
    const val = (tokens[pos()] as any).value as boolean
    pos = inc(pos)
    return val
  }

  return false
}

function parseLoop(
  tokens: Token[],
  actual: any,
  pos: () => number,
  logical: 'and' | 'or',
  next: (t: Token[], a: any, p: () => number) => boolean,
): boolean {
  let left = next(tokens, actual, pos)
  while (hasMore(pos, tokens) && is('logical', logical)(tokens[pos()])) {
    pos = inc(pos)
    const right = next(tokens, actual, pos)
    left = logical === 'and' ? left && right : left || right
  }
  return left
}

function literalValue(tokens: Token[], pos: () => number): any {
  if (!hasMore(pos, tokens)) return undefined
  const t = tokens[pos()]
  if (t.type === 'number') return (t as any).value
  if (t.type === 'string') return (t as any).value
  if (t.type === 'bool') return (t as any).value
  return undefined
}

function hasMore(pos: () => number, tokens: Token[]): boolean {
  return pos() < tokens.length
}

function is(type: string, value?: string): (t: Token) => boolean {
  return (t: Token) => t.type === type && (value === undefined || (t as any).value === value)
}

function isOp(t: Token): boolean {
  return t.type === 'op'
}

function inc(p: () => number): () => number {
  let v = p()
  return () => v + 1
}
