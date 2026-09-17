'use strict'

// Shared LLM client: the single implementation of chatJson, consumed by the MCP
// server (creativity engine + insight store) and by the CLI
// (`mio creativity generate` / `ferment`). Extracted from
// mio-intelligence-mcp/index.js so both entry points call the same model with
// the same configuration, and so "is an LLM configured?" has one answer.
//
// Configuration is entirely environment-based:
//   LLM_API_URL       OpenAI-compatible endpoint (default: opencode zen)
//   LLM_KEY           bearer token; empty means unauthenticated (common for a
//                     local Ollama / llama.cpp server)
//   LLM_CHAT_MODEL    model id, falls back to LLM_MODEL

const DEFAULT_API_URL = 'https://opencode.ai/zen/go/v1/chat/completions'
const DEFAULT_MODEL = 'deepseek-v4-flash'

function llmConfig() {
  return {
    apiUrl: process.env.LLM_API_URL || DEFAULT_API_URL,
    apiKey: process.env.LLM_KEY || '',
    model: process.env.LLM_CHAT_MODEL || process.env.LLM_MODEL || DEFAULT_MODEL,
  }
}

// True when the user has pointed us somewhere other than the default hosted
// endpoint, or supplied a key. Used to warn (not block) before spending a call.
function isLlmConfigured() {
  return Boolean(process.env.LLM_API_URL || process.env.LLM_KEY)
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

module.exports = { chatJson, llmConfig, isLlmConfigured }
