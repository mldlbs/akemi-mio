'use strict'

/**
 * 三处形态注册表一致性门禁（静态，不需要打包 exe）。
 *
 * 背景：形态（pet / chat / wallpaper）的窗口参数在三处各留了一份副本：
 *   1. src/renderer/src/forms/types.ts        —— FORM_KINDS / FORM_REGISTRY（渲染侧真相源）
 *   2. packages/core/src/core/Lifecycle.ts    —— FORM_SPECS（主进程侧真相源）
 *   3. electron.vite.config.ts                —— renderer 的 rollupOptions.input
 * 之所以不共享同一份常量：packages/core 不能 import src/renderer（构建图反向），
 * 而 src/renderer 被 sandbox 隔离也不能 require 主进程包。只能各留一份。
 *
 * 问题：三份副本**没有任何自动校验**。任一处漏改的后果是**运行期窗口空白**，
 * 而构建、typecheck、lint 全都不会报错 —— 三份副本各自内部都是自洽的。
 * 原有的 forms/__tests__/types.test.ts 只校验 FORM_REGISTRY 自身，
 * 无法发现「types.ts 加了形态但 vite 没加 input」这类跨文件漂移。
 *
 * scripts/check-renderer-entries.cjs 能在运行期抓到这个问题，但它必须启动
 * 打包好的 exe，因此进不了 CI 的 quality job（那一步还没有产物）。
 * 本脚本是它的静态等价物：秒级、无依赖，适合放在 quality job 里当第一道闸。
 *
 * 退出码：0 = 三处一致；1 = 有不一致（逐条打印差异）。
 */

const fs = require('fs')
const path = require('path')

const repo = path.resolve(__dirname, '..')

const SOURCES = {
  renderer: path.join(repo, 'src', 'renderer', 'src', 'forms', 'types.ts'),
  main: path.join(repo, 'packages', 'core', 'src', 'core', 'Lifecycle.ts'),
  vite: path.join(repo, 'electron.vite.config.ts'),
}

// ─────────────────────────── 极简 TS/JS 字面量解析 ───────────────────────────
// 目标不是实现一个 TS 解析器，而是把这三处声明里的**字面量**取出来。
// 用递归下降而非行正则，是因为这些声明里有嵌套对象（size/minSize）和
// 跨行的值，行正则一旦碰上格式调整就会静默失配 —— 而门禁静默失配比没有门禁更糟。

function skipTrivia(src, i) {
  for (;;) {
    const c = src[i]
    if (c === undefined) return i
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end === -1 ? src.length : end + 2
      continue
    }
    return i
  }
}

function readString(src, i) {
  const quote = src[i]
  let out = ''
  i++
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') {
      out += src[i + 1]
      i += 2
      continue
    }
    if (c === quote) return { value: out, end: i + 1 }
    out += c
    i++
  }
  throw new Error(`字符串未闭合（偏移 ${i}）`)
}

/** 从 i 起扫过一个表达式，停在深度 0 的 `,` `}` `]` 之前。用于 resolve(...) 这类调用。 */
function scanExpression(src, i) {
  let depth = 0
  let j = i
  while (j < src.length) {
    const c = src[j]
    if (c === "'" || c === '"' || c === '`') {
      j = readString(src, j).end
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break
      depth--
    } else if (c === ',' && depth === 0) break
    j++
  }
  return j
}

function parseValue(src, i) {
  const c = src[i]
  if (c === '{') return parseObject(src, i)
  if (c === '[') return parseArray(src, i)
  if (c === "'" || c === '"' || c === '`') return readString(src, i)

  const num = /^-?\d+(?:\.\d+)?/.exec(src.slice(i))
  if (num) return { value: Number(num[0]), end: i + num[0].length }

  const word = /^(true|false|null)\b/.exec(src.slice(i))
  if (word) return { value: JSON.parse(word[0]), end: i + word[0].length }

  const end = scanExpression(src, i)
  const raw = src.slice(i, end).trim()
  if (!raw) throw new Error(`无法解析值（偏移 ${i}）`)
  return { value: { __raw: raw }, end }
}

