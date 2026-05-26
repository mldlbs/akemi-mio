interface Message {
  role: 'user' | 'assistant'
  content: string
}

const MAX_CONTEXT = 20
let context: Message[] = []
let apiKey: string | null = null
let apiModel = 'deepseek/deepseek-r1'

const API_URL = 'https://openrouter.ai/api/v1/chat/completions'

export function setConfig(key: string, model?: string) {
  apiKey = key
  if (model) apiModel = model
}

export function clearContext() {
  context = []
}

export async function chat(userText: string, timeoutMs = 30000): Promise<{ reply?: string; error?: string }> {
  if (!apiKey) return { error: 'NO_KEY' }

  context.push({ role: 'user', content: userText })
  if (context.length > MAX_CONTEXT) {
    context = context.slice(context.length - MAX_CONTEXT)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: apiModel,
        messages: context,
        stream: false
      }),
      signal: controller.signal
    })

    if (res.status === 429) return { error: 'RATE_LIMITED' }
    if (res.status === 401) return { error: 'INVALID_KEY' }
    if (!res.ok) return { error: `API_ERROR:${res.status}` }

    const data = await res.json() as {
      choices: Array<{ message: { content: string } }>
    }
    const reply = data.choices?.[0]?.message?.content || ''

    context.push({ role: 'assistant', content: reply })

    return { reply }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { error: 'TIMEOUT' }
    }
    return { error: 'NETWORK' }
  } finally {
    clearTimeout(timer)
  }
}
