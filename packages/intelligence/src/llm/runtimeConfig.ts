import { app } from 'electron'

import {
  LLM_API_URL,
  LLM_CHAT_MODEL,
  LLM_CODE_API_URL,
  LLM_CODE_MODEL,
  LLM_KEY,
  LLM_TEXT_API_URL,
  LLM_TEXT_KEY,
  LLM_TEXT_MODEL,
  LLM_VISION_API_URL,
  LLM_VISION_KEY,
  LLM_VISION_MODEL,
} from '@akemi-mio/core/config'
import { credentialsManager } from '@akemi-mio/core/credentials/CredentialsManager'

export interface RuntimeLlmEndpointConfig {
  apiKey: string
  apiUrl: string
  model: string
}

export interface RuntimeLlmConfig {
  chat: RuntimeLlmEndpointConfig
  code: RuntimeLlmEndpointConfig
  text: RuntimeLlmEndpointConfig
  vision: RuntimeLlmEndpointConfig
}

interface RuntimeLlmConfigOptions {
  isPackaged?: boolean
  getCredential?: (key: string) => string | null
}

function isPackagedRuntime(): boolean {
  try {
    return !!app.isPackaged
  } catch {
    return false
  }
}

function trimOrEmpty(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function getRuntimeLlmConfig(options: RuntimeLlmConfigOptions = {}): RuntimeLlmConfig {
  const isPackaged = options.isPackaged ?? isPackagedRuntime()
  const getCredential = options.getCredential ?? ((key: string) => credentialsManager.get(key))

  if (!isPackaged) {
    const chatKey = trimOrEmpty(LLM_KEY)
    return {
      chat: {
        apiKey: chatKey,
        apiUrl: LLM_API_URL,
        model: LLM_CHAT_MODEL,
      },
      code: {
        apiKey: trimOrEmpty(process.env.LLM_CODE_KEY) || chatKey,
        apiUrl: LLM_CODE_API_URL,
        model: LLM_CODE_MODEL,
      },
      text: {
        apiKey: trimOrEmpty(LLM_TEXT_KEY) || chatKey,
        apiUrl: LLM_TEXT_API_URL,
        model: LLM_TEXT_MODEL,
      },
      vision: {
        apiKey: trimOrEmpty(LLM_VISION_KEY) || chatKey,
        apiUrl: LLM_VISION_API_URL,
        model: LLM_VISION_MODEL,
      },
    }
  }

  const chatKey = trimOrEmpty(getCredential('llm_key'))

  return {
    chat: {
      apiKey: chatKey,
      apiUrl: trimOrEmpty(getCredential('llm_api_url')) || LLM_API_URL,
      model: trimOrEmpty(getCredential('llm_chat_model')) || LLM_CHAT_MODEL,
    },
    code: {
      apiKey: trimOrEmpty(getCredential('llm_code_api_key')) || chatKey,
      apiUrl: trimOrEmpty(getCredential('llm_code_api_url')) || LLM_CODE_API_URL,
      model: trimOrEmpty(getCredential('llm_code_model')) || LLM_CODE_MODEL,
    },
    text: {
      apiKey: trimOrEmpty(getCredential('llm_text_key')) || chatKey,
      apiUrl: trimOrEmpty(getCredential('llm_text_api_url')) || LLM_TEXT_API_URL,
      model: trimOrEmpty(getCredential('llm_text_model')) || LLM_TEXT_MODEL,
    },
    vision: {
      apiKey: trimOrEmpty(getCredential('llm_vision_key')) || chatKey,
      apiUrl: trimOrEmpty(getCredential('llm_vision_api_url')) || LLM_VISION_API_URL,
      model: trimOrEmpty(getCredential('llm_vision_model')) || LLM_VISION_MODEL,
    },
  }
}
