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
