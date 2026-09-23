// Prettier 格式门禁。用法：node scripts/format-check.mjs
//
// 退出码：0 = 全部合规 / 1 = 有文件未格式化 / 2 = prettier 本身跑不起来
// （与 scripts/check-idle-gpu.cjs 同一套口径：把「工具坏了」和「检查没过」分开，
//   否则 CI 红会被误读成「有人提交了未格式化的代码」，实际是门禁自己没起来。）
//
// 2026-09-22：原来这里直接跑 `prettier --check`。prettier 把「哪个文件不合规」
// 打到 stderr，而 CI 的 job 日志要管理员权限才能下载（实测 403）→ 失败时页面上
// 只剩一句「Process completed with exit code 1」，不知道是哪个文件。这里把每个
// 文件转成 ::error:: 注解，run 页面直接可见。做法同 scripts/typecheck-budget.mjs。
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)

// 2026-09-23：扩围到 scripts/（此前只查 src/，23 个门禁脚本自身的格式漂移
// 从未被守）。_archive/ 是归档目录（含大量故意保留的历史脚本），豁免。
const GLOBS = ['src/**/*.{ts,tsx,json,css}', 'scripts/**/*.{js,mjs,cjs}', '!scripts/_archive/**']
const GLOB_LABEL = GLOBS.join(' ')
const MAX_DETAIL = 50
const inActions = process.env.GITHUB_ACTIONS === 'true'

// 解析 prettier 的 CLI 入口，不走 node_modules/.bin 的 shim：Windows 上那是
// .CMD，spawn 必须 shell:true；且本仓 node_modules 是 pnpm 布局（.bin 是软链）。
function prettierBin() {
  const pkgPath = require.resolve('prettier/package.json')
  const pkg = require(pkgPath)
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.prettier
  return path.join(path.dirname(pkgPath), bin)
}

// 非 TTY 下 prettier 一般不着色，但本地/CI 都别赌这个。
const stripAnsi = (s) => s.replace(/\u001B\[[0-9;]*m/g, '')

// prettier 的 --check 会为每个不合规文件打一行 `[warn] <相对路径>`，
// 末尾再打一行汇总。只留文件行 —— 用汇总行的固定开头排除，别用「像不像路径」
// 这种会误判的启发式。
const NOT_A_FILE = /^\[warn\] (Code style issues|Ignored unknown option|No parser could be inferred|Explicitly specified)/

let stdout = ''
let stderr = ''
let status = 0
try {
  stdout = execFileSync(process.execPath, [prettierBin(), '--check', ...GLOBS], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
} catch (err) {
  if (typeof err.status !== 'number') {
    // 起不来（找不到 prettier、被拦、超时等）——不是「格式不合规」。
    console.error(`[format] prettier 起不来：${err.code || err.message}`)
    process.exit(2)
  }
  status = err.status
  stdout = String(err.stdout || '')
  stderr = String(err.stderr || '')
}

process.stdout.write(stripAnsi(stdout))

if (status === 0) {
  console.log('PASS: format clean.')
  process.exit(0)
}

const lines = [stderr, stdout]
  .flatMap((s) => stripAnsi(s).split(/\r?\n/))
  .filter((l) => l.startsWith('[warn] ') && !NOT_A_FILE.test(l))
  .map((l) => l.slice('[warn] '.length).trim())
  .filter(Boolean)

if (status !== 1 || lines.length === 0) {
  // 非 1 的退出码 = prettier 自己出错（比如语法错误让它无法解析）。原样透出，
  // 但用 2 表示「门禁没跑成」，别和「有文件不合规」混在一起。
  console.error(stripAnsi(stderr).trim() || `[format] prettier 以退出码 ${status} 结束，但没有给出文件清单`)
  process.exit(2)
}

console.error(`--- prettier --check ${GLOB_LABEL} (${lines.length} 个文件未格式化) ---`)
for (const file of lines.slice(0, MAX_DETAIL)) {
  console.error(inActions ? `::error::${file} 未按 Prettier 格式化` : `${file} 未按 Prettier 格式化`)
}
if (lines.length > MAX_DETAIL) {
  console.error(`  ... 其余 ${lines.length - MAX_DETAIL} 个已省略`)
}
console.error(`FAIL: ${lines.length} 个文件未格式化。用 \`npx prettier --write <file>\` 修复后重跑。`)
process.exit(1)
