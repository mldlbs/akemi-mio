#!/usr/bin/env node
'use strict'
/**
 * 空闲 GPU 预算检查 —— 防止"应用啥也不干却常驻吃满一个核"回归。
 *
 * 起因：一次排查壁纸开销时顺手量了空闲基线，发现 GPU 进程稳定 120%+ 且
 * 65 秒不衰减。逐层定位到 .btn-voice / .btn-inspiration 上一条 5.5s 的
 * 无限微光动画（atelier-control-glint）。2x2 分解显示：
 *
 *   基线（动画开+毛玻璃开）  GPU 126%
 *   只关全站 backdrop-filter GPU  52%   ← 毛玻璃只是放大器
 *   只关动画                 GPU   0%   ← 动画才是主因
 *
 * 这类回归极容易重犯：任何人再加一条没有状态语义的 infinite 动画就会复发，
 * 而它不会让任何单元测试变红。所以把这个测量固化成可挂 CI 的检查。
 *
 * 判据刻意用"A/B 差值"而不是绝对 GPU 占用：
 *   关掉全部 CSS 动画前后的 GPU 差值 ≈ 0，说明没有常驻动画在烧 GPU。
 *   只看绝对值会被机器噪声、别的进程干扰；差值直接对准我们要防的那类问题。
 *
 * 用法：
 *   node scripts/check-idle-gpu.cjs [--exe=路径] [--warmup=45] [--samples=3]
 *                                   [--interval=8] [--gpu-budget=20] [--delta-budget=15]
 *   npm run check:idle-gpu
 *
 * 退出码：0 = 通过；1 = 超预算；2 = 运行失败（起不来/连不上）。
 */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const repo = path.resolve(__dirname, '..')

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const flag = (name) => process.argv.includes(`--${name}`)

const EXE = arg('exe', '') || findExe()
const PORT = Number(arg('port', 9340))
const WARMUP_SEC = Number(arg('warmup', 45))
const SAMPLES = Number(arg('samples', 3))
const INTERVAL_SEC = Number(arg('interval', 8))
const GPU_BUDGET = Number(arg('gpu-budget', 20))       // 空闲 GPU 上限（%）
const DELTA_BUDGET = Number(arg('delta-budget', 15))   // A/B 差值上限（百分点）
const SKIP_AB = flag('no-ab')

// GitHub Actions 注解。公开仓的 job 日志要管理员权限才能读，只有 check-run
// annotation 无认证可读 —— 所以「想让以后能标定的数字」必须离开日志、变成注解。
//   - 实测数字在**每次**运行都发一条 ::notice::（通过与失败都发）：
//     --gpu-budget / --delta-budget 的默认值 20/15 是在有真 GPU 的开发机上量出来的，
//     和软件光栅化的 runner 不可比，而重标定唯一的依据就是这几个数字；
//   - 失败时额外发 ::error::，这样红的那次能直接说清「谁超了哪个预算」，
//     不需要日志权限。
// 门禁语义不变：只加输出，不动判据。
const inActions = process.env.GITHUB_ACTIONS === 'true'
// workflow-command 格式里 `%` 必须转义，否则含 `20%` 的一行会把注解弄坏。
// ⚠️ 顺序要紧：先转义 `%`，再处理 \r\n —— 反过来的话刚插入的 `%0D` 会被二次转义成 `%250D`。
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
const notice = (s) => { if (inActions) console.log(`::notice::${esc(s)}`) }
const annErr = (s) => { if (inActions) console.log(`::error::${esc(s)}`) }

// ── 定位 exe ────────────────────────────────────────────────────────────
// 优先标准的 dist-electron；没有的话退到 dist-electron-pkg* 里挑最新的。
function findExe() {
  const std = path.join(repo, 'dist-electron', 'win-unpacked', 'AkemiMio.exe')
  if (fs.existsSync(std)) return std
  const cands = []
  for (const e of fs.readdirSync(repo, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.startsWith('dist-electron-pkg')) continue
    const p = path.join(repo, e.name, 'win-unpacked', 'AkemiMio.exe')
    if (fs.existsSync(p)) cands.push({ p, m: fs.statSync(p).mtimeMs })
  }
  if (!cands.length) return ''
  cands.sort((a, b) => b.m - a.m)
  return cands[0].p
}

