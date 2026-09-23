'use strict'

// 逐个创建应用的全部渲染入口，对每个做三步客观验证。
//
// 为什么要这个脚本：主进程日志再干净也照不出渲染进程的问题 ——
//   (1) renderer 的 JS 异常/console.error 不进文件日志，只在 DevTools 里；
//   (2) 启动时只创建主窗口，pet/chat/wallpaper/agent 四个入口
//       不主动打开就永远没人看过；
//   (3) 「有没有画出来」不能凭感觉 —— 本脚本实测布局高度链，
//       曾据此抓到 shared.css 的死选择器让壁纸整块塌成 0 高度。
//
// 用法：
//   node scripts/check-renderer-entries.cjs [exePath]
//   MIO_DIST_DIR=dist-electron-pkg8 npm run check:renderer-entries
//
// 退出码：任一入口有问题则非 0（可直接挂 CI 的冒烟环节）。

const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const repo = path.resolve(__dirname, '..')
const PRODUCT_NAME = 'akemi-mio'

const distDir = process.env.MIO_DIST_DIR ? path.resolve(process.env.MIO_DIST_DIR) : path.join(repo, 'dist-electron')
const waitMs = Number(process.env.MIO_WAIT_MS || 12000)
const collectMs = Number(process.env.MIO_COLLECT_MS || 2500)

// Git Bash 下 $APPDATA 是空的，必须能自己拼出 Roaming 路径
function userDataDir() {
  if (process.env.MIO_USER_DATA) return path.resolve(process.env.MIO_USER_DATA)
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(roaming, PRODUCT_NAME)
}

function findExe() {
  if (process.argv[2]) return path.resolve(process.argv[2])
  const unpacked = path.join(distDir, 'win-unpacked', 'AkemiMio.exe')
  if (fs.existsSync(unpacked)) return unpacked
  if (!fs.existsSync(distDir)) throw new Error('打包目录不存在：' + distDir)
  const candidates = fs
    .readdirSync(distDir)
    .filter((f) => f.toLowerCase().endsWith('.exe'))
    .map((f) => ({ full: path.join(distDir, f), mtime: fs.statSync(path.join(distDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  if (!candidates.length) throw new Error('没找到打包 exe：' + distDir)
  return candidates[0].full
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const EXE = findExe()
const USER_DATA = userDataDir()
const portFile = path.join(USER_DATA, 'DevToolsActivePort')

// DevTools 端口文件是**残留文件**：不挪走就会读到上一轮的端口，fetch 必失败
try {
  if (fs.existsSync(portFile)) fs.renameSync(portFile, portFile + '.prev')
} catch (e) {
  console.log('挪走旧端口文件失败:', e.message)
}

const env = { ...process.env, MIO_OPEN_DEVTOOLS: '1' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(EXE, ['--in-process-gpu'], { env, cwd: path.dirname(EXE), stdio: 'ignore' })

async function waitForPort(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return fs.readFileSync(portFile, 'utf8').trim().split(/\s+/)[0]
    } catch {
      await sleep(300)
    }
  }
  return null
}

async function getList(port) {
  for (let i = 0; i < 60; i++) {
    try {
      return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    } catch {
      await sleep(500)
    }
  }
  return null
}

const DOM_EXPR = `(() => {
  const box = (el) => el ? [Math.round(el.getBoundingClientRect().width), Math.round(el.getBoundingClientRect().height)] : null
  const root = document.getElementById('root')
  const first = root && root.firstElementChild
  const all = [...document.querySelectorAll('body *')]
  const painted = all.filter((e) => {
    const r = e.getBoundingClientRect()
    const cs = getComputedStyle(e)
    return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.02
  })
  return JSON.stringify({
    url: location.href,
    formKind: (window.akemiForms && window.akemiForms.kind) || null,
    viewport: [window.innerWidth, window.innerHeight],
    html: box(document.documentElement),
    body: box(document.body),
    root: box(root),
    firstChild: first ? { cls: String(first.className), box: box(first) } : null,
    nodes: all.length,
    painted: painted.length,
    text: ((document.body.innerText) || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
  })
})()`

const PROBE_EXPR = `console.error('__PROBE_CONSOLE_ERROR__'); setTimeout(() => { throw new Error('__PROBE_THROW__') }, 0); 'probe-sent'`

const FORWARDER = `
  window.addEventListener('error', (e) => console.error('[onerror] ' + (e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || '')));
  window.addEventListener('unhandledrejection', (e) => console.error('[unhandledrejection] ' + String((e.reason && e.reason.message) || e.reason)));
`

/**
 * 附加到一个 page 目标：重载以捕获加载期报错，取 DOM/布局快照，再发自检探针。
 * 探针抓不到说明仪器失灵 —— 此时的「0 错误」不可信，必须记为失败。
 */
async function inspect(target, label) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  const events = []
  const pending = new Map()
  let id = 200

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id).resolve(m)
      pending.delete(m.id)
      return
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {}
      events.push({ kind: 'exception', text: (d.exception && d.exception.description) || d.text || '' })
    } else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
      events.push({
        kind: 'console.' + m.params.type,
        text: (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' '),
      })
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry || {}
      if (e.level === 'error' || e.level === 'warning') events.push({ kind: 'log.' + e.level, text: `${e.text} ${e.url || ''}`.trim() })
    }
  })

  const send = (method, params, waitResult = false) => {
    const myId = ++id
    let p = Promise.resolve(null)
    if (waitResult) p = new Promise((resolve) => pending.set(myId, { resolve }))
    ws.send(JSON.stringify({ id: myId, method, params }))
    return p
  }

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
    setTimeout(() => reject(new Error('ws 连接超时')), 15000)
  })

  send('Runtime.enable')
  send('Log.enable')
  send('Page.enable')
  send('Page.addScriptToEvaluateOnNewDocument', { source: FORWARDER })
  send('Page.reload', { ignoreCache: true })
  await sleep(waitMs)

  const domResp = await send('Runtime.evaluate', { expression: DOM_EXPR, returnByValue: true }, true)
  let info = {}
  try {
    info = JSON.parse(domResp.result.result.value)
  } catch {
    info = { parseError: JSON.stringify(domResp.result).slice(0, 200) }
  }

  await send('Runtime.evaluate', { expression: PROBE_EXPR }, true)
  await sleep(collectMs)
  try {
    ws.close()
  } catch {}

  const probes = events.filter((e) => String(e.text).includes('__PROBE_'))
  const real = events.filter((e) => !String(e.text).includes('__PROBE_'))
  const instrumentOk = probes.length >= 2

  // 布局塌陷判据：根容器高度与视口差一截（百分比高度链失去确定高度的典型症状）
  const collapsed = Array.isArray(info.viewport) && Array.isArray(info.html) && info.html[1] < info.viewport[1] - 2

  console.log('\n──────────────────────────────────────────')
  console.log(`【${label}】${target.title || '(无标题)'}`)
  console.log(
    '  url          :',
    String(info.url || target.url)
      .split('/')
      .pop(),
  )
  console.log('  formKind     :', info.formKind)
  console.log('  DOM 节点     :', info.nodes, '（实际绘制', info.painted, '）')
  console.log('  视口 / html  :', (info.viewport || []).join('x'), '/', (info.html || []).join('x'), collapsed ? '  ❌ 高度塌陷' : '  ✓')
  console.log('  首层容器     :', info.firstChild ? `${info.firstChild.cls} ${info.firstChild.box.join('x')}` : '(无)')
  console.log('  可见文本     :', JSON.stringify(String(info.text || '')))
  console.log('  仪器自检     :', probes.length, instrumentOk ? '✓ 有效' : '❌ 失灵（下面的数字不可信）')
  console.log('  异常/错误    :', real.length)
  for (const e of real.slice(0, 8)) console.log('      -', e.kind, String(e.text).split('\n')[0].slice(0, 150))

  return { ok: instrumentOk && real.length === 0 && !collapsed && (info.nodes || 0) > 3, info }
}

