import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it, vi } from 'vitest'

type ConfigModule = typeof import('@akemi-mio/core/config/index')

const LLM_ENV_KEYS = [
  'USER_DATA_DIR',
  'LLM_API_URL',
  'LLM_KEY',
  'LLM_CHAT_MODEL',
  'LLM_CODE_API_URL',
  'LLM_CODE_MODEL',
  'LLM_CODE_KEY',
  'LLM_TEXT_API_URL',
  'LLM_TEXT_MODEL',
  'LLM_TEXT_KEY',
  'LLM_VISION_API_URL',
  'LLM_VISION_MODEL',
  'LLM_VISION_KEY',
]

const envSnapshot = { ...process.env }
const tempDirs: string[] = []

function createTempRuntimeDirs() {
  const root = mkdtempSync(join(tmpdir(), 'akemi-config-'))
  const projectRoot = join(root, 'project')
  const userDataRoot = join(root, 'userData')
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(userDataRoot, { recursive: true })
  tempDirs.push(root)
  return { projectRoot, userDataRoot }
}

function setInjectedElectronApp(app: unknown): void {
  // config/index 用 require('electron')，在 ESM 下 require 不存在且 vi.mock 拦不到它，
  // 所以必须走 @akemi-mio/core/config 提供的注入点，否则会静默回退到 process.cwd()
  // 并读走仓库根目录的真实 .env。
  ;(globalThis as any).__AKEMI_MIO_ELECTRON_APP__ = app
}

async function importConfigFor(opts: { isPackaged: boolean; projectRoot: string; userDataRoot: string }): Promise<ConfigModule> {
  vi.resetModules()
  setInjectedElectronApp({
    isPackaged: opts.isPackaged,
    getAppPath: () => opts.projectRoot,
    getPath: (name: string) => {
      if (name === 'userData') return opts.userDataRoot
      throw new Error(`unexpected path lookup: ${name}`)
    },
  })

  for (const key of LLM_ENV_KEYS) delete process.env[key]

  return import('@akemi-mio/core/config/index')
}

