import { resolve, join, dirname } from 'path'
import { existsSync, readFileSync, mkdirSync, copyFileSync } from 'fs'
import { spawnSync } from 'child_process'

let _electronApp: any = null
let _electronLoaded = false

/**
 * 惰性获取 electron 的 `app`。
 *
 * 这里历史上直接 `require('electron')`，但本文件在 ESM/SSR 语境（vitest、vite-node）下
 * `require` 根本不存在，会直接抛错并**静默回退**到 `process.cwd()` —— 后果有两个：
 *   1. 开发态总能读到仓库根目录的真实 `.env`（含真实 LLM_KEY），并把密钥带进测试输出；
 *   2. `vi.mock('electron')` 只拦 ESM import、拦不到 `require`，测试里的 electron mock
 *      形同虚设，`isPackagedApp()` 恒为 false，packaged 分支永远覆盖不到。
 *
 * 因此优先读取注入点 `globalThis.__AKEMI_MIO_ELECTRON_APP__`：生产环境从不设置它，
 * 行为与改动前完全一致；测试可注入假 app，从而真正覆盖 packaged 分支与项目根目录解析。
 */
function getElectronApp(): any {
  if (!_electronLoaded) {
    _electronLoaded = true
    const injected = (globalThis as any).__AKEMI_MIO_ELECTRON_APP__
    if (injected !== undefined) {
      _electronApp = injected
    } else {
      try {
        _electronApp = require('electron').app
      } catch {
        _electronApp = null
      }
    }
  }
  return _electronApp
}

function getProjectRoot(): string {
  const electronApp = getElectronApp()
  if (electronApp) {
    try {
      return electronApp.getAppPath()
    } catch { /* fallback */ }
  }
  return process.cwd()
}

function getUserDataDir(): string {
  if (process.env.USER_DATA_DIR) return process.env.USER_DATA_DIR
  const electronApp = getElectronApp()
  if (electronApp) {
    try {
      return electronApp.getPath('userData')
    } catch { /* fallback */ }
  }
  return process.cwd()
}

const userDataDir = getUserDataDir()

function isPackagedApp(): boolean {
  const electronApp = getElectronApp()
  if (electronApp) {
    try {
      return !!electronApp.isPackaged
    } catch { /* fallback */ }
  }
  return false
}

/**
 * 找到一个**真的装了指定 Python 包**的解释器。
 *
 * 为什么需要它：`python` 这个裸命令在 PATH 上并不唯一。本机实测 PATH 顺序是
 * WorkBuddy 托管 Python(3.13，空) 在前、系统 Python(3.12，带 numpy+piper+torch)
 * 在后，于是裸 `python` 拿到了没有依赖的那个，造成：
 *   - Piper TTS 每次合成都报 `ModuleNotFoundError: No module named 'numpy'`；
 *   - ComfyUI `main.py` 导入即崩，进入 5 秒一次的重启循环。
 * 两者都只是"解释器选错了"，不是缺包。
 *
 * 原来只有 `scripts/dev.js` 做这件事（探测 `python`/`py`），所以 **dev 跑得好好的、
 * 打包版却必坏** —— 因为打包版不经过 dev.js，`PIPER_PYTHON` 直接落到裸 `python`。
 * 这里把同一套探测下沉到配置层，让两条路径共用。
 *
 * 只在首次真正取值时探测（见下方 lazy getter），不在模块加载时执行 ——
 * 本模块被 89 个文件 import，加载期做同步 spawn 会拖慢启动。
 */
function findPythonWithPackage(packageName: string): string {
  // 'py' 放在 'python' 之后：Windows 的 py launcher 会选它自己认为的默认版本，
  // 本机恰好是带依赖的 3.12，是很好的兜底。
  for (const candidate of ['python', 'py']) {
    try {
      const probe = spawnSync(
        candidate,
        [
          '-c',
          `import importlib.util as u, sys; sys.exit(0 if u.find_spec(${JSON.stringify(packageName)}) else 1)`,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 },
      )
      if (probe.status === 0) {
        const pathProbe = spawnSync(candidate, ['-c', 'import sys; print(sys.executable)'], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 5000,
        })
        const resolved = (pathProbe.stdout || '').trim()
        return resolved || candidate
      }
    } catch {
      /* 探测失败就试下一个候选 */
    }
  }
  return ''
}

let _piperPython: string | undefined

/**
 * Piper / ComfyUI 使用的 Python 解释器。
 *
 * 优先级：显式 env（PIPER_PYTHON）> 探测出的带依赖解释器 > 裸 'python'。
 * 探测结果做模块级缓存 —— 一次进程只探一次，别在每次合成时重复 spawn。
 */
export function resolvePiperPython(): string {
  if (_piperPython !== undefined) return _piperPython
  const explicit = process.env.PIPER_PYTHON
  if (explicit) {
    _piperPython = explicit
    return _piperPython
  }
  // 先按 piper 探测；没有就退回 numpy（ComfyUI 的最小依赖，覆盖无 TTS 的机器）。
  _piperPython = findPythonWithPackage('piper') || findPythonWithPackage('numpy') || 'python'
  return _piperPython
}


// ===== Runtime / Workspace 边界定义 =====
/** Layer 0 — Runtime Kernel 安装目录（只读） */
export const RUNTIME_ROOT = getProjectRoot()
/** Layer 1 — Mio Workspace 根目录（app.getPath('userData') 即 %APPDATA%/akemi-mio/） */
export const WORKSPACE_ROOT = userDataDir
/** Layer 2 — 工作区子目录 */
export const WORKSPACE = {
  databases: join(WORKSPACE_ROOT, 'databases'),
  projects: join(WORKSPACE_ROOT, 'projects'),
  memory: join(WORKSPACE_ROOT, 'memory'),
  knowledge: join(WORKSPACE_ROOT, 'knowledge'),
  skills: join(WORKSPACE_ROOT, 'skills'),
  workflows: join(WORKSPACE_ROOT, 'workflows'),
  proposals: join(WORKSPACE_ROOT, 'proposals'),
  logs: join(WORKSPACE_ROOT, 'logs'),
  cache: join(WORKSPACE_ROOT, 'cache'),
  evolution: join(WORKSPACE_ROOT, 'evolution_workspace'),
} as const

