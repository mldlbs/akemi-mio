// @ts-check
/**
 * Windows 开发启动包装器
 * 通过 spawn + windowsHide:true 直接启动 electron-vite，
 * 避免 npm 和 .cmd 文件中间的 cmd.exe 控制台窗口闪烁。
 */
const { spawn } = require('child_process')
const { join } = require('path')

const root = join(__dirname, '..')
const electronVite = join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')

const child = spawn(process.execPath, [electronVite, 'dev'], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
  env: {
    ...process.env,
    AKEMI_MIO_OBSERVABILITY: process.env.AKEMI_MIO_OBSERVABILITY || '',
  },
})

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0))
})
