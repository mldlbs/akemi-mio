// @ts-check
/**
 * Windows 开发启动包装器
 * 通过 spawn + windowsHide:true 直接启动 electron-vite，
 * 避免 npm 和 .cmd 文件中间的 cmd.exe 控制台窗口闪烁。
 */
const { spawn, spawnSync } = require('child_process')
const { existsSync } = require('fs')
const { join } = require('path')

const root = join(__dirname, '..')
const electronVite = join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')

function probeElectronNativeDependency(name) {
  const electronPath = require('electron')
  const probe = `
    try {
      require(${JSON.stringify(name)})
      process.exit(0)
    } catch (err) {
      console.error(err && err.stack ? err.stack : err)
      process.exit(1)
    }
  `

  return spawnSync(electronPath, [], {
    cwd: root,
    input: probe,
    encoding: 'utf8',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
    },
  })
}

function ensureElectronNativeDependency(name) {
  const moduleRoot = join(root, 'node_modules', name)
  if (!existsSync(moduleRoot)) {
    return
  }

  const probe = probeElectronNativeDependency(name)
  if (probe.status === 0) {
    return
  }

  const electronVersion = require('electron/package.json').version
  const prebuildInstall = require.resolve('prebuild-install/bin.js', { paths: [moduleRoot] })
  console.warn(`[dev] ${name} is not loadable in Electron ${electronVersion}; installing Electron prebuild...`)
  if (probe.stderr) {
    console.warn(probe.stderr.trim())
  }

  const install = spawnSync(
    process.execPath,
    [
      prebuildInstall,
      '--runtime',
      'electron',
      '--target',
      electronVersion,
      '--arch',
      process.arch,
      '--platform',
      process.platform,
      '--verbose',
    ],
    {
      cwd: moduleRoot,
      stdio: 'inherit',
    },
  )

  if (install.status !== 0) {
    process.exit(install.status ?? 1)
  }

  const verify = probeElectronNativeDependency(name)
  if (verify.status !== 0) {
    console.error(`[dev] ${name} still cannot load in Electron after installing the prebuild.`)
    if (verify.stderr) {
      console.error(verify.stderr.trim())
    }
    process.exit(1)
  }
}

function findPythonWithPackage(packageName) {
  const candidates = ['python', 'py']

  for (const candidate of candidates) {
    const probe = spawnSync(
      candidate,
      [
        '-c',
        `import sys, importlib.util; raise SystemExit(0 if importlib.util.find_spec(${JSON.stringify(packageName)}) else 1); print(sys.executable)`,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
      },
    )

    if (probe.status === 0) {
      const pathProbe = spawnSync(candidate, ['-c', 'import sys; print(sys.executable)'], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
      })
      return pathProbe.stdout.trim() || candidate
    }
  }

  return ''
}

ensureElectronNativeDependency('better-sqlite3')
const piperPython = process.env.PIPER_PYTHON || findPythonWithPackage('piper')

// 注意：绝不能把 ELECTRON_RUN_AS_NODE 透传给真正的 Electron 进程。
// 一旦 Electron 以「Node 模式」启动，require('electron').app 会是 undefined，
// 导致 main 进程在模块顶层调用 app.xxx 时直接崩溃（如 disableHardwareAcceleration / getPath）。
// 这里的探针函数会故意给自己设 ELECTRON_RUN_AS_NODE=1，但主进程启动必须清除它。
const mainEnv = { ...process.env }
delete mainEnv.ELECTRON_RUN_AS_NODE

const child = spawn(process.execPath, [electronVite, 'dev'], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
  env: {
    ...mainEnv,
    AKEMI_MIO_OBSERVABILITY: process.env.AKEMI_MIO_OBSERVABILITY || '',
    RUNTIME_ENABLED: process.env.RUNTIME_ENABLED || '1',
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || 'C:\\Users\\gf191\\AppData\\Local\\ms-playwright',
    LLM_KEY: process.env.LLM_KEY || '',
    PIPER_PYTHON: piperPython || process.env.PIPER_PYTHON || 'python',
  },
})

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0))
})