/** 开发模式：允许额外读取项目源码目录。仅当明确设置环境变量时启用。 */
export const DEV_PROJECT_ROOT = process.env.AKEMI_MIO_DEV_PROJECT || ''

// 加载 .env：开发环境只读项目根目录，分发环境不从 .env 注入运行时 LLM 配置
try {
  const envPath = !isPackagedApp() ? join(getProjectRoot(), '.env') : null
  if (envPath && existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
      const eq = line.indexOf('=')
      if (eq > 0) process.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
  }
} catch {
  /* .env optional */
}

/** 模型根目录：优先 userData，回退项目目录 */
function getModelsDir(): string {
  if (existsSync(join(userDataDir, 'models'))) {
    return userDataDir
  }
  if (existsSync(join(getProjectRoot(), 'models'))) {
    return getProjectRoot()
  }
  return userDataDir
}

/** LLM API endpoint URL for chat/conversation. Override via LLM_API_URL env. */
export const LLM_API_URL = process.env.LLM_API_URL || 'https://opencode.ai/zen/go/v1/chat/completions'
export const LLM_KEY = process.env.LLM_KEY || ''
/** LLM API endpoint URL for code/tool-calling. Falls back to LLM_API_URL if not set. Override via LLM_CODE_API_URL env. */
export const LLM_CODE_API_URL = process.env.LLM_CODE_API_URL || process.env.LLM_API_URL || 'https://opencode.ai/zen/go/v1/chat/completions'
/** LLM model for casual conversation & intent classification. Override via LLM_CHAT_MODEL env. */
export const LLM_CHAT_MODEL = process.env.LLM_CHAT_MODEL || process.env.LLM_MODEL || 'deepseek-v4-flash'
/** LLM model for tool calling, code generation, and development tasks. Override via LLM_CODE_MODEL env. */
export const LLM_CODE_MODEL = process.env.LLM_CODE_MODEL || process.env.LLM_MODEL || 'deepseek-v4-flash'
/** @deprecated Use LLM_CHAT_MODEL / LLM_CODE_MODEL individually. */
export const LLM_MODEL = LLM_CHAT_MODEL

/** LLM API endpoint URL for vision/multimodal (image understanding). Override via LLM_VISION_API_URL env. */
export const LLM_VISION_API_URL =
  process.env.LLM_VISION_API_URL || process.env.LLM_API_URL || 'https://opencode.ai/zen/go/v1/chat/completions'
/** LLM model for vision/multimodal tasks. Override via LLM_VISION_MODEL env. */
export const LLM_VISION_MODEL = process.env.LLM_VISION_MODEL || process.env.LLM_MODEL || 'deepseek-chat'
/** API key for vision model. Falls back to LLM_KEY if not set. Override via LLM_VISION_KEY env. */
export const LLM_VISION_KEY = process.env.LLM_VISION_KEY || ''

/** LLM API endpoint URL for text processing (summarization, extraction, rewriting, embedding). Override via LLM_TEXT_API_URL env. */
export const LLM_TEXT_API_URL = process.env.LLM_TEXT_API_URL || process.env.LLM_API_URL || 'https://opencode.ai/zen/go/v1/chat/completions'
/** LLM model for text processing tasks. Override via LLM_TEXT_MODEL env. */
export const LLM_TEXT_MODEL = process.env.LLM_TEXT_MODEL || process.env.LLM_MODEL || 'deepseek-chat'
/** API key for text processing model. Falls back to LLM_KEY if not set. Override via LLM_TEXT_KEY env. */
export const LLM_TEXT_KEY = process.env.LLM_TEXT_KEY || ''

/** API endpoint URL for image generation. Override via LLM_IMAGE_API_URL env. */
export const LLM_IMAGE_API_URL = process.env.LLM_IMAGE_API_URL || 'https://open.bigmodel.cn/api/paas/v4/images/generations'
/** API key for image generation model. Override via LLM_IMAGE_KEY env. */
export const LLM_IMAGE_KEY = process.env.LLM_IMAGE_KEY || ''
/** Model name for image generation (CogView-3-Flash by default). Override via LLM_IMAGE_MODEL env. */
export const LLM_IMAGE_MODEL = process.env.LLM_IMAGE_MODEL || 'cogview-3-flash'

/** Ordered list of paths to search for ffplay. Override via FFPLAY_PATH env.
 *  Default searches common install locations and the system PATH.
 *  The 'ffplay' bare entry at the end relies on PATH resolution. */
export const FFPLAY_PATHS = process.env.FFPLAY_PATH ? [process.env.FFPLAY_PATH] : ['ffplay', 'C:\\ffmpeg\\bin\\ffplay.exe']

// ══════════════════════════════════════════
//  Telegram — 代理服务器 & 推送配置
// ══════════════════════════════════════════

/** Telegram 功能总开关（默认关闭）。Override via TELEGRAM_ENABLED env. */
export const TELEGRAM_ENABLED = process.env.TELEGRAM_ENABLED === 'true'

/** Telegram 代理服务器地址。Override via TELEGRAM_SERVER_URL env. */
export const TELEGRAM_SERVER_URL = process.env.TELEGRAM_SERVER_URL || 'https://skills.crlkcloud.cyou/telegram'

/** Telegram 推送 Chat ID（可选，设置后启用系统事件推送）。Override via TELEGRAM_CHAT_ID env. */
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ? parseInt(process.env.TELEGRAM_CHAT_ID, 10) : null

/** Telegram outbox 轮询间隔（ms）。Override via TELEGRAM_POLL_INTERVAL_MS env. */
export const TELEGRAM_POLL_INTERVAL_MS = parseInt(process.env.TELEGRAM_POLL_INTERVAL_MS || '2000', 10)