// userData 目录：DevToolsActivePort 写在这里。APPDATA 在 Git Bash 下可能为空。
function userDataDir() {
  if (process.env.APPDATA) return path.join(process.env.APPDATA, 'akemi-mio')
  return path.join(os.homedir(), 'AppData', 'Roaming', 'akemi-mio')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

if (!EXE || !fs.existsSync(EXE)) {
  console.error('[idle-gpu] 找不到打包后的 AkemiMio.exe。')
  console.error('  先跑 `npm run build && npx electron-builder --win --dir`，')
  console.error('  或用 --exe=<绝对路径> 指定。')
  process.exit(2)
}

const env = { ...process.env }
// 否则 Electron 会把自己当成 node 来跑，根本不启动窗口
delete env.ELECTRON_RUN_AS_NODE

// DevToolsActivePort 是上一轮的残留文件，不挪走会读到旧端口、连到僵尸进程
const portFile = path.join(userDataDir(), 'DevToolsActivePort')
try {
  if (fs.existsSync(portFile)) fs.renameSync(portFile, portFile + '.prev')
} catch {}

console.log(`[idle-gpu] exe      ${EXE}`)
console.log(`[idle-gpu] 预热 ${WARMUP_SEC}s，随后采 ${SAMPLES} 次 × ${INTERVAL_SEC}s`)

// spawn 失败有两条路，两条都得走 2（运行失败）而不是 1（超预算）：
//   同步抛（EFTYPE 等，exe 存在但不可执行）+ 异步 'error' 事件（ENOENT 等，
//   后者在 EventEmitter 上没人监听时也会直接抛）。
// 不区分的话 CI 红会被误读成「GPU 回归」，实际是「应用根本没起来」。
let child
try {
  child = spawn(EXE, ['--remote-debugging-port=' + PORT], {
    env,
    cwd: path.dirname(EXE),
    stdio: 'ignore',
  })
} catch (e) {
  console.error(`[idle-gpu] 起不来：${e.code || e.message}`)
  process.exit(2)
}
child.on('error', (e) => {
  console.error(`[idle-gpu] 起不来：${e.code || e.message}`)
  process.exit(2)
})

let killed = false
function shutdown(code) {
  if (!killed) {
    killed = true
    // ⚠️ 按**进程树**杀。Electron 会再拉一个 MCP 子进程（node.exe，监听 1841），
    // `process.kill(child.pid)` 只结束主进程 → 孤儿占着 1841。
    // 实测：1841 上有孤儿时，下一次运行以 `EXIT=2` 失败（先 WebSocket `non-101`，
    // 再跑一次变成 `/json/list` 一直不响应）；把 1841 上的孤儿杀掉后即可恢复。
    // ⚠️ 局限（同样实测）：`taskkill /T` 只在**主进程还活着**时才管用。主进程若已
    // 自己退出（`non-101` 那次就是），孙子进程会被 reparent 而逃掉 → 失败路径上
    // 仍可能留孤儿，需要人工 `netstat -ano | grep :1841` 清一下。
    // CI 的 runner 是一次性的，不受影响；这是本地反复跑才会踩的坑。
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        process.kill(child.pid)
      }
    } catch {}
  }
  setTimeout(() => process.exit(code), 1200)
}

async function waitPort() {
  for (let i = 0; i < 120; i++) {
    try {
      return await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()
    } catch {
      await sleep(500)
    }
  }
  return null
}
async function getList() {
  for (let i = 0; i < 60; i++) {
    try {
      return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    } catch {
      await sleep(500)
    }
  }
  return null
}

const KILL_ANIM = `(function(){let s=document.getElementById('__mio_idle_gpu_kill');
if(!s){s=document.createElement('style');s.id='__mio_idle_gpu_kill';document.head.appendChild(s)}
s.textContent='*,*::before,*::after{animation:none !important}';return 'on'})()`
const RESTORE_ANIM = `(function(){const s=document.getElementById('__mio_idle_gpu_kill');if(s)s.remove();return 'off'})()`
const ANIM_EXPR = `JSON.stringify(document.getAnimations().map((a) => ({
  name: a.animationName || '(?)',
  state: a.playState,
  tag: a.effect && a.effect.target ? a.effect.target.tagName : null,
  cls: a.effect && a.effect.target ? String(a.effect.target.className || '').slice(0, 40) : null,
})))`

