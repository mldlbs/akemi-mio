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
// 仪器自检的**下限**：注入的重负载动画必须把 GPU 顶起来这么多，否则判「仪器失灵」。
//
// ⚠️ 这个值是**下限**而且刻意压得很低，因为它的用途不是性能门槛，
// 只是要把「仪器死了（≈0）」和「仪器活着（≈147）」分开 —— 中间隔了三个数量级。
// 标定数据（CI runner，四笔 run）：147.3 / 147.2 / 146.9 / 147.6，极差 0.7 个点；
// 本机 headless Edge 夹具：43.3 / 19.9（本机有别的进程在抢资源，波动大得多）。
// 取 5 对 CI 有约 29 倍余量，对波动最大的本机也有约 4 倍余量。
const SELFCHECK_MIN = Number(arg('selfcheck-min', 5))  // 自检差值下限（百分点）
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
// 进程类型直方图 → 一行可读文本（注解里用）。
const fmtProcTypes = (t) =>
  Object.entries(t || {})
    .map(([k, v]) => `${k}x${v}`)
    .join(' ') || '(无)'

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
// ── 仪器自检 ──────────────────────────────────────────────────────────
// 两条判据（绝对 GPU 预算、A/B 差值）都建立在同一个前提上：
// **CSS 动画会体现在 GPU 进程的 CPU 时间上**。
//
// 而这个前提在 CI 上从来没被验证过：健康状态下应用一个常驻动画都没有
// （atelier-control-glint 已在 80c530e 移除），于是基线差值必然是 0，
// 「A/B 到底能不能红」在 runner 上永远是未测状态。如果哪天 GPU 计数在这台
// runner 上失灵（纯软件渲染、压根没有 GPU 类型进程…），门禁会**永久绿** ——
// 而它本该抓的那类回归正好从它眼皮下溜过去。
//
// 所以注入一条**确定无疑**的重负载动画（全视口 + 每帧重绘 + filter），
// 看它能不能把 GPU 顶起来。
//
// v1 只报数不判红（阈值没有标定数据，一上来就判红就是 FM-8 的制造机）；
// v2 起判红，因为 v1 已经把标定数据收上来了：CI 四笔 147.3 / 147.2 / 146.9 / 147.6
// （极差 0.7），本机两次 43.3 / 19.9（本机有别的实例在抢资源）。
// 下限取 5 ⇒ CI 上有约 29 倍余量，本机最差那次也有 4 倍。
//
// 挂到 documentElement 而不是 body：应用里 body 下可能有 transform 祖先，
// 那会让 position:fixed 退化成相对该祖先定位，注入物可能只有 0 面积。
const SELFCHECK_ON = `(function(){
  var s=document.getElementById('__mio_idle_gpu_selfcheck_style');
  if(!s){
    s=document.createElement('style');s.id='__mio_idle_gpu_selfcheck_style';
    s.textContent='@keyframes __mio_sc_spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}'+
      '@keyframes __mio_sc_hue{from{filter:hue-rotate(0deg)}to{filter:hue-rotate(360deg)}}';
    document.head.appendChild(s);
  }
  var d=document.getElementById('__mio_idle_gpu_selfcheck');
  if(!d){
    d=document.createElement('div');d.id='__mio_idle_gpu_selfcheck';
    d.style.cssText='position:fixed;inset:0;z-index:2147483647;pointer-events:none;'+
      'background:linear-gradient(45deg,#f00,#0f0,#00f);'+
      'animation:__mio_sc_spin 1.2s linear infinite,__mio_sc_hue 2s linear infinite';
    document.documentElement.appendChild(d);
  }
  return 'on'})()`