/** Telegram outbox 任务冷却时间（ms）。Override via TELEGRAM_OUTBOX_COOLDOWN_MS env. */
export const TELEGRAM_OUTBOX_COOLDOWN_MS = parseInt(process.env.TELEGRAM_OUTBOX_COOLDOWN_MS || '10000', 10)

/** Path to the Piper TTS Python script. Override via PIPER_SCRIPT env. */
const projectPiperScript = resolve(join(getProjectRoot(), 'scripts', 'piper_speak.py'))
const workspacePiperScript = resolve(join(WORKSPACE_ROOT, 'scripts', 'piper_speak.py'))

/**
 * 确保 `<userData>/scripts/piper_speak.py` 是**当前版本**的脚本，返回其路径。
 *
 * 为什么需要它：打包版的 `PIPER_SCRIPT` 指向 userData 下的脚本副本，但历史上**没有任何
 * 机制把这个文件同步过去**，于是 userData 里可能躺着任意旧版本。实测踩到的正是这个：
 * 一份 6 月的旧脚本用 `PIPER_MODEL_PATH` 环境变量取模型路径、且硬编码回落到
 * `D:\work\code\akemi-mio\models\...`，而主进程传的是 `--model <路径>` CLI 参数 ——
 * 旧脚本根本不认，直接按硬编码路径找模型，报
 * `FileNotFoundError: ...D:\work\code\akemi-mio\models\piper\zh_CN-huayan-medium.onnx.json`。
 * （解释器已经修对了，但 TTS 仍然不可用，就是被这一层挡住的。）
 *
 * 做法：以 `process.resourcesPath/scripts/piper_speak.py`（electron-builder 的
 * extraResources 产物）为准，内容不同就覆盖 userData 的副本。开发态下
 * resourcesPath 不存在，退回仓库里的 `scripts/piper_speak.py`。
 *
 * 同步是**懒执行**的：只在真正要用脚本时调一次（结果做模块级缓存），
 * 避免给 89 个 import 本模块的文件增加启动开销。
 */
let _piperScript: string | undefined

export function resolvePiperScript(): string {
  if (_piperScript !== undefined) return _piperScript
  const explicit = process.env.PIPER_SCRIPT
  if (explicit) {
    _piperScript = explicit
    return _piperScript
  }

  // 开发态：仓库里的脚本就是最新的，直接用，不折腾 userData。
  if (!isPackagedApp()) {
    _piperScript = existsSync(projectPiperScript) ? projectPiperScript : workspacePiperScript
    return _piperScript
  }

  // 打包态：以随包发布的副本为准，同步到 userData 后再执行。
  const bundled = join(process.resourcesPath || '', 'scripts', 'piper_speak.py')
  if (!existsSync(bundled)) {
    // 没随包带上（旧的打包配置）——只能退回 userData 现有副本。
    _piperScript = workspacePiperScript
    return _piperScript
  }

  try {
    const current = existsSync(workspacePiperScript) ? readFileSync(workspacePiperScript, 'utf8') : ''
    const incoming = readFileSync(bundled, 'utf8')
    if (current !== incoming) {
      mkdirSync(dirname(workspacePiperScript), { recursive: true })
      copyFileSync(bundled, workspacePiperScript)
    }
    _piperScript = workspacePiperScript
  } catch {
    // 同步失败就退回落仓库路径（开发态能跑），不要因为 TTS 脚本让启动失败。
    _piperScript = existsSync(projectPiperScript) ? projectPiperScript : workspacePiperScript
  }
  return _piperScript
}

/**
 * @deprecated 用 `resolvePiperScript()`。
 *
 * 这个常量在**模块加载期**就求值，而 `getElectronApp()` 此刻往往还没拿到 electron 的
 * `app`（`WORKSPACE_ROOT` 会退化到 `process.cwd()`），打包版因此可能落到仓库路径。
 * 保留导出只为兼容既有 import；新代码请用函数。
 */
export const PIPER_SCRIPT =
  process.env.PIPER_SCRIPT || (!isPackagedApp() && existsSync(projectPiperScript) ? projectPiperScript : workspacePiperScript)
/**
 * Piper / ComfyUI 使用的 Python 解释器。Override via PIPER_PYTHON env.
 *
 * 这是**懒解析**：解释器探测要 spawn 子进程，若在模块加载期执行，89 个 import
 * 本模块的文件都会白付一次代价。改成函数后，只在真正要起子进程时才探一次
 * （resolvePiperPython 内部缓存结果）。调用点本来就在函数体里取值，无破坏。
 */
export function piperPython(): string {
  return resolvePiperPython()
}
/** Path to the Piper TTS model. Override via PIPER_MODEL env. */
export const PIPER_MODEL = process.env.PIPER_MODEL || resolve(join(WORKSPACE_ROOT, 'models', 'piper', 'zh_CN-huayan-medium.onnx'))
/** Whether to prefer local Piper TTS over cloud TTS. Set USE_LOCAL_TTS=true to enable. */
export const USE_LOCAL_TTS = process.env.USE_LOCAL_TTS === 'true'

// ══════════════════════════════════════════
//  TTS Router — 混合 TTS 智能路由配置
// ══════════════════════════════════════════