async function main() {
  console.log('exe :', EXE)
  console.log('data:', USER_DATA)
  const port = await waitForPort(40000)
  if (!port) throw new Error('拿不到 DevTools 端口（MIO_OPEN_DEVTOOLS 没生效？）')
  console.log('port:', port)
  await sleep(waitMs)

  const pagesOf = (l) => (l || []).filter((t) => t.type === 'page')
  const findByUrl = (l, frag) => pagesOf(l).find((t) => String(t.url).includes(frag))

  const list = await getList(port)
  const main = findByUrl(list, 'index.html') || pagesOf(list)[0]
  if (!main) throw new Error('没有 page 目标')

  const results = {}
  results['主窗口 index.html'] = await inspect(main, '主窗口 index.html')

  // 主窗口的 CDP 连接留着，用来触发其它入口
  const mws = new WebSocket(main.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    mws.addEventListener('open', res)
    mws.addEventListener('error', rej)
  })
  const trigger = async (expr, ms = 4500) => {
    mws.send(JSON.stringify({ id: Date.now() % 100000, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true } }))
    await sleep(ms)
  }

  for (const kind of ['pet', 'chat', 'wallpaper']) {
    await trigger(`window.akemiForms.toggleForm(${JSON.stringify(kind)})`)
    const t = findByUrl(await getList(port), kind + '.html')
    if (!t) {
      console.log(`\n❌ ${kind}.html 目标未出现（toggleForm 没生效？）`)
      results[`形态 ${kind}.html`] = { ok: false }
      continue
    }
    results[`形态 ${kind}.html`] = await inspect(t, `形态 ${kind}.html`)
  }

  await trigger('window.electronAPI.openAgentWindow()', 5500)
  const ta = findByUrl(await getList(port), 'agent.html')
  if (!ta) {
    console.log('\n❌ agent.html 目标未出现（openAgentWindow 没生效？）')
    results['agent.html'] = { ok: false }
  } else {
    results['agent.html'] = await inspect(ta, 'agent.html')
  }

  console.log('\n===== 汇总 =====')
  let failed = 0
  for (const [k, v] of Object.entries(results)) {
    if (!v.ok) failed++
    console.log(`  ${v.ok ? '✓' : '❌'} ${k}`)
  }
  console.log(failed ? `\n${failed} 个入口有问题` : '\n全部入口正常')
  return failed
}

let exitCode = 1
setTimeout(async () => {
  try {
    const failed = await main()
    exitCode = failed ? 1 : 0
  } catch (e) {
    console.log('失败:', e.message)
    exitCode = 1
  }
  try {
    process.kill(child.pid)
  } catch {}
  await sleep(1500)
  process.exit(exitCode)
}, 500)
