import { resolve, join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { app } from 'electron'

function getProjectRoot(): string {
  try {
    return app.getAppPath()
  } catch {
    return process.cwd()
  }
}

function getUserDataDir(): string {
  if (process.env.USER_DATA_DIR) return process.env.USER_DATA_DIR
  try {
    return app.getPath('userData')
  } catch {
    return process.cwd()
  }
}

const userDataDir = getUserDataDir()

// ===== Runtime / Workspace 边界定义 =====
/** Layer 0 — Runtime Kernel 安装目录（只读） */
export const RUNTIME_ROOT = getProjectRoot()
/** Layer 1 — Mio Workspace 根目录（app.getPath('userData') 即 %APPDATA%/akemi-mio/） */
export const WORKSPACE_ROOT = userDataDir
/** Layer 2 — 工作区子目录 */
export const WORKSPACE = {
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

// 加载 .env：始终用 userData 目录
try {
  let envPath = join(userDataDir, '.env')
  if (!existsSync(envPath)) {
    envPath = join(getProjectRoot(), '.env')
  }
  if (existsSync(envPath)) {
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

/** Path to the Piper TTS Python script. Override via PIPER_SCRIPT env. */
export const PIPER_SCRIPT = process.env.PIPER_SCRIPT || resolve(join(WORKSPACE_ROOT, 'scripts', 'piper_speak.py'))
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
export const ASR_INITIAL_PROMPT = process.env.ASR_INITIAL_PROMPT || '以下是关于泵站设备、音乐练习、日常陪伴和API密钥的语音对话'

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