/** TTS 路由：网络延迟阈值（ms），高于此值倾向本地引擎。Override via TTS_ROUTER_MAX_LATENCY_MS env. */
export const TTS_ROUTER_MAX_LATENCY_MS = parseInt(process.env.TTS_ROUTER_MAX_LATENCY_MS || '400', 10)
/** TTS 路由：网络检测超时（ms）。Override via TTS_ROUTER_PING_TIMEOUT_MS env. */
export const TTS_ROUTER_PING_TIMEOUT_MS = parseInt(process.env.TTS_ROUTER_PING_TIMEOUT_MS || '3000', 10)
/** TTS 路由：网络检测缓存 TTL（ms）。Override via TTS_ROUTER_CACHE_TTL_MS env. */
export const TTS_ROUTER_CACHE_TTL_MS = parseInt(process.env.TTS_ROUTER_CACHE_TTL_MS || '5000', 10)
/** TTS 路由：默认质量权重（0-1）。Override via TTS_ROUTER_QUALITY_WEIGHT env. */
export const TTS_ROUTER_QUALITY_WEIGHT = parseFloat(process.env.TTS_ROUTER_QUALITY_WEIGHT || '0.6')
/** TTS 路由：默认延迟权重（0-1）。Override via TTS_ROUTER_LATENCY_WEIGHT env. */
export const TTS_ROUTER_LATENCY_WEIGHT = parseFloat(process.env.TTS_ROUTER_LATENCY_WEIGHT || '0.4')
/** TTS 路由：良好网络延迟阈值（ms），低于此值视为网络良好。Override via TTS_ROUTER_GOOD_LATENCY_MS env. */
export const TTS_ROUTER_GOOD_LATENCY_MS = parseInt(process.env.TTS_ROUTER_GOOD_LATENCY_MS || '150', 10)

/** Default safety mode for SelfEvolution. 'review' = plan-only (default), 'auto' = plan + auto-execute.
 *  Override via EVOLUTION_SAFETY_MODE=auto in .env */
export const EVOLUTION_SAFETY_MODE: 'review' | 'auto' = process.env.EVOLUTION_SAFETY_MODE === 'auto' ? 'auto' : 'review'

/** Ordered list of paths to search for ffmpeg. Override via FFMPEG_PATH env. */
export const FFMPEG_PATHS = process.env.FFMPEG_PATH ? [process.env.FFMPEG_PATH] : ['ffmpeg', 'C:\\ffmpeg\\bin\\ffmpeg.exe']

/** Hotwords appended to ASR prompts for improved recognition. Override via ASR_HOTWORDS env (comma-separated). */
export const ASR_HOTWORDS = process.env.ASR_HOTWORDS
  ? process.env.ASR_HOTWORDS.split(',').map((w) => w.trim())
  : [
      'Agent',
      'MCP',
      'LangGraph',
      'Cursor',
      'OpenRouter',
      'DeepSeek',
      '秋山澪',
      '贝斯',
      '音阶',
      '和弦',
      '旋律',
      '小确幸',
      '巴赫',
      '轻音',
      '晚安',
      '踏实',
      '陪伴',
      '温柔',
      '练习',
      '享受',
      '密钥',
      '字幕',
      // ── TypeScript 高级类型术语 ──
      '泛型',
      '条件类型',
      '映射类型',
      '类型守卫',
      '类型推断',
      '工具类型',
      '模板字面量类型',
      'Generic',
      'Conditional Types',
      'Mapped Types',
      'Type Guards',
      'Utility Types',
      'Infer',
      'Keyof',
      'Typeof',
      'Partial',
      'Required',
      'Pick',
      'Omit',
      'Record',
      'Exclude',
      'Extract',
      'ReturnType',
      'Parameters',
      'Awaited',
      'Template Literal Types',
    ]

/** Target sample rate for ASR audio processing (Hz). */
export const ASR_SAMPLE_RATE = 16000
/** Maximum duration of audio sent to ASR in a single request (seconds). */
export const ASR_MAX_AUDIO_SECONDS = 25

/** Wake words that trigger conversation mode. Override via WAKE_WORDS env (comma-separated). */
export const WAKE_WORDS = process.env.WAKE_WORDS
  ? process.env.WAKE_WORDS.split(',').map((w) => w.trim())
  : ['澪', '秋山澪', 'mio', 'Mio', '开始对话']

/** Main window width in pixels. Override via WINDOW_WIDTH env. */
export const WINDOW_WIDTH = parseInt(process.env.WINDOW_WIDTH || '420', 10)
/** Main window height in pixels. Override via WINDOW_HEIGHT env. */
export const WINDOW_HEIGHT = parseInt(process.env.WINDOW_HEIGHT || '640', 10)

/** Directory for GGML model files. Override via GGML_MODELS_DIR env. */
export const GGML_MODELS_DIR = process.env.GGML_MODELS_DIR || resolve(join(WORKSPACE_ROOT, 'models', 'ggml'))

/** Hotwords used for initial ASR configuration. Override via HOTWORDS env (comma-separated). */
export const INITIAL_HOTWORDS = process.env.HOTWORDS
  ? process.env.HOTWORDS.split(',').map((w) => w.trim())
  : ['贝斯', '音阶', '空弦', '指型', '把位', '小确幸', '巴赫', '轻音', '和弦', '旋律', '节奏', '密钥', 'DeepSeek', '字幕']

/** Initial prompt for Whisper ASR to bias recognition towards domain terms. Override via ASR_INITIAL_PROMPT env. */
export const ASR_INITIAL_PROMPT =
  process.env.ASR_INITIAL_PROMPT || '以下是关于泵站设备、音乐练习、日常陪伴、API密钥和TypeScript高级类型学习的语音对话'

/** 行为驱动热词增强：分析窗口大小（最近 N 次交互）。Override via ASR_HOTWORD_WINDOW_SIZE env. */
export const ASR_HOTWORD_WINDOW_SIZE = parseInt(process.env.ASR_HOTWORD_WINDOW_SIZE || '16', 10)
/** 行为驱动热词增强：词汇出现次数 >= 此值视为热词。Override via ASR_HOTWORD_FREQ_THRESHOLD env. */
export const ASR_HOTWORD_FREQ_THRESHOLD = parseInt(process.env.ASR_HOTWORD_FREQ_THRESHOLD || '3', 10)
/** 行为驱动热词增强：最大热词数量（避免过多热词降低其他词识别率）。Override via ASR_HOTWORD_MAX_COUNT env. */
export const ASR_HOTWORD_MAX_COUNT = parseInt(process.env.ASR_HOTWORD_MAX_COUNT || '15', 10)

// ══════════════════════════════════════════
//  行为驱动记忆加权配置
// ══════════════════════════════════════════