describe('config', () => {
  afterEach(() => {
    vi.resetModules()
    delete (globalThis as any).__AKEMI_MIO_ELECTRON_APP__
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, envSnapshot)
  })

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  it('loads LLM env from project root in development mode', async () => {
    const { projectRoot, userDataRoot } = createTempRuntimeDirs()

    writeFileSync(join(projectRoot, '.env'), 'LLM_API_URL=https://project.example/v1\nLLM_CHAT_MODEL=project-model\n')
    writeFileSync(join(userDataRoot, '.env'), 'LLM_API_URL=https://userdata.example/v1\nLLM_CHAT_MODEL=userdata-model\n')

    const config = await importConfigFor({ isPackaged: false, projectRoot, userDataRoot })

    expect(config.LLM_API_URL).toBe('https://project.example/v1')
    expect(config.LLM_CHAT_MODEL).toBe('project-model')
  })

  it('does not load userData .env for packaged mode', async () => {
    const { projectRoot, userDataRoot } = createTempRuntimeDirs()

    // 项目根也写一份：dev 模式读的正是这一份，所以「packaged 下必须忽略它」才是本用例
    // 真正有区分力的断言。只写 userData 那份的话，dev 与 packaged 结果相同，断言形同虚设。
    writeFileSync(join(projectRoot, '.env'), 'LLM_API_URL=https://project.example/v1\nLLM_CHAT_MODEL=project-model\n')
    writeFileSync(join(userDataRoot, '.env'), 'LLM_API_URL=https://userdata.example/v1\nLLM_CHAT_MODEL=userdata-model\n')

    const config = await importConfigFor({ isPackaged: true, projectRoot, userDataRoot })

    expect(config.LLM_API_URL).toBe('https://opencode.ai/zen/go/v1/chat/completions')
    expect(config.LLM_CHAT_MODEL).toBe('deepseek-v4-flash')
    // 上面两条单独看不够：仓库根的真实 .env 里 LLM_API_URL / LLM_CHAT_MODEL 恰好就等于
    // 这两个内置默认值，所以即使 .env 被误读，前两条也照样通过。LLM_KEY 才是判别点 ——
    // 默认为空，一旦读进任何 .env 就会变成真实密钥。
    expect(config.LLM_KEY).toBe('')
  })

  it('exports WORKSPACE_ROOT with defaults', async () => {
    const { projectRoot, userDataRoot } = createTempRuntimeDirs()
    const config = await importConfigFor({ isPackaged: false, projectRoot, userDataRoot })

    expect(config.WORKSPACE_ROOT).toBeDefined()
    expect(config.WORKSPACE.memory).toContain('memory')
  })

  it('exports ASR_SAMPLE_RATE constant', async () => {
    const { projectRoot, userDataRoot } = createTempRuntimeDirs()
    const config = await importConfigFor({ isPackaged: false, projectRoot, userDataRoot })
    expect(config.ASR_SAMPLE_RATE).toBe(16000)
  })

  it('exports WAKE_WORDS with defaults', async () => {
    const { projectRoot, userDataRoot } = createTempRuntimeDirs()
    const config = await importConfigFor({ isPackaged: false, projectRoot, userDataRoot })
    expect(config.WAKE_WORDS).toContain('mio')
  })

  it('defaults WINDOW_WIDTH to 420', async () => {
    const { projectRoot, userDataRoot } = createTempRuntimeDirs()
    const config = await importConfigFor({ isPackaged: false, projectRoot, userDataRoot })
    expect(config.WINDOW_WIDTH).toBe(420)
  })

  it('defaults WINDOW_HEIGHT to 640', async () => {
    const { projectRoot, userDataRoot } = createTempRuntimeDirs()
    const config = await importConfigFor({ isPackaged: false, projectRoot, userDataRoot })
    expect(config.WINDOW_HEIGHT).toBe(640)
  })

  it('defaults EVOLUTION_SAFETY_MODE to review', async () => {
    const { projectRoot, userDataRoot } = createTempRuntimeDirs()
    const config = await importConfigFor({ isPackaged: false, projectRoot, userDataRoot })
    expect(config.EVOLUTION_SAFETY_MODE).toBe('review')
  })

  it('defaults USE_LOCAL_TTS to false', async () => {
    const { projectRoot, userDataRoot } = createTempRuntimeDirs()
    const config = await importConfigFor({ isPackaged: false, projectRoot, userDataRoot })
    expect(config.USE_LOCAL_TTS).toBe(false)
  })

  it('exports FFMPEG_PATHS with defaults', async () => {
    const { projectRoot, userDataRoot } = createTempRuntimeDirs()
    const config = await importConfigFor({ isPackaged: false, projectRoot, userDataRoot })
    expect(config.FFMPEG_PATHS).toContain('ffmpeg')
  })

  it('exports FFPLAY_PATHS with defaults', async () => {
    const { projectRoot, userDataRoot } = createTempRuntimeDirs()
    const config = await importConfigFor({ isPackaged: false, projectRoot, userDataRoot })
    expect(config.FFPLAY_PATHS).toContain('ffplay')
  })

  it('exports WORKSPACE subdirs', async () => {
    const { projectRoot, userDataRoot } = createTempRuntimeDirs()
    const config = await importConfigFor({ isPackaged: false, projectRoot, userDataRoot })
    expect(config.WORKSPACE.projects).toContain('projects')
    expect(config.WORKSPACE.memory).toContain('memory')
    expect(config.WORKSPACE.logs).toContain('logs')
    expect(config.WORKSPACE.evolution).toContain('evolution')
  })

  it('exports ASR_HOTWORDS with defaults', async () => {
    const { projectRoot, userDataRoot } = createTempRuntimeDirs()
    const config = await importConfigFor({ isPackaged: false, projectRoot, userDataRoot })
    expect(config.ASR_HOTWORDS).toContain('Agent')
    expect(config.ASR_HOTWORDS).toContain('MCP')
  })

  it('exports INITIAL_HOTWORDS with defaults', async () => {
    const { projectRoot, userDataRoot } = createTempRuntimeDirs()
    const config = await importConfigFor({ isPackaged: false, projectRoot, userDataRoot })
    expect(config.INITIAL_HOTWORDS.length).toBeGreaterThan(0)
  })

  it('exports LLM_CODE_API_URL', async () => {
    const { projectRoot, userDataRoot } = createTempRuntimeDirs()
    const config = await importConfigFor({ isPackaged: false, projectRoot, userDataRoot })
    expect(config.LLM_CODE_API_URL).toBeTruthy()
  })

  it('exports LLM_CHAT_MODEL with default', async () => {
    const { projectRoot, userDataRoot } = createTempRuntimeDirs()
    const config = await importConfigFor({ isPackaged: false, projectRoot, userDataRoot })
    expect(config.LLM_CHAT_MODEL).toBeTruthy()
  })

  it('exports LLM_CODE_MODEL with default', async () => {
    const { projectRoot, userDataRoot } = createTempRuntimeDirs()
    const config = await importConfigFor({ isPackaged: false, projectRoot, userDataRoot })
    expect(config.LLM_CODE_MODEL).toBeTruthy()
  })

  it('exports PIPER_SCRIPT with default', async () => {
    const { projectRoot, userDataRoot } = createTempRuntimeDirs()
    const config = await importConfigFor({ isPackaged: false, projectRoot, userDataRoot })
    expect(config.PIPER_SCRIPT).toBeTruthy()
  })

  it('exports LLM_MODEL backward compat', async () => {
    const { projectRoot, userDataRoot } = createTempRuntimeDirs()
    const config = await importConfigFor({ isPackaged: false, projectRoot, userDataRoot })
    expect(config.LLM_MODEL).toBe(config.LLM_CHAT_MODEL)
  })

  it('exports ASR_INITIAL_PROMPT with default', async () => {
    const { projectRoot, userDataRoot } = createTempRuntimeDirs()
    const config = await importConfigFor({ isPackaged: false, projectRoot, userDataRoot })
    expect(config.ASR_INITIAL_PROMPT).toBeTruthy()
  })

  it('exports ASR_MAX_AUDIO_SECONDS', async () => {
    const { projectRoot, userDataRoot } = createTempRuntimeDirs()
    const config = await importConfigFor({ isPackaged: false, projectRoot, userDataRoot })
    expect(config.ASR_MAX_AUDIO_SECONDS).toBe(25)
  })
})
