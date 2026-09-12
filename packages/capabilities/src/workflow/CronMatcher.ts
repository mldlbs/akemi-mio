/**
 * CronMatcher — 标准 5 字段 cron 表达式求值器
 *
 * 格式: MIN HOUR DOM MON DOW
 *   MIN  0-59
 *   HOUR 0-23
 *   DOM  1-31
 *   MON  1-12
 *   DOW  0-7 (0 和 7 都表示周日)
 *
 * 支持语法:
 *   *        任意
 *   /N       N 步间隔 (如 /5 = 每 5)
 *   N        精确值
 *   N,M,Z    列表
 *   N-M      区间
 *
 * 用法:
 *   const matcher = new CronMatcher("0 9 * * 1-5")
 *   matcher.match(new Date())  // true/false
 */

export class CronMatcher {
  private minute: number[]
  private hour: number[]
  private dom: number[]
  private month: number[]
  private dow: number[]
  private raw: string

  constructor(expression: string) {
    this.raw = expression
    const fields = expression.trim().split(/\s+/)
    if (fields.length !== 5) {
      throw new Error(`Cron expression must have 5 fields, got ${fields.length}: "${expression}"`)
    }
    this.minute = parseField(fields[0], 0, 59)
    this.hour = parseField(fields[1], 0, 23)
    this.dom = parseField(fields[2], 1, 31)
    this.month = parseField(fields[3], 1, 12)
    this.dow = parseField(fields[4], 0, 7, true)
  }

  match(date: Date): boolean {
    const m = date.getMinutes()
    const h = date.getHours()
    const d = date.getDate()
    const mon = date.getMonth() + 1
    const w = date.getDay()

    if (!this.minute.includes(m)) return false
    if (!this.hour.includes(h)) return false
    if (!this.dom.includes(d)) return false
    if (!this.month.includes(mon)) return false
    if (!this.dow.includes(w)) return false

    return true
  }

  toString(): string {
    return this.raw
  }
}

function parseField(field: string, min: number, max: number, normalizeDow = false): number[] {
  if (field.includes(',')) {
    return field.split(',').flatMap((f) => parseSingle(f, min, max, normalizeDow))
  }
  return parseSingle(field, min, max, normalizeDow)
}

function parseSingle(field: string, min: number, max: number, normalizeDow: boolean): number[] {
  if (field === '*') {
    return range(min, max)
  }

  const stepMatch = field.match(/^\*\/(\d+)$/)
  if (stepMatch) {
    const step = parseInt(stepMatch[1], 10)
    if (step <= 0) throw new Error(`Invalid cron step: ${field}`)
    const result: number[] = []
    for (let i = min; i <= max; i += step) result.push(i)
    return result
  }

  const rangeMatch = field.match(/^(\d+)-(\d+)$/)
  if (rangeMatch) {
    const a = Math.max(min, parseInt(rangeMatch[1], 10))
    const b = Math.min(max, parseInt(rangeMatch[2], 10))
    return range(a, b).map((v) => normalizeDowVal(v, normalizeDow))
  }

  const rangeStepMatch = field.match(/^(\d+)-(\d+)\/(\d+)$/)
  if (rangeStepMatch) {
    const a = Math.max(min, parseInt(rangeStepMatch[1], 10))
    const b = Math.min(max, parseInt(rangeStepMatch[2], 10))
    const step = parseInt(rangeStepMatch[3], 10)
    const result: number[] = []
    for (let i = a; i <= b; i += step) result.push(normalizeDowVal(i, normalizeDow))
    return result
  }

  const num = parseInt(field, 10)
  if (isNaN(num) || num < min || num > max) {
    throw new Error(`Invalid cron field value "${field}" — expected ${min}-${max}`)
  }
  return [normalizeDowVal(num, normalizeDow)]
}

function normalizeDowVal(v: number, normalize: boolean): number {
  if (normalize && v === 7) return 0
  return v
}

function range(start: number, end: number): number[] {
  const result: number[] = []
  for (let i = start; i <= end; i++) result.push(i)
  return result
}
