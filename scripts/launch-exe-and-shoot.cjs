'use strict'

// Launches the REAL packaged exe (dist-electron/*.exe), waits for it to settle,
// screenshots the actual desktop, then collects the app's own log file.
//
// Differences from scripts/launch-and-shoot.cjs (which runs out/main/index.js):
//   - a packaged Windows app has no usable stdout, so we read the log file that
//     Logger writes under %APPDATA%/<productName>/logs/ instead of piping stdio
//   - the exe is spawned detached-ish so the child tree can be killed as a whole
//
// Sandbox quirks that still apply (see repo memory):
//   - ELECTRON_RUN_AS_NODE must be deleted
//   - --in-process-gpu, otherwise the GPU process exits fatally

const { spawn, execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')

const repo = path.resolve(__dirname, '..')
const distDir = process.env.MIO_DIST_DIR
  ? path.resolve(process.env.MIO_DIST_DIR)
  : path.join(repo, 'dist-electron')
const outPng = process.argv[2] || path.join(repo, '.launch-capture', 'screen-exe.png')
const waitMs = Number(process.argv[3] || 18000)

function findExe() {
  // 优先用免安装目录里的主程序：它是真正的 app，启动最快
  // （portable 单文件 exe 会先自解压到临时目录，慢且日志路径不同）
  const unpacked = path.join(distDir, 'win-unpacked', 'AkemiMio.exe')
  if (fs.existsSync(unpacked)) return unpacked

  const candidates = fs
    .readdirSync(distDir)
    .filter((f) => f.toLowerCase().endsWith('.exe'))
    .map((f) => {
      const full = path.join(distDir, f)
      return { full, mtime: fs.statSync(full).mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)
  if (candidates.length === 0) throw new Error('no packaged exe found in ' + distDir)
  return candidates[0].full
}

const exe = findExe()
fs.mkdirSync(path.dirname(outPng), { recursive: true })

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

// 启动前记一份基线 mtime，跑完才知道日志是不是这次运行写的
const baseline = newestLog()
console.log('launching:', exe)
console.log('baseline log:', baseline.file || '(none)', baseline.file ? new Date(baseline.mtime).toISOString() : '')

const child = spawn(exe, ['--in-process-gpu'], { env, cwd: path.dirname(exe), detached: false })
child.on('error', (e) => {
  console.error('spawn error:', e.message)
  process.exit(1)
})

function captureDesktop() {
  const ps = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save('${outPng}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output ("saved " + $b.Width + "x" + $b.Height)
`
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
  })
}

// 打包版 userData 是 %APPDATA%\akemi-mio（小写，来自 package.json name），
// 且 Logger 自己再建一层 logs/，所以真实路径是 logs\logs\app-YYYY-MM-DD.log。
// dev 直跑走的是 %APPDATA%\Electron。这里两个都扫，取最新的那个。
function logDirs() {
  const appData = process.env.APPDATA
  if (!appData) return []
  const names = ['akemi-mio', 'AkemiMio', 'Electron']
  const dirs = []
  for (const n of names) {
    dirs.push(path.join(appData, n, 'logs', 'logs'))
    dirs.push(path.join(appData, n, 'logs'))
  }
  return dirs.filter((d) => fs.existsSync(d))
}

function newestLog() {
  let best = null
  for (const dir of logDirs()) {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.log')) continue
      const full = path.join(dir, e.name)
      const mtime = fs.statSync(full).mtimeMs
      if (!best || mtime > best.mtime) best = { file: full, mtime }
    }
  }
  if (!best) return { file: null, mtime: 0, text: '' }
  return { ...best, text: fs.readFileSync(best.file, 'utf8') }
}

setTimeout(() => {
  let captureNote = ''
  try {
    captureNote = captureDesktop().trim()
  } catch (e) {
    captureNote = 'CAPTURE FAILED: ' + e.message
  }

  const collected = newestLog()
  const fresh = collected.file && collected.mtime > baseline.mtime
  const dest = path.join(repo, '.launch-exe.log')
  fs.writeFileSync(
    dest,
    collected && collected.text ? collected.text : '(no app log found)\n',
    'utf8',
  )

  try {
    execFileSync('taskkill', ['/IM', 'AkemiMio.exe', '/F', '/T'], { encoding: 'utf8' })
  } catch {
    /* already gone */
  }

  console.log('exe:', exe)
  console.log('capture:', captureNote)
  console.log('app log:', collected && collected.file ? collected.file : '(none)')
  console.log('log mtime:', collected && collected.file ? new Date(collected.mtime).toISOString() : '-')
  console.log('log written by THIS run:', fresh ? 'yes' : 'NO (stale)')
  console.log('log lines:', collected ? collected.text.split('\n').length : 0)
  console.log('saved log to:', dest)
  setTimeout(() => process.exit(0), 800)
}, waitMs)