/** 行为加权分析窗口大小（最近 N 次交互）。Override via BEHAVIOR_WEIGHT_WINDOW_SIZE env. */
export const BEHAVIOR_WEIGHT_WINDOW_SIZE = parseInt(process.env.BEHAVIOR_WEIGHT_WINDOW_SIZE || '16', 10)

/** 兴趣时间衰减速率（0-1，每步衰减）。Override via BEHAVIOR_WEIGHT_RECENCY_DECAY env. */
export const BEHAVIOR_WEIGHT_RECENCY_DECAY = parseFloat(process.env.BEHAVIOR_WEIGHT_RECENCY_DECAY || '0.92')

/** 基础提升因子（0-1，兴趣匹配最大额外加分）。Override via BEHAVIOR_WEIGHT_BASE_BOOST env. */
export const BEHAVIOR_WEIGHT_BASE_BOOST = parseFloat(process.env.BEHAVIOR_WEIGHT_BASE_BOOST || '0.3')

/** 最小兴趣强度阈值（低于此值的主题不参与加权）。Override via BEHAVIOR_WEIGHT_MIN_STRENGTH env. */
export const BEHAVIOR_WEIGHT_MIN_STRENGTH = parseFloat(process.env.BEHAVIOR_WEIGHT_MIN_STRENGTH || '2.0')

/** 兴趣更新间隔（毫秒）。Override via BEHAVIOR_WEIGHT_UPDATE_INTERVAL env. */
export const BEHAVIOR_WEIGHT_UPDATE_INTERVAL = parseInt(process.env.BEHAVIOR_WEIGHT_UPDATE_INTERVAL || '60000', 10)

/** 行为强化记忆巩固：每次强化 boost 量（0-1）。Override via BEHAVIOR_REINFORCE_BOOST env. */
export const BEHAVIOR_REINFORCE_BOOST = parseFloat(process.env.BEHAVIOR_REINFORCE_BOOST || '0.08')

/** 行为强化记忆巩固：最小相似度阈值（0-1）。Override via BEHAVIOR_REPEAT_SIMILARITY_THRESHOLD env. */
export const BEHAVIOR_REPEAT_SIMILARITY_THRESHOLD = parseFloat(process.env.BEHAVIOR_REPEAT_SIMILARITY_THRESHOLD || '0.55')

/** 行为强化记忆巩固：重复检测窗口大小（最近 N 条消息）。Override via BEHAVIOR_REPEAT_DETECTION_WINDOW env. */
export const BEHAVIOR_REPEAT_DETECTION_WINDOW = parseInt(process.env.BEHAVIOR_REPEAT_DETECTION_WINDOW || '8', 10)

// ══════════════════════════════════════════
//  记忆驱动工具调用引擎配置
// ══════════════════════════════════════════

/**
 * 记忆驱动工具个性化强度级别。
 * - 'off'：禁用记忆驱动的工具推荐
 * - 'conservative'：保守策略，仅在高置信度时影响（默认）
 * - 'balanced'：平衡策略，中等记忆影响工具排序和参数填充
 * - 'aggressive'：激进策略，最大限度利用记忆优化工具选择
 *
 * Override via MEMORY_TOOL_PERSONALIZATION env.
 */
export const MEMORY_TOOL_PERSONALIZATION: 'off' | 'conservative' | 'balanced' | 'aggressive' = [
  'off',
  'conservative',
  'balanced',
  'aggressive',
].includes(process.env.MEMORY_TOOL_PERSONALIZATION || '')
  ? (process.env.MEMORY_TOOL_PERSONALIZATION as any)
  : 'conservative'

/**
 * 记忆驱动工具推荐的最小数据量阈值。
 * 当工具调用记录数低于此值时，使用保守策略以避免噪声推荐。
 * Override via MEMORY_TOOL_MIN_RECORDS env.
 */
export const MEMORY_TOOL_MIN_RECORDS = parseInt(process.env.MEMORY_TOOL_MIN_RECORDS || '5', 10)

/**
 * 记忆驱动工具推荐中最高优先级 boost 倍数。
 * 高频工具在工具列表中的排序偏移量（影响 LLM 的选择倾向）。
 * Override via MEMORY_TOOL_BOOST_FACTOR env.
 */
export const MEMORY_TOOL_BOOST_FACTOR = parseInt(process.env.MEMORY_TOOL_BOOST_FACTOR || '3', 10)

/**
 * 工具调用成功率统计窗口大小（最近 N 次调用）。
 * Override via MEMORY_TOOL_STAT_WINDOW env.
 */
export const MEMORY_TOOL_STAT_WINDOW = parseInt(process.env.MEMORY_TOOL_STAT_WINDOW || '50', 10)

// ══════════════════════════════════════════
//  记忆效用跟踪与动态清理配置
// ══════════════════════════════════════════

/**
 * 效用跟踪：Agent 引用检测的相似度阈值（bigram Jaccard）。
 * Override via UTILITY_REFERENCE_SIMILARITY env.
 */
export const UTILITY_REFERENCE_SIMILARITY = parseFloat(process.env.UTILITY_REFERENCE_SIMILARITY || '0.3')

/**
 * 效用跟踪：Agent 每次引用的效用增量。
 * Override via UTILITY_AGENT_REFERENCE_BOOST env.
 */
export const UTILITY_AGENT_REFERENCE_BOOST = parseFloat(process.env.UTILITY_AGENT_REFERENCE_BOOST || '0.08')

/**
 * 效用跟踪：用户确认有用的效用增量。
 * Override via UTILITY_USER_CONFIRM_BOOST env.
 */
export const UTILITY_USER_CONFIRM_BOOST = parseFloat(process.env.UTILITY_USER_CONFIRM_BOOST || '0.15')

/**
 * 效用跟踪：每日效用衰减率。
 * Override via UTILITY_DAILY_DECAY env.
 */
export const UTILITY_DAILY_DECAY = parseFloat(process.env.UTILITY_DAILY_DECAY || '0.02')

/**
 * 效用跟踪：低效用阈值（低于此值可被清理）。
 * Override via UTILITY_LOW_THRESHOLD env.
 */
