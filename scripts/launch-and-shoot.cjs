'use strict'

// Launches the real packaged-ish app (out/main/index.js) under Electron, waits
// for it to settle, then screenshots the actual desktop so we can see what the
// app really renders -- as opposed to the synthetic harness that only loads the
// renderer + preload without a backend.
//
// Two sandbox quirks are mandatory here (see repo memory):
//   - ELECTRON_RUN_AS_NODE must be deleted, otherwise require('electron')
//     returns a path string and the app dies on electron.app.disableHardwareAcceleration()
//   - --in-process-gpu, otherwise the GPU process exits fatally

const { spawn, execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')

const repo = path.resolve(__dirname, '..')
const electron = require(path.join(repo, 'node_modules', 'electron'))
const mainJs = path.join(repo, 'out', 'main', 'index.js')
const outPng = process.argv[2] || path.join(repo, '.launch-capture', 'screen.png')
const waitMs = Number(process.argv[3] || 16000)

fs.mkdirSync(path.dirname(outPng), { recursive: true })

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const log = []
const child = spawn(electron, [mainJs, '--in-process-gpu'], { env, cwd: repo })
child.stdout.on('data', (d) => log.push('[out] ' + d))
child.stderr.on('data', (d) => log.push('[err] ' + d))
child.on('error', (e) => {
  console.error('spawn error:', e.message)
  process.exit(1)
})

function captureDesktop() {
  // 路径要插进 PowerShell 的单引号字符串，里面的 ' 必须翻倍转义，
  // 否则路径会被截断（更糟的情况是拼出可执行的 PowerShell）。
  const pngLiteral = "'" + outPng.replace(/'/g, "''") + "'"
  const ps = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save(${pngLiteral}, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output ("saved " + $b.Width + "x" + $b.Height)
`
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
  })
}

setTimeout(() => {
  let captureNote
  try {
    captureNote = captureDesktop().trim()
  } catch (e) {
    captureNote = 'CAPTURE FAILED: ' + e.message
  }
  const text = log.join('')
  fs.writeFileSync(path.join(repo, '.launch.log'), text, 'utf8')
  console.log('capture:', captureNote)
  console.log('--- last 40 log lines ---')
  console.log(text.split('\n').slice(-40).join('\n'))
  child.kill('SIGKILL')
  setTimeout(() => process.exit(0), 800)
}, waitMs)
