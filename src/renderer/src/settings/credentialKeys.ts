export const CRED_KEYS = {
  LLM_KEY: 'llm_key',
  LLM_API_URL: 'llm_api_url',
  LLM_CHAT_MODEL: 'llm_chat_model',
  LLM_CODE_API_URL: 'llm_code_api_url',
  LLM_CODE_MODEL: 'llm_code_model',
  TTS_MODE: 'tts_mode',
  THEME: 'theme',
  WAKE_WORDS: 'wake_words',
  ASR_HOTWORDS: 'asr_hotwords',
  ASR_INITIAL_PROMPT: 'asr_initial_prompt',
  EVOLUTION_SAFETY_MODE: 'evolution_safety_mode',
} as const

export const ALL_SETTING_KEYS: readonly string[] = Object.values(CRED_KEYS)