export const UTILITY_LOW_THRESHOLD = parseFloat(process.env.UTILITY_LOW_THRESHOLD || '0.15')

/**
 * 效用跟踪：清理检查间隔（毫秒），默认 24 小时。
 * Override via UTILITY_CLEANUP_INTERVAL env.
 */
export const UTILITY_CLEANUP_INTERVAL = parseInt(process.env.UTILITY_CLEANUP_INTERVAL || String(24 * 60 * 60 * 1000), 10)

/**
 * 效用跟踪：每次清理最多删除的记忆数。
 * Override via UTILITY_MAX_CLEANUP env.
 */
export const UTILITY_MAX_CLEANUP = parseInt(process.env.UTILITY_MAX_CLEANUP || '20', 10)

// ══════════════════════════════════════════
//  行为驱动工具预激活配置
// ══════════════════════════════════════════

/**
 * 行为预激活引擎：滑动窗口大小（最近 N 次工具调用）。
 * Override via BEHAVIOR_PREDICTOR_WINDOW_SIZE env.
 */
export const BEHAVIOR_PREDICTOR_WINDOW_SIZE = parseInt(process.env.BEHAVIOR_PREDICTOR_WINDOW_SIZE || '12', 10)

/**
 * 行为预激活引擎：最小序列长度（小于此值不构成有意义模式）。
 * Override via BEHAVIOR_PREDICTOR_MIN_SEQUENCE_LENGTH env.
 */
export const BEHAVIOR_PREDICTOR_MIN_SEQUENCE_LENGTH = parseInt(process.env.BEHAVIOR_PREDICTOR_MIN_SEQUENCE_LENGTH || '2', 10)

/**
 * 行为预激活引擎：模式被认定有效的最小出现次数。
 * Override via BEHAVIOR_PREDICTOR_MIN_PATTERN_FREQUENCY env.
 */
export const BEHAVIOR_PREDICTOR_MIN_PATTERN_FREQUENCY = parseInt(process.env.BEHAVIOR_PREDICTOR_MIN_PATTERN_FREQUENCY || '2', 10)

/**
 * 行为预激活引擎：触发预加载的置信度阈值 (0-1)。
 * Override via BEHAVIOR_PREDICTOR_PRELOAD_CONFIDENCE env.
 */
export const BEHAVIOR_PREDICTOR_PRELOAD_CONFIDENCE = parseFloat(process.env.BEHAVIOR_PREDICTOR_PRELOAD_CONFIDENCE || '0.35')

/**
 * 行为预激活引擎：预加载结果 TTL（毫秒）。
 * Override via BEHAVIOR_PREDICTOR_PRELOAD_TTL_MS env.
 */
export const BEHAVIOR_PREDICTOR_PRELOAD_TTL_MS = parseInt(process.env.BEHAVIOR_PREDICTOR_PRELOAD_TTL_MS || '120000', 10)

/**
 * 行为预激活引擎：预加载缓存最大条目数。
 * Override via BEHAVIOR_PREDICTOR_PRELOAD_CACHE_MAX env.
 */
export const BEHAVIOR_PREDICTOR_PRELOAD_CACHE_MAX = parseInt(process.env.BEHAVIOR_PREDICTOR_PRELOAD_CACHE_MAX || '50', 10)

/**
 * 行为预激活引擎：异步预加载超时（毫秒）。
 * Override via BEHAVIOR_PREDICTOR_PRELOAD_TIMEOUT_MS env.
 */
export const BEHAVIOR_PREDICTOR_PRELOAD_TIMEOUT_MS = parseInt(process.env.BEHAVIOR_PREDICTOR_PRELOAD_TIMEOUT_MS || '10000', 10)

/**
 * 行为预激活引擎：最大并发预加载任务数。
 * Override via BEHAVIOR_PREDICTOR_MAX_CONCURRENT_PRELOADS env.
 */
export const BEHAVIOR_PREDICTOR_MAX_CONCURRENT_PRELOADS = parseInt(process.env.BEHAVIOR_PREDICTOR_MAX_CONCURRENT_PRELOADS || '3', 10)

// ══════════════════════════════════════════
//  话题转移预测与记忆预取配置
// ══════════════════════════════════════════

/**
 * 话题转移预测器：分析窗口大小（最近 N 次交互用于话题序列）。
 * Override via TOPIC_TRANSITION_WINDOW_SIZE env.
 */
export const TOPIC_TRANSITION_WINDOW_SIZE = parseInt(process.env.TOPIC_TRANSITION_WINDOW_SIZE || '32', 10)

/**
 * 话题转移预测器：最小转移出现次数（低于此值不构成有效模式）。
 * Override via TOPIC_TRANSITION_MIN_FREQUENCY env.
 */
export const TOPIC_TRANSITION_MIN_FREQUENCY = parseInt(process.env.TOPIC_TRANSITION_MIN_FREQUENCY || '2', 10)

/**
 * 话题转移预测器：触发预取的最小概率 (0-1)。
 * Override via TOPIC_TRANSITION_PREFETCH_MIN_PROB env.
 */
export const TOPIC_TRANSITION_PREFETCH_MIN_PROB = parseFloat(process.env.TOPIC_TRANSITION_PREFETCH_MIN_PROB || '0.15')

/**
 * 话题转移预测器：每次预取最多返回的记忆数。
 * Override via TOPIC_TRANSITION_PREFETCH_MAX_ENTRIES env.
 */
export const TOPIC_TRANSITION_PREFETCH_MAX_ENTRIES = parseInt(process.env.TOPIC_TRANSITION_PREFETCH_MAX_ENTRIES || '5', 10)

/**
 * 话题转移预测器：预取缓存 TTL（毫秒）。
 * Override via TOPIC_TRANSITION_PREFETCH_TTL_MS env.
 */
export const TOPIC_TRANSITION_PREFETCH_TTL_MS = parseInt(process.env.TOPIC_TRANSITION_PREFETCH_TTL_MS || '60000', 10)

