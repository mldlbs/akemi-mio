/** Layer 0 — Runtime Kernel 安装目录（只读） */
export declare const RUNTIME_ROOT: string;
/** Layer 1 — Mio Workspace 根目录（app.getPath('userData') 即 %APPDATA%/akemi-mio/） */
export declare const WORKSPACE_ROOT: string;
/** Layer 2 — 工作区子目录 */
export declare const WORKSPACE: {
    readonly projects: string;
    readonly memory: string;
    readonly knowledge: string;
    readonly skills: string;
    readonly workflows: string;
    readonly proposals: string;
    readonly logs: string;
    readonly cache: string;
    readonly evolution: string;
};
/** 开发模式：允许额外读取项目源码目录。仅当明确设置环境变量时启用。 */
export declare const DEV_PROJECT_ROOT: string;
/** LLM API endpoint URL for chat/conversation. Override via LLM_API_URL env. */
export declare const LLM_API_URL: string;
/** LLM API endpoint URL for code/tool-calling. Falls back to LLM_API_URL if not set. Override via LLM_CODE_API_URL env. */
export declare const LLM_CODE_API_URL: string;
/** LLM model for casual conversation & intent classification. Override via LLM_CHAT_MODEL env. */
export declare const LLM_CHAT_MODEL: string;
/** LLM model for tool calling, code generation, and development tasks. Override via LLM_CODE_MODEL env. */
export declare const LLM_CODE_MODEL: string;
/** @deprecated Use LLM_CHAT_MODEL / LLM_CODE_MODEL individually. */
export declare const LLM_MODEL: string;
/** LLM API endpoint URL for vision/multimodal (image understanding). Override via LLM_VISION_API_URL env. */
export declare const LLM_VISION_API_URL: string;
/** LLM model for vision/multimodal tasks. Override via LLM_VISION_MODEL env. */
export declare const LLM_VISION_MODEL: string;
/** API key for vision model. Falls back to LLM_KEY if not set. Override via LLM_VISION_KEY env. */
export declare const LLM_VISION_KEY: string;
/** LLM API endpoint URL for text processing (summarization, extraction, rewriting, embedding). Override via LLM_TEXT_API_URL env. */
export declare const LLM_TEXT_API_URL: string;
/** LLM model for text processing tasks. Override via LLM_TEXT_MODEL env. */
export declare const LLM_TEXT_MODEL: string;
/** API key for text processing model. Falls back to LLM_KEY if not set. Override via LLM_TEXT_KEY env. */
export declare const LLM_TEXT_KEY: string;
/** API endpoint URL for image generation. Override via LLM_IMAGE_API_URL env. */
export declare const LLM_IMAGE_API_URL: string;
/** API key for image generation model. Override via LLM_IMAGE_KEY env. */
export declare const LLM_IMAGE_KEY: string;
/** Model name for image generation (CogView-3-Flash by default). Override via LLM_IMAGE_MODEL env. */
export declare const LLM_IMAGE_MODEL: string;
/** Ordered list of paths to search for ffplay. Override via FFPLAY_PATH env.
 *  Default searches common install locations and the system PATH.
 *  The 'ffplay' bare entry at the end relies on PATH resolution. */
export declare const FFPLAY_PATHS: string[];
/** Path to the Piper TTS Python script. Override via PIPER_SCRIPT env. */
export declare const PIPER_SCRIPT: string;
/** Path to the Piper TTS model. Override via PIPER_MODEL env. */
export declare const PIPER_MODEL: string;
/** Whether to prefer local Piper TTS over cloud TTS. Set USE_LOCAL_TTS=true to enable. */
export declare const USE_LOCAL_TTS: boolean;
/** Default safety mode for SelfEvolution. 'review' = plan-only (default), 'auto' = plan + auto-execute.
 *  Override via EVOLUTION_SAFETY_MODE=auto in .env */
export declare const EVOLUTION_SAFETY_MODE: 'review' | 'auto';
/** Ordered list of paths to search for ffmpeg. Override via FFMPEG_PATH env. */
export declare const FFMPEG_PATHS: string[];
/** Hotwords appended to ASR prompts for improved recognition. Override via ASR_HOTWORDS env (comma-separated). */
export declare const ASR_HOTWORDS: string[];
/** Target sample rate for ASR audio processing (Hz). */
export declare const ASR_SAMPLE_RATE = 16000;
/** Maximum duration of audio sent to ASR in a single request (seconds). */
export declare const ASR_MAX_AUDIO_SECONDS = 25;
/** Wake words that trigger conversation mode. Override via WAKE_WORDS env (comma-separated). */
export declare const WAKE_WORDS: string[];
/** Main window width in pixels. Override via WINDOW_WIDTH env. */
export declare const WINDOW_WIDTH: number;
/** Main window height in pixels. Override via WINDOW_HEIGHT env. */
export declare const WINDOW_HEIGHT: number;
/** Directory for GGML model files. Override via GGML_MODELS_DIR env. */
export declare const GGML_MODELS_DIR: string;
/** Hotwords used for initial ASR configuration. Override via HOTWORDS env (comma-separated). */
export declare const INITIAL_HOTWORDS: string[];
/** Initial prompt for Whisper ASR to bias recognition towards domain terms. Override via ASR_INITIAL_PROMPT env. */
export declare const ASR_INITIAL_PROMPT: string;
