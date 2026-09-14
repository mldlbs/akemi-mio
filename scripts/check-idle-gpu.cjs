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
const { spawn } = require('child_process')
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

const child = spawn(EXE, ['--remote-debugging-port=' + PORT], {
  env,
  cwd: path.dirname(EXE),
  stdio: 'ignore',
})
let killed = false
function shutdown(code) {
  if (!killed) {
    killed = true
    try { process.kill(child.pid) } catch {}
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
  const page =
    list.filter((t) => t.type === 'page').find((t) => String(t.url).includes('index.html')) ||
    list.filter((t) => t.type === 'page')[0]
  if (!page) {
    console.error('[idle-gpu] 找不到页面目标。')
    return 2
  }
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

  if (fails.length) {
    console.log('')
    console.log('  ✗ 未通过：')
    for (const f of fails) console.log(`    - ${f}`)
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