function parseObject(src, start) {
  let i = skipTrivia(src, start + 1)
  const out = {}
  for (;;) {
    i = skipTrivia(src, i)
    if (src[i] === '}') return { value: out, end: i + 1 }
    if (i >= src.length) throw new Error(`对象未闭合（起始 ${start}）`)

    let key
    if (src[i] === "'" || src[i] === '"') {
      const r = readString(src, i)
      key = r.value
      i = r.end
    } else {
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))
      if (!m) throw new Error(`无法解析键（偏移 ${i}）`)
      key = m[0]
      i += m[0].length
    }

    i = skipTrivia(src, i)
    if (src[i] !== ':') throw new Error(`期望 ':' 但得到 ${JSON.stringify(src[i])}（偏移 ${i}）`)
    i = skipTrivia(src, i + 1)

    const r = parseValue(src, i)
    out[key] = r.value
    i = skipTrivia(src, r.end)

    if (src[i] === ',') {
      i++
      continue
    }
    if (src[i] === '}') return { value: out, end: i + 1 }
    throw new Error(`意外的字符 ${JSON.stringify(src[i])}（偏移 ${i}）`)
  }
}

function parseArray(src, start) {
  let i = skipTrivia(src, start + 1)
  const out = []
  for (;;) {
    i = skipTrivia(src, i)
    if (src[i] === ']') return { value: out, end: i + 1 }
    if (i >= src.length) throw new Error(`数组未闭合（起始 ${start}）`)
    const r = parseValue(src, i)
    out.push(r.value)
    i = skipTrivia(src, r.end)
    if (src[i] === ',') {
      i++
      continue
    }
    if (src[i] === ']') return { value: out, end: i + 1 }
    throw new Error(`意外的字符 ${JSON.stringify(src[i])}（偏移 ${i}）`)
  }
}

/** 找到 `<name> ... = {` 里的 `{` 位置并解析整个对象。`[^=]*` 保证不会跨过赋值号。 */
function readObject(src, name, file) {
  const re = new RegExp(`\\b${name}\\b[^=]*=\\s*\\{`)
  const m = re.exec(src)
  if (!m) throw new Error(`${file}: 找不到 ${name} 的对象字面量`)
  return parseObject(src, m.index + m[0].length - 1).value
}

/** 找到 `<name> ... = [` 里的 `[` 位置并解析整个数组。 */
function readArray(src, name, file) {
  const re = new RegExp(`\\b${name}\\b[^=]*=\\s*\\[`)
  const m = re.exec(src)
  if (!m) throw new Error(`${file}: 找不到 ${name} 的数组字面量`)
  return parseArray(src, m.index + m[0].length - 1).value
}