/**
 * 话题转移预测器：预取缓存最大条目数。
 * Override via TOPIC_TRANSITION_PREFETCH_CACHE_MAX env.
 */
export const TOPIC_TRANSITION_PREFETCH_CACHE_MAX = parseInt(process.env.TOPIC_TRANSITION_PREFETCH_CACHE_MAX || '20', 10)

// ══════════════════════════════════════════
//  行为驱动记忆填充（BehaviorDrivenMemoryAnalyzer）配置
// ══════════════════════════════════════════

/**
 * 行为驱动记忆分析器：分析周期（毫秒），默认 2 小时。
 * Override via BEHAVIOR_MEMORY_ANALYZER_INTERVAL env.
 */
export const BEHAVIOR_MEMORY_ANALYZER_INTERVAL = parseInt(process.env.BEHAVIOR_MEMORY_ANALYZER_INTERVAL || String(2 * 60 * 60 * 1000), 10)

/**
 * 行为驱动记忆分析器：分析窗口大小（最近 N 次交互）。
 * Override via BEHAVIOR_MEMORY_ANALYZER_WINDOW env.
 */
export const BEHAVIOR_MEMORY_ANALYZER_WINDOW = parseInt(process.env.BEHAVIOR_MEMORY_ANALYZER_WINDOW || '70', 10)

/**
 * 行为驱动记忆分析器：TF-IDF 提取的高频词数量（top K）。
 * Override via BEHAVIOR_MEMORY_TFIDF_TOP_K env.
 */
export const BEHAVIOR_MEMORY_TFIDF_TOP_K = parseInt(process.env.BEHAVIOR_MEMORY_TFIDF_TOP_K || '15', 10)

/**
 * 行为驱动记忆分析器：意图聚类数（K）。
 * Override via BEHAVIOR_MEMORY_INTENT_CLUSTERS env.
 */
export const BEHAVIOR_MEMORY_INTENT_CLUSTERS = parseInt(process.env.BEHAVIOR_MEMORY_INTENT_CLUSTERS || '4', 10)

/**
 * 行为驱动记忆分析器：活跃时段判定的 z-score 阈值。
 * Override via BEHAVIOR_MEMORY_PEAK_Z_SCORE env.
 */
export const BEHAVIOR_MEMORY_PEAK_Z_SCORE = parseFloat(process.env.BEHAVIOR_MEMORY_PEAK_Z_SCORE || '1.5')

/**
 * 行为驱动记忆分析器：最小交互数（低于此值不执行分析）。
 * Override via BEHAVIOR_MEMORY_MIN_INTERACTIONS env.
 */
export const BEHAVIOR_MEMORY_MIN_INTERACTIONS = parseInt(process.env.BEHAVIOR_MEMORY_MIN_INTERACTIONS || '10', 10)

/**
 * 行为驱动记忆分析器：每次周期最多新创建的条目数。
 * Override via BEHAVIOR_MEMORY_MAX_MEMORIES_PER_CYCLE env.
 */
export const BEHAVIOR_MEMORY_MAX_MEMORIES_PER_CYCLE = parseInt(process.env.BEHAVIOR_MEMORY_MAX_MEMORIES_PER_CYCLE || '8', 10)

/**
 * ?????????????
 * Override via BEHAVIOR_PATTERN_MATCH_MIN_CONFIDENCE env.
 */
export const BEHAVIOR_PATTERN_MATCH_MIN_CONFIDENCE = parseFloat(process.env.BEHAVIOR_PATTERN_MATCH_MIN_CONFIDENCE || '0.3')

/**
 * ????????????????????
 * Override via BEHAVIOR_PATTERN_MATCH_MAX_RESULTS env.
 */
export const BEHAVIOR_PATTERN_MATCH_MAX_RESULTS = parseInt(process.env.BEHAVIOR_PATTERN_MATCH_MAX_RESULTS || '3', 10)

/**
 * ?????????????????? 2 ???
 * Override via BEHAVIOR_PATTERN_ANALYZER_INTERVAL env.
 */
export const BEHAVIOR_PATTERN_ANALYZER_INTERVAL = parseInt(process.env.BEHAVIOR_PATTERN_ANALYZER_INTERVAL || String(2 * 60 * 60 * 1000), 10)

/**
 * ?????????????????????????
 * Override via BEHAVIOR_PATTERN_MIN_INTERACTIONS env.
 */
export const BEHAVIOR_PATTERN_MIN_INTERACTIONS = parseInt(process.env.BEHAVIOR_PATTERN_MIN_INTERACTIONS || '6', 10)

/**
 * ???????????????? N ?????
 * Override via BEHAVIOR_PATTERN_WINDOW_SIZE env.
 */
export const BEHAVIOR_PATTERN_WINDOW_SIZE = parseInt(process.env.BEHAVIOR_PATTERN_WINDOW_SIZE || '30', 10)

/**
 * ?????????????????
 * Override via BEHAVIOR_PATTERN_DECAY_RATE env.
 */
export const BEHAVIOR_PATTERN_DECAY_RATE = parseFloat(process.env.BEHAVIOR_PATTERN_DECAY_RATE || '0.97')

/**
 * ?????????????????
 * Override via BEHAVIOR_PATTERN_MIN_CONFIDENCE env.
 */
export const BEHAVIOR_PATTERN_MIN_CONFIDENCE = parseFloat(process.env.BEHAVIOR_PATTERN_MIN_CONFIDENCE || '0.15')

/**
 * ????????????????????????
 * Override via BEHAVIOR_PATTERN_DECAY_INTERVAL env.
 */
export const BEHAVIOR_PATTERN_DECAY_INTERVAL = parseInt(process.env.BEHAVIOR_PATTERN_DECAY_INTERVAL || String(24 * 60 * 60 * 1000), 10)

/**
 * ?????????????
 * Override via BEHAVIOR_PATTERN_MAX_RULES env.
 */
export const BEHAVIOR_PATTERN_MAX_RULES = parseInt(process.env.BEHAVIOR_PATTERN_MAX_RULES || '200', 10)