async function main() {
  const ver = await waitPort()
  if (!ver) {
    console.error('[idle-gpu] 连不上调试端口，放弃。')
    return 2
  }

  // 浏览器级连接：SystemInfo.getProcessInfo 只在浏览器端点上有
  const bws = new WebSocket(ver.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    bws.addEventListener('open', res)
    bws.addEventListener('error', rej)
  })
  const bcall = async (method, params, waitMs = 3000) => {
    const id = Math.floor(Math.random() * 1e6)
    let out = null
    const h = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id === id) out = m
    }
    bws.addEventListener('message', h)
    bws.send(JSON.stringify({ id, method, params: params || {} }))
    await sleep(waitMs)
    bws.removeEventListener('message', h)
    return out
  }
  const snap = async () => {
    const r = await bcall('SystemInfo.getProcessInfo', {}, 3000)
    const m = new Map()
    for (const p of r?.result?.processInfo || []) {
      m.set(String(p.id), { type: p.type, cpu: p.cpuTime ?? 0 })
    }
    return m
  }

  const list = await getList()
  if (!list) {
    // 区分「应用起不来」和「应用起来了但页面目标等不到」。后者最典型的原因是
    // 端口 1841 被上一次运行留下的 MCP 孤儿占着（见 shutdown 的注释）——
    // 打包 exe 的 MCP 子进程起不来，页面就一直不出现。
    console.error('[idle-gpu] /json/list 一直没响应（但 /json/version 通了）。')
    console.error('  最可能：上一次运行留下的 MCP 孤儿占着 1841，导致这次 MCP 起不来。')
    console.error('  查一下 `netstat -ano | grep :1841`，把占用者杀掉再重跑。')
    console.error(`  （另注：开发实例与打包 exe 共用 userData ${userDataDir()}）`)
    return 2
  }
  const page =
    list.filter((t) => t.type === 'page').find((t) => String(t.url).includes('index.html')) ||
    list.filter((t) => t.type === 'page')[0]
  if (!page) {
    console.error('[idle-gpu] 找不到页面目标。')
    return 2
  }
  // 把「到底量了哪个页面」打出来。否则「0 动画 + 0% CPU」这种结果分不清是
  // 「真的空闲」还是「量到了一个空窗口」—— 后者会让这道门禁变成永远绿。
  // 多窗口形态（pet / chat / wallpaper / agent）下这个选择是隐式的，必须可见。
  const pageTargets = list.filter((t) => t.type === 'page')
  const pageTag = `${page.title || '(无标题)'} ${String(page.url).split('/').pop()}`
  console.log(`[idle-gpu] 页面      ${pageTag}`)
  console.log(
    `[idle-gpu] 页面目标  ${pageTargets.length} 个：` +
      pageTargets.map((t) => String(t.url).split('/').pop()).join(', '),
  )
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  const ev = async (expr, waitMs = 2500) => {
    const id = Math.floor(Math.random() * 1e6)
    let out = null
    const h = (m) => {
      const j = JSON.parse(m.data)
      if (j.id === id) out = j
    }
    ws.addEventListener('message', h)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }))
    await sleep(waitMs)
    ws.removeEventListener('message', h)
    return out?.result?.result?.value
  }

  // 每次采样都取两个快照做差；只统计两次都存在的进程，避免新进程拉低分母
  async function phase(tag) {
    const gpus = []
    const totals = []
    for (let i = 0; i < SAMPLES; i++) {
      const a = await snap()
      await sleep(INTERVAL_SEC * 1000)
      const b = await snap()
      let gpu = 0
      let total = 0
      for (const [id, p] of b) {
        const prev = a.get(id)
        if (!prev) continue
        const d = p.cpu - prev.cpu
        total += d
        if (p.type === 'GPU') gpu += d
      }
      gpus.push((gpu / INTERVAL_SEC) * 100)
      totals.push((total / INTERVAL_SEC) * 100)
    }
    let anims = []
    try {
      anims = JSON.parse(await ev(ANIM_EXPR))
    } catch {}
    const running = anims.filter((a) => a.state === 'running')
    const g = median(gpus)
    const t = median(totals)
    console.log(
      `  [${tag}] GPU ${g.toFixed(1)}%  总 CPU ${t.toFixed(1)}%  ` +
        `运行中动画 ${running.length}/${anims.length}` +
        (running.length
          ? '：' + running.map((a) => `${a.name} <${a.tag}> .${a.cls}`).join(' | ')
          : ''),
    )
    return { gpu: g, total: t, running }
  }

  console.log(`[idle-gpu] 预热中（跳过启动期抖动）...`)
  await sleep(WARMUP_SEC * 1000)

  const base = await phase('基线')
  let ab = null
  if (!SKIP_AB) {
    await ev(KILL_ANIM)
    await sleep(2500)
    ab = await phase('关动画')
    await ev(RESTORE_ANIM)
    await sleep(2500)
    await phase('恢复')
  }

  const delta = ab ? base.gpu - ab.gpu : 0
  console.log('')
  console.log(`  基线 GPU        ${base.gpu.toFixed(1)}%   预算 ${GPU_BUDGET}%`)
  if (ab) {
    console.log(`  关动画 GPU      ${ab.gpu.toFixed(1)}%`)
    console.log(`  A/B 差值        ${delta.toFixed(1)} 个点   预算 ${DELTA_BUDGET} 个点`)
  }

  const fails = []
  if (base.gpu > GPU_BUDGET) {
    fails.push(`空闲 GPU ${base.gpu.toFixed(1)}% 超预算 ${GPU_BUDGET}%`)
  }
  if (ab && delta > DELTA_BUDGET) {
    fails.push(
      `A/B 差值 ${delta.toFixed(1)} 个点超预算 ${DELTA_BUDGET} —— 很可能有常驻无限动画在烧 GPU`,
    )
  }

  // 标定数据：每次运行都发（通过与失败都发）。没有这几个数字就没法把
  // --gpu-budget / --delta-budget 从「开发机上的值」标定成「CI 上的值」。
  notice(
    `[idle-gpu] 页面 ${pageTag}` +
      ` / 基线 GPU ${base.gpu.toFixed(1)}%（预算 ${GPU_BUDGET}%）` +
      (ab
        ? ` / 关动画 ${ab.gpu.toFixed(1)}% / A-B 差值 ${delta.toFixed(1)} 个点（预算 ${DELTA_BUDGET}）`
        : ' / A-B 已跳过') +
      ` / 基线总 CPU ${base.total.toFixed(1)}% / 基线运行中动画 ${base.running.length}`,
  )
  // A/B 只在「基线本来就有动画可关」时才带信息量。基线 0 个运行中动画时，
  // 差值为 0 是**必然**的 —— 这次绿其实只靠绝对预算那一条，得说清楚，
  // 否则会把一次没有信息量的通过读成「A/B 这条承重断言也验过了」。
  if (ab && base.running.length === 0) {
    notice(
      '[idle-gpu] A/B 本次无信息量：基线就没有运行中动画，差值为 0 是必然的' +
        '（本次判定只由绝对预算那条承担）',
    )
  }

  if (fails.length) {
    console.log('')
    console.log('  ✗ 未通过：')
    for (const f of fails) {
      console.log(`    - ${f}`)
      annErr(`[idle-gpu] ${f}`)
    }
    if (base.running.length) {
      console.log('    当前默认就在跑的动画：')
      for (const a of base.running) {
        console.log(`      ${a.name} <${a.tag}> .${a.cls}`)
      }
      console.log('    给它加上 :hover / .active 之类的条件，或改成静态。')
    }
    return 1
  }
  console.log('')
  console.log('  ✓ 通过：空闲时没有常驻动画在烧 GPU')
  return 0
}

setTimeout(async () => {
  let code = 0
  try {
    code = await main()
  } catch (e) {
    console.error('[idle-gpu] 异常:', e.message)
    code = 2
  }
  shutdown(code)
}, 500)