// 返回清理后的残留状态，期望值恰好是 SELFCHECK_CLEAN。
//
// ⚠️ 这里**不能只数动画条数**。变异检验实测：故意留下注入的元素、只删掉 keyframes
// 那一段 style，动画名就解析不到了，`getAnimations()` 归零 —— 于是「元素还挂在页面上」
// 会被报成「清理干净」。所以元素与 style 都要单独查。
// 三样都查的理由：动画在烧 GPU、元素在占合成层、style 在改全局样式，任一残留都会
// 让后面的数字变脏，而它们互相之间并不同步消失。
const SELFCHECK_OFF = `(function(){
  var d=document.getElementById('__mio_idle_gpu_selfcheck');
  var s=document.getElementById('__mio_idle_gpu_selfcheck_style');
  if(d)d.remove(); if(s)s.remove();
  var left=document.getAnimations().filter(function(a){
    return String(a.animationName||'').indexOf('__mio_sc_')===0}).length;
  var leftEl=document.getElementById('__mio_idle_gpu_selfcheck')?1:0;
  var leftStyle=document.getElementById('__mio_idle_gpu_selfcheck_style')?1:0;
  return String(left)+'|el'+leftEl+'|style'+leftStyle})()`

/** 清理成功时的期望值（与上面的拼接格式逐字对应）。 */
const SELFCHECK_CLEAN = '0|el0|style0'

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
  // url 以 `/` 结尾时 basename 是空串，清单里会出现读不懂的空条目 —— 回退到标题。
  const pageName = (t) => String(t.url).split('/').pop() || t.title || '(?)'
  const pageTag = `${page.title || '(无标题)'} ${pageName(page)}`
  console.log(`[idle-gpu] 页面      ${pageTag}`)
  console.log(
    `[idle-gpu] 页面目标  ${pageTargets.length} 个：` +
      pageTargets.map(pageName).join(', '),
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
    let last = null
    for (let i = 0; i < SAMPLES; i++) {
      const a = await snap()
      await sleep(INTERVAL_SEC * 1000)
      const b = await snap()
      last = b
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
    // 进程类型直方图。CI 上「GPU 0.0%」有两种完全不同的解释 —— 真的空闲，
    // 或者压根没有 GPU 类型的进程可量（纯软件渲染）。这个直方图能把它们分开：
    // 没有 `GPU` 这一项时，绝对预算与 A/B 两条判据都**永远不会触发**。
    const procTypes = {}
    for (const [, p] of last || []) procTypes[p.type] = (procTypes[p.type] || 0) + 1
    // 动画探测。必须把「探测失败」和「真的是 0 个」分开：
    // 两者的 anims.length 都是 0，但对后者说「这个页面没有动画」是假话，
    // 而下面的 notice 正是要断言这句话。
    let anims = null
    try {
      const raw = await ev(ANIM_EXPR)
      const parsed = raw == null ? null : JSON.parse(raw)
      if (Array.isArray(parsed)) anims = parsed
    } catch {}
    const animProbeOk = anims !== null
    const animList = anims || []
    const running = animList.filter((a) => a.state === 'running')
    const g = median(gpus)
    const t = median(totals)
    console.log(
      `  [${tag}] GPU ${g.toFixed(1)}%  总 CPU ${t.toFixed(1)}%  ` +
        (animProbeOk ? `动画 ${running.length}/${animList.length}` : `动画 探测失败`) +
        (running.length
          ? '：' + running.map((a) => `${a.name} <${a.tag}> .${a.cls}`).join(' | ')
          : ''),
    )
    return {
      gpu: g,
      total: t,
      running,
      animCount: animList.length,
      animProbeOk,
      procTypes,
      gpuProcs: procTypes.GPU || 0,
    }
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

  // 仪器自检（见 SELFCHECK_ON 上方的注释）。⚠️ 只报数、**不参与 fails** ——
  // 阈值还没有标定数据，先跑几轮把这个数字收上来，再决定它该不该判红。
  // 一个一上来就判红、而阈值又是拍脑袋定的自检，就是 FM-8（抖动红）的制造机。
  let sc = null
  let scLeft = null
  if (!SKIP_AB) {
    await ev(SELFCHECK_ON)
    await sleep(2500)
    sc = await phase('自检')
    scLeft = await ev(SELFCHECK_OFF)
    await sleep(1500)
  }

  const delta = ab ? base.gpu - ab.gpu : 0
  // 自检差值以「关动画」那一段为参照：注入动画 vs 一个动画都没有。
  const scDelta = sc && ab ? sc.gpu - ab.gpu : null
  console.log('')
  console.log(`  基线 GPU        ${base.gpu.toFixed(1)}%   预算 ${GPU_BUDGET}%`)
  if (ab) {
    console.log(`  关动画 GPU      ${ab.gpu.toFixed(1)}%`)
    console.log(`  A/B 差值        ${delta.toFixed(1)} 个点   预算 ${DELTA_BUDGET} 个点`)
  }
  if (sc) {
    console.log(`  自检 GPU        ${sc.gpu.toFixed(1)}%（注入全视口合成动画后）`)
    console.log(
      `  自检 差值       ${scDelta === null ? '(无参照)' : scDelta.toFixed(1) + ' 个点'}` +
        `（对照「关动画」，下限 ${SELFCHECK_MIN}）  清理后残留 ${scLeft}（期望 ${SELFCHECK_CLEAN}）`,
    )
  }
  console.log(`  进程类型        ${fmtProcTypes(base.procTypes)}`)

  const fails = []
  if (base.gpu > GPU_BUDGET) {
    fails.push(`空闲 GPU ${base.gpu.toFixed(1)}% 超预算 ${GPU_BUDGET}%`)
  }
  if (ab && delta > DELTA_BUDGET) {
    fails.push(
      `A/B 差值 ${delta.toFixed(1)} 个点超预算 ${DELTA_BUDGET} —— 很可能有常驻无限动画在烧 GPU`,
    )
  }
  // 仪器自检判红。两条都要判，理由不同：
  //   (a) 注入没生效 → 完全没有证据 → 本次的「绿」不可信；
  //   (b) 注入生效但 GPU 不响应 → 两条判据都不会触发 → 同上。
  // ⚠️ **只判 (b) 是不够的**：那样只要注入代码一坏，`自检动画 0/0` 会让自检变成装饰，
  // 而「注入坏了」本身没有任何后果 —— 这正是 FM-6（能跑但不可能红）的形状。
  // 「清理不干净」则**不**判红：清理发生在所有测量之后，不影响任何数字的可信度，
  // 它只是本脚本自身的缺陷信号，保持 notice 就够了（判红会白添一条抖动来源）。
  if (sc) {
    // ⚠️ 用 `running` 而不是 `animCount`：动画存在但处于 paused 时同样造不出 GPU 负载，
    // 同样是「没有证据」，而 animCount 会把它错报成「注入生效了」。
    if (sc.running.length === 0) {
      fails.push(
        '仪器自检无效：注入的合成动画没有在运行，本次没有任何证据说明这条测量链是好的',
      )
    } else if (scDelta === null || scDelta < SELFCHECK_MIN) {
      fails.push(
        `仪器自检失败：注入重负载动画后 GPU 差值仅 ${
          scDelta === null ? '(无参照)' : scDelta.toFixed(1)
        } 个点，低于下限 ${SELFCHECK_MIN} —— 「动画 → GPU 进程 CPU」这条链在这台机器上` +
          '没有响应，绝对预算与 A/B 两条判据都不会触发，本次的绿是空绿',
      )
    }
  }

  // 标定数据：每次运行都发（通过与失败都发）。没有这几个数字就没法把
  // --gpu-budget / --delta-budget 从「开发机上的值」标定成「CI 上的值」。
  notice(
    `[idle-gpu] 页面 ${pageTag}` +
      ` / 基线 GPU ${base.gpu.toFixed(1)}%（预算 ${GPU_BUDGET}%）` +
      (ab
        ? ` / 关动画 ${ab.gpu.toFixed(1)}% / A-B 差值 ${delta.toFixed(1)} 个点（预算 ${DELTA_BUDGET}）`
        : ' / A-B 已跳过') +
      ` / 基线总 CPU ${base.total.toFixed(1)}%` +
      ` / GPU 进程 ${base.gpuProcs}` +
      (base.animProbeOk
        ? ` / 基线动画 ${base.running.length}/${base.animCount}`
        : ' / 基线动画 探测失败'),
  )
  // 被测页面的清单也要发。这道门禁是隐式挑页面的（见上面 page 的选择逻辑），
  // 只发挑中的那一个，「还有别的窗口没被量」这件事就看不见了 —— 而
  // pet / chat / wallpaper 三个形态窗口的动画都住在各自的 styles.css 里。
  notice(
    `[idle-gpu] 可量页面 ${pageTargets.length} 个：` +
      (pageTargets.map(pageName).join(', ') || '(无)') +
      '（本次只量了挑中的那一个）',
  )
  // 页面一个 CSS 动画都没有时，这道门禁关于动画的两条判据（A/B 差值、
  // 「常驻无限动画」）本次都**没有量到任何东西**。绿是绿，但要知道它是空绿。
  if (!base.animProbeOk) {
    notice(
      '[idle-gpu] 动画探测失败：document.getAnimations() 没取到结果，' +
        '本次关于动画的判据全都没有量到东西（只有绝对预算那条有效）',
    )
  } else if (base.animCount === 0) {
    notice(
      '[idle-gpu] 被测页面一个 CSS 动画都没有：本次关于动画的判据（A/B 差值、' +
        '常驻无限动画）结构性为空，没有量到任何东西 —— 绿只由绝对预算那条承担',
    )
  }
  // A/B 只在「基线本来就有动画可关」时才带信息量。基线 0 个运行中动画时，
  // 差值为 0 是**必然**的 —— 这次绿其实只靠绝对预算那一条，得说清楚，
  // 否则会把一次没有信息量的通过读成「A/B 这条承重断言也验过了」。
  if (ab && base.animProbeOk && base.animCount > 0 && base.running.length === 0) {
    notice(
      '[idle-gpu] A/B 本次无信息量：基线就没有运行中动画，差值为 0 是必然的' +
        '（本次判定只由绝对预算那条承担）',
    )
  }

  // 仪器自检结果。这条注解回答一个此前完全未知的问题：
  // **在这台机器上，CSS 动画到底会不会体现在 GPU 进程的 CPU 上。**
  // 差值为 0 就说明两条判据都永远不会触发 —— 那种情况下的绿是空绿，
  // 而且比「测到了 0」更糟：连判据本身都是死的。
  if (sc) {
    notice(
      `[idle-gpu] 仪器自检：注入全视口合成动画后 GPU ${sc.gpu.toFixed(1)}%` +
        `（对照「关动画」${ab.gpu.toFixed(1)}%，差值 ${
          scDelta === null ? '(无参照)' : scDelta.toFixed(1)
        } 个点）` +
        ` / 自检动画 ${sc.running.length}/${sc.animCount}` +
        ` / 清理后残留 ${scLeft}（期望 ${SELFCHECK_CLEAN}）` +
        ` / 进程类型 ${fmtProcTypes(sc.procTypes)}`,
    )
    // ⚠️ 「注入没生效」与「注入生效但 GPU 不响应」的差值都是 0，必须分开报
    // —— 对后者说「这条链断了」才是对的，对前者说就是假话。判别依据就在同一行里：
    // 自检那一段有没有看见**运行中**的注入动画。
    // 这两种情形现在都已进 fails（v2），所以这里不再重复发 notice：
    // 一条 ::error:: 注解已经在 run 页面上了，再发一条同义 notice 只是噪声。
    if (scLeft !== SELFCHECK_CLEAN) {
      notice(
        `[idle-gpu] ⚠️ 自检清理不干净（残留 ${scLeft}，期望 ${SELFCHECK_CLEAN}）：` +
          '注入物没被完全移除，本次之后的数字不可信',
      )
    }
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