/** 取 `export type FormKind = 'a' | 'b'` 的联合成员。 */
function readUnion(src, name, file) {
  const re = new RegExp(`\\btype\\s+${name}\\s*=\\s*([^\\n]+)`)
  const m = re.exec(src)
  if (!m) throw new Error(`${file}: 找不到 type ${name}`)
  return m[1]
    .split('|')
    .map((s) => s.trim())
    .filter((s) => /^['"]/.test(s))
    .map((s) => s.replace(/^['"]|['"]$/g, ''))
}

// ─────────────────────────── 三处来源的采集 ───────────────────────────

function collect() {
  const rendererSrc = fs.readFileSync(SOURCES.renderer, 'utf8')
  const mainSrc = fs.readFileSync(SOURCES.main, 'utf8')
  const viteSrc = fs.readFileSync(SOURCES.vite, 'utf8')

  const formKindUnion = readUnion(rendererSrc, 'FormKind', 'types.ts')
  const formKinds = readArray(rendererSrc, 'FORM_KINDS', 'types.ts')
  const registry = readObject(rendererSrc, 'FORM_REGISTRY', 'types.ts')
  const specs = readObject(mainSrc, 'FORM_SPECS', 'Lifecycle.ts')

  // vite：只在 renderer 块内找 html 入口（worker 入口是 .ts，不参与形态注册）
  const rendererBlockStart = viteSrc.search(/\brenderer\s*:\s*\{/)
  if (rendererBlockStart === -1) throw new Error('electron.vite.config.ts: 找不到 renderer 配置块')
  const rendererBlock = viteSrc.slice(rendererBlockStart)
  const viteInput = {}
  const inputRe = /(\w+)\s*:\s*resolve\(\s*__dirname\s*,\s*(['"])([^'"]+)\2\s*\)/g
  for (const m of rendererBlock.matchAll(inputRe)) {
    if (m[3].endsWith('.html')) viteInput[m[1]] = path.basename(m[3])
  }

  return { formKindUnion, formKinds, registry, specs, viteInput }
}

// ─────────────────────────── 比对 ───────────────────────────

const FLAGS = ['frame', 'transparent', 'alwaysOnTop', 'skipTaskbar', 'resizable', 'fullscreen']

function pairsEqual(a, b) {
  if (!a || !b) return a === b
  return a.width === b.width && a.height === b.height
}

function compare(data) {
  const problems = []
  const { formKindUnion, formKinds, registry, specs, viteInput } = data

  // 防空转：解析失配会让下面所有「集合相等」判断在空集上空转成绿。
  // 门禁假绿比没有门禁更危险，所以先确认每处都真的读到了东西。
  if (!formKindUnion.length) problems.push('types.ts 未解析出 FormKind 联合成员（解析失配？）')
  if (!formKinds.length) problems.push('types.ts 未解析出 FORM_KINDS（解析失配？）')
  if (!Object.keys(registry).length) problems.push('types.ts 未解析出 FORM_REGISTRY 条目（解析失配？）')
  if (!Object.keys(specs).length) problems.push('Lifecycle.ts 未解析出 FORM_SPECS 条目（解析失配？）')
  if (!Object.keys(viteInput).length) {
    problems.push('electron.vite.config.ts 未解析出 renderer html 入口（解析失配？）')
  }
  if (problems.length) return problems

  const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join()

  // 1. 形态集合三处一致（含 FormKind 联合类型）
  if (!sameSet(formKindUnion, formKinds)) {
    problems.push(`types.ts 内部不一致：FormKind 联合 = [${formKindUnion}]，FORM_KINDS = [${formKinds}]`)
  }
  const registryKinds = Object.keys(registry)
  if (!sameSet(formKinds, registryKinds)) {
    problems.push(`types.ts 内部不一致：FORM_KINDS = [${formKinds}]，FORM_REGISTRY 键 = [${registryKinds}]`)
  }
  const specKinds = Object.keys(specs)
  if (!sameSet(formKinds, specKinds)) {
    problems.push(`形态集合漂移：types.ts FORM_KINDS = [${formKinds}]，Lifecycle.ts FORM_SPECS 键 = [${specKinds}]`)
  }
  const viteHtmlKeys = Object.keys(viteInput)
  const missingInVite = formKinds.filter((k) => !viteHtmlKeys.includes(k))
  if (missingInVite.length) {
    problems.push(
      `electron.vite.config.ts 的 renderer input 缺少形态入口：[${missingInVite}]` +
        `（现有 html 入口 [${viteHtmlKeys}]）—— 运行期该形态窗口会加载到不存在的文件而空白`,
    )
  }
  const extraInVite = viteHtmlKeys.filter((k) => !formKinds.includes(k) && k !== 'index' && k !== 'agent')
  if (extraInVite.length) {
    problems.push(`electron.vite.config.ts 有未注册为形态的 html 入口：[${extraInVite}]`)
  }

  for (const kind of formKinds) {
    const r = registry[kind]
    const s = specs[kind]
    if (!r || !s) continue

    if (r.htmlFile !== s.htmlFile) {
      problems.push(`${kind}: htmlFile 不一致 —— types.ts '${r.htmlFile}' vs Lifecycle.ts '${s.htmlFile}'`)
    }
    if (viteInput[kind] && viteInput[kind] !== r.htmlFile) {
      problems.push(`${kind}: vite 入口文件名 '${viteInput[kind]}' 与注册表 htmlFile '${r.htmlFile}' 不一致`)
    }
    if (r.htmlFile && !fs.existsSync(path.join(repo, 'src', 'renderer', r.htmlFile))) {
      problems.push(`${kind}: 注册的 htmlFile '${r.htmlFile}' 在 src/renderer/ 下不存在`)
    }

    if (!pairsEqual(r.size, s.size)) {
      problems.push(`${kind}: size 不一致 —— types.ts ${JSON.stringify(r.size)} vs Lifecycle.ts ${JSON.stringify(s.size)}`)
    }
    if (Boolean(r.minSize) !== Boolean(s.minSize)) {
      problems.push(`${kind}: minSize 有无不一致 —— types.ts ${JSON.stringify(r.minSize)} vs Lifecycle.ts ${JSON.stringify(s.minSize)}`)
    } else if (r.minSize && !pairsEqual(r.minSize, s.minSize)) {
      problems.push(`${kind}: minSize 不一致 —— types.ts ${JSON.stringify(r.minSize)} vs Lifecycle.ts ${JSON.stringify(s.minSize)}`)
    }

    for (const flag of FLAGS) {
      if (r[flag] !== s[flag]) {
        problems.push(`${kind}: ${flag} 不一致 —— types.ts ${r[flag]} vs Lifecycle.ts ${s[flag]}`)
      }
    }

    // 反义字段：渲染侧 acceptsMouseEvents 与主进程 ignoreMouseEvents 必须互为取反
    if (r.acceptsMouseEvents === s.ignoreMouseEvents) {
      problems.push(
        `${kind}: acceptsMouseEvents 与 ignoreMouseEvents 必须互为取反，` + `现在两边都是 ${r.acceptsMouseEvents}（鼠标穿透会与预期相反）`,
      )
    }

    if (r.alwaysOnTopLevel !== s.alwaysOnTopLevel) {
      problems.push(`${kind}: alwaysOnTopLevel 不一致 —— types.ts ${r.alwaysOnTopLevel} vs Lifecycle.ts ${s.alwaysOnTopLevel}`)
    }
  }

  return problems
}

// ─────────────────────────── 入口 ───────────────────────────

function main() {
  const data = collect()
  const problems = compare(data)

  console.log('形态注册表一致性检查（三处静态源）')
  for (const [label, file] of Object.entries(SOURCES)) {
    console.log(`  ${label.padEnd(9)}: ${path.relative(repo, file).replace(/\\/g, '/')}`)
  }
  console.log(`  形态       : ${data.formKinds.join(', ')}`)
  for (const kind of data.formKinds) {
    const r = data.registry[kind] || {}
    console.log(
      `    - ${kind.padEnd(10)} html=${r.htmlFile} size=${r.size ? `${r.size.width}x${r.size.height}` : '?'}` +
        ` vite=${data.viteInput[kind] || '(缺失)'}`,
    )
  }

  if (!problems.length) {
    console.log('\n✓ 三处一致')
    return 0
  }

  console.log(`\n❌ 发现 ${problems.length} 处不一致：`)
  for (const p of problems) console.log(`  - ${p}`)
  console.log('\n这些不一致不会让构建/typecheck/lint 报错，只会在运行期表现为窗口空白。')
  return 1
}

module.exports = { collect, compare, main, SOURCES }

if (require.main === module) {
  try {
    process.exit(main())
  } catch (e) {
    console.error('检查脚本自身出错:', e.message)
    process.exit(1)
  }
}
