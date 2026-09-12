import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it, vi } from 'vitest'

const ENV_KEYS = [
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

function createTempProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'akemi-llm-runtime-'))
  mkdirSync(root, { recursive: true })
  tempDirs.push(root)
  return root
}

async function importRuntimeConfig(isPackaged: boolean) {
  const appPath = createTempProjectRoot()

  vi.resetModules()
  vi.doMock('electron', () => ({
    app: {
      isPackaged,
      getAppPath: () => appPath,
      getPath: () => appPath,
    },
  }))

  return import('@akemi-mio/intelligence/llm/runtimeConfig')
}

describe('runtime LLM config resolver', () => {
  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('electron')

    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, envSnapshot)

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prefers project env-backed config in development mode', async () => {
    process.env.LLM_KEY = 'env-chat-key'
    process.env.LLM_CODE_KEY = 'env-code-key'
    process.env.LLM_TEXT_KEY = 'env-text-key'
    process.env.LLM_VISION_KEY = 'env-vision-key'
    process.env.LLM_API_URL = 'https://env-chat.example/v1'
    process.env.LLM_CODE_API_URL = 'https://env-code.example/v1'
    process.env.LLM_TEXT_API_URL = 'https://env-text.example/v1'
    process.env.LLM_VISION_API_URL = 'https://env-vision.example/v1'
    process.env.LLM_CHAT_MODEL = 'env-chat-model'
    process.env.LLM_CODE_MODEL = 'env-code-model'
    process.env.LLM_TEXT_MODEL = 'env-text-model'
    process.env.LLM_VISION_MODEL = 'env-vision-model'

    const { getRuntimeLlmConfig } = await importRuntimeConfig(false)

    const resolved = getRuntimeLlmConfig({
      getCredential: (key) => `db-${key}`,
    })

    expect(resolved.chat).toEqual({
      apiKey: 'env-chat-key',
      apiUrl: 'https://env-chat.example/v1',
      model: 'env-chat-model',
    })
    expect(resolved.code).toEqual({
      apiKey: 'env-code-key',
      apiUrl: 'https://env-code.example/v1',
      model: 'env-code-model',
    })
    expect(resolved.text).toEqual({
      apiKey: 'env-text-key',
      apiUrl: 'https://env-text.example/v1',
      model: 'env-text-model',
    })
    expect(resolved.vision).toEqual({
      apiKey: 'env-vision-key',
      apiUrl: 'https://env-vision.example/v1',
      model: 'env-vision-model',
    })
  })

  it('prefers persisted credentials in packaged mode', async () => {
    const { getRuntimeLlmConfig } = await importRuntimeConfig(true)

    const resolved = getRuntimeLlmConfig({
      getCredential: (key) =>
        (
          ({
            llm_key: 'db-chat-key',
            llm_api_url: 'https://db-chat.example/v1',
            llm_chat_model: 'db-chat-model',
            llm_code_api_key: 'db-code-key',
            llm_code_api_url: 'https://db-code.example/v1',
            llm_code_model: 'db-code-model',
            llm_text_key: 'db-text-key',
            llm_text_api_url: 'https://db-text.example/v1',
            llm_text_model: 'db-text-model',
            llm_vision_key: 'db-vision-key',
            llm_vision_api_url: 'https://db-vision.example/v1',
            llm_vision_model: 'db-vision-model',
          }) as Record<string, string>
        )[key] ?? null,
    })

    expect(resolved.chat).toEqual({
      apiKey: 'db-chat-key',
      apiUrl: 'https://db-chat.example/v1',
      model: 'db-chat-model',
    })
    expect(resolved.code).toEqual({
      apiKey: 'db-code-key',
      apiUrl: 'https://db-code.example/v1',
      model: 'db-code-model',
    })
    expect(resolved.text).toEqual({
      apiKey: 'db-text-key',
      apiUrl: 'https://db-text.example/v1',
      model: 'db-text-model',
    })
    expect(resolved.vision).toEqual({
      apiKey: 'db-vision-key',
      apiUrl: 'https://db-vision.example/v1',
      model: 'db-vision-model',
    })
  })
})