// ══════════════════════════════════════════
//  博客时光机（Plan Memory Blog）配置
// ══════════════════════════════════════════

/**
 * 博客时光机总开关（默认开启）。设置为 'false' 禁用。
 * Override via BLOG_MEMORY_ENABLED env.
 */
export const BLOG_MEMORY_ENABLED = process.env.BLOG_MEMORY_ENABLED !== 'false'

/**
 * 博客时光机：最大存储条目数。
 * Override via BLOG_MEMORY_MAX_ENTRIES env.
 */
export const BLOG_MEMORY_MAX_ENTRIES = parseInt(process.env.BLOG_MEMORY_MAX_ENTRIES || '200', 10)

/**
 * 博客时光机：单条内容最大长度（字符数）。
 * Override via BLOG_MEMORY_MAX_CONTENT_LENGTH env.
 */
export const BLOG_MEMORY_MAX_CONTENT_LENGTH = parseInt(process.env.BLOG_MEMORY_MAX_CONTENT_LENGTH || '500', 10)

/**
 * 博客时光机：默认记忆层级。
 * Override via BLOG_MEMORY_DEFAULT_TIER env.
 */
export const BLOG_MEMORY_DEFAULT_TIER: 'permanent' | 'semi' | 'ephemeral' = (['permanent', 'semi', 'ephemeral'] as const).includes(
  process.env.BLOG_MEMORY_DEFAULT_TIER as any,
)
  ? (process.env.BLOG_MEMORY_DEFAULT_TIER as 'permanent' | 'semi' | 'ephemeral')
  : 'semi'

/**
 * 博客时光机：默认置信度。
 * Override via BLOG_MEMORY_DEFAULT_CONFIDENCE env.
 */
export const BLOG_MEMORY_DEFAULT_CONFIDENCE = parseFloat(process.env.BLOG_MEMORY_DEFAULT_CONFIDENCE || '0.8')

// ══════════════════════════════════════════
//  智能记忆休眠与预唤醒配置
// ══════════════════════════════════════════

/**
 * 空闲阈值：连续无交互超过此时间触发记忆整理（毫秒）。
 * 默认 2 小时。Override via MEMORY_SLEEP_IDLE_THRESHOLD_MS env.
 */
export const MEMORY_SLEEP_IDLE_THRESHOLD_MS = parseInt(process.env.MEMORY_SLEEP_IDLE_THRESHOLD_MS || String(2 * 60 * 60 * 1000), 10)

/**
 * 低频判定：超过此天数未访问视为低频记忆。
 * 默认 7 天。Override via MEMORY_SLEEP_LOW_FREQUENCY_DAYS env.
 */
export const MEMORY_SLEEP_LOW_FREQUENCY_DAYS = parseInt(process.env.MEMORY_SLEEP_LOW_FREQUENCY_DAYS || '7', 10)

/**
 * 整理检查间隔（毫秒）。
 * 默认 30 分钟。Override via MEMORY_SLEEP_CHECK_INTERVAL_MS env.
 */
export const MEMORY_SLEEP_CHECK_INTERVAL_MS = parseInt(process.env.MEMORY_SLEEP_CHECK_INTERVAL_MS || String(30 * 60 * 1000), 10)

/**
 * 预加载提前量（分钟）：在预测活跃时段前此时间开始加载记忆到缓存。
 * 默认 10 分钟。Override via MEMORY_SLEEP_PRELOAD_AHEAD_MINUTES env.
 */
export const MEMORY_SLEEP_PRELOAD_AHEAD_MINUTES = parseInt(process.env.MEMORY_SLEEP_PRELOAD_AHEAD_MINUTES || '10', 10)

/**
 * 活跃时段滑动窗口天数。
 * 默认 14 天。Override via MEMORY_SLEEP_ACTIVITY_WINDOW_DAYS env.
 */
export const MEMORY_SLEEP_ACTIVITY_WINDOW_DAYS = parseInt(process.env.MEMORY_SLEEP_ACTIVITY_WINDOW_DAYS || '14', 10)

/**
 * 最小数据天数：活跃数据不足此天数时不进行预测。
 * 默认 3 天。Override via MEMORY_SLEEP_MIN_ACTIVITY_DAYS env.
 */
export const MEMORY_SLEEP_MIN_ACTIVITY_DAYS = parseInt(process.env.MEMORY_SLEEP_MIN_ACTIVITY_DAYS || '3', 10)

/**
 * 高频记忆判定阈值：当日活跃时段中至少出现此天数才被视为高频。
 * 默认 3 天。Override via MEMORY_SLEEP_HIGH_FREQ_THRESHOLD env.
 */
export const MEMORY_SLEEP_HIGH_FREQ_THRESHOLD = parseInt(process.env.MEMORY_SLEEP_HIGH_FREQ_THRESHOLD || '3', 10)

/**
 * 预加载缓存最大条目数。
 * 默认 15 条。Override via MEMORY_SLEEP_PRELOAD_CACHE_MAX env.
 */
export const MEMORY_SLEEP_PRELOAD_CACHE_MAX = parseInt(process.env.MEMORY_SLEEP_PRELOAD_CACHE_MAX || '15', 10)

/**
 * 预加载缓存 TTL（毫秒）：超过此时间缓存失效。
 * 默认 30 分钟。Override via MEMORY_SLEEP_PRELOAD_CACHE_TTL_MS env.
 */
export const MEMORY_SLEEP_PRELOAD_CACHE_TTL_MS = parseInt(process.env.MEMORY_SLEEP_PRELOAD_CACHE_TTL_MS || String(30 * 60 * 1000), 10)

/**
 * 空闲时单次压缩最多处理的记忆数。
 * 默认 50 条。Override via MEMORY_SLEEP_MAX_COMPRESS env.
 */
export const MEMORY_SLEEP_MAX_COMPRESS = parseInt(process.env.MEMORY_SLEEP_MAX_COMPRESS || '50', 10)
