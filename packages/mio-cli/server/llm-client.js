'use strict'

// Shared LLM client: the single implementation of chatJson, consumed by the MCP
// server (creativity engine + insight store) and by the CLI
// (`mio creativity generate` / `ferment`). Extracted from
// mio-intelligence-mcp/index.js so both entry points call the same model with
// the same configuration, and so "is an LLM configured?" has one answer.
//
// Configuration resolution order (highest first):
//   1. Environment variables
//        LLM_API_URL       OpenAI-compatible endpoint (default: opencode zen)
//        LLM_KEY           bearer token; empty means unauthenticated (common for
//                          a local Ollama / llama.cpp server)
//        LLM_CHAT_MODEL    model id, falls back to LLM_MODEL
//   2. config.json under MIO_HOME (written by `mio config llm`) — the `llm`
//      object's apiUrl / apiKey / model keys
//   3. Built-in defaults
//
// Environment wins so a shell-level override can always beat a stored config
// without editing files. The config file is read lazily and cached, so a long
// running MCP process does not re-stat it on every call.

const fs = require('fs')
const os = require('os')
const path = require('path')

const DEFAULT_API_URL = 'https://opencode.ai/zen/go/v1/chat/completions'
const DEFAULT_MODEL = 'deepseek-v4-flash'

// Resolve the directory holding config.json. The CLI and the MCP server use
// different data dirs by design (MIO_HOME vs MIO_DATA_DIR||cwd/.mio-intelligence),
// so we honour whichever is set and fall back to the CLI default. No third
// convention is introduced here on purpose.
function homeDir() {
  return (
    process.env.MIO_HOME ||
    process.env.MIO_DATA_DIR ||
    path.join(os.homedir(), '.mio-intelligence')
  )
}

let cachedFileConfig
let cachedFor = null

// Read the `llm` block from config.json. Any failure (missing file, bad JSON,
// wrong shape) degrades to {} — configuration must never crash a caller.
function fileConfig() {
  const target = homeDir()
  if (cachedFor === target) return cachedFileConfig
  cachedFor = target
  cachedFileConfig = {}
  try {
    const raw = fs.readFileSync(path.join(target, 'config.json'), 'utf8')
    const parsed = JSON.parse(raw)
    const llm = parsed && typeof parsed.llm === 'object' && parsed.llm !== null ? parsed.llm : {}
    const pick = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)
    cachedFileConfig = {
      apiUrl: pick(llm.apiUrl),
      apiKey: pick(llm.apiKey),
      model: pick(llm.model),
    }
  } catch (_) {
    cachedFileConfig = {}
  }
  return cachedFileConfig
}

// Exposed so writers (`mio config llm`) can drop the cache after editing the
// file, and so tests can reset between cases.
function resetLlmConfigCache() {
  cachedFor = null
  cachedFileConfig = {}
}

function llmConfig() {
  const file = fileConfig()
  return {
    apiUrl: process.env.LLM_API_URL || file.apiUrl || DEFAULT_API_URL,
    apiKey: process.env.LLM_KEY || file.apiKey || '',
    model: process.env.LLM_CHAT_MODEL || process.env.LLM_MODEL || file.model || DEFAULT_MODEL,
  }
}

// True when the user has pointed us somewhere other than the default hosted
// endpoint, or supplied a key. Used to warn (not block) before spending a call.
// "Configured" counts either source: an env var or a stored config.json entry.
function isLlmConfigured() {
  const file = fileConfig()
  return Boolean(
    process.env.LLM_API_URL ||
      process.env.LLM_KEY ||
      file.apiUrl ||
      file.apiKey ||
      file.model
  )
}

// Which source each field came from, for `mio config show` to display honestly.
// Reporting a value without its origin is how users end up editing config.json
// and wondering why nothing changed (an env var was shadowing them).
function llmConfigSources() {
  const file = fileConfig()
  return {
    apiUrl: process.env.LLM_API_URL ? 'env' : file.apiUrl ? 'config' : 'default',
    apiKey: process.env.LLM_KEY ? 'env' : file.apiKey ? 'config' : 'unset',
    model: process.env.LLM_CHAT_MODEL
      ? 'env'
      : process.env.LLM_MODEL
        ? 'env'
        : file.model
          ? 'config'
          : 'default',
  }
}

async function chatJson(userText, opts = {}) {
  const { apiUrl, apiKey, model } = llmConfig()
  const system = opts.system || 'You are a creative AI assistant. Output JSON.'
  const temperature = opts.temperature ?? 0.3

  try {
    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userText },
        ],
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs || 30000),
    })

    if (!resp.ok) return { error: `HTTP ${resp.status}` }
    const json = await resp.json()
    const text = json.choices?.[0]?.message?.content || ''
    try {
      return { data: JSON.parse(text) }
    } catch {
      return { data: text }
    }
  } catch (err) {
    return { error: String(err) }
  }
}

module.exports = {
  chatJson,
  llmConfig,
  isLlmConfigured,
  llmConfigSources,
  resetLlmConfigCache,
  DEFAULT_API_URL,
  DEFAULT_MODEL,
}
