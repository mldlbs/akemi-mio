const express = require('express')
const { Bot, GrammyError } = require('grammy')

const PORT = process.env.PORT || 3003
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!BOT_TOKEN) { console.error('FATAL: TELEGRAM_BOT_TOKEN not set'); process.exit(1) }

const AUTHORIZED_USERS = new Set(
  (process.env.TELEGRAM_AUTHORIZED_USERS || '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
)

// ── HTTP proxy support ──
if (process.env.HTTP_PROXY) {
  try {
    const { setGlobalDispatcher, ProxyAgent } = require('undici')
    setGlobalDispatcher(new ProxyAgent(process.env.HTTP_PROXY))
    console.log('[TG_BOT] using HTTP proxy:', process.env.HTTP_PROXY)
  } catch (e) {
    console.warn('[TG_BOT] failed to set HTTP proxy:', e.message)
  }
}

const MAX_QUEUE = 1000
const messageQueue = []
const app = express()
app.use(express.json())

// ── Grammy Bot ──
const bot = new Bot(BOT_TOKEN, {
  client: { timeout: parseInt(process.env.TG_API_TIMEOUT || '15000') },
})

// 429 retry: 最多重试 3 次，按 Telegram 的 retry_after 等待
async function safeApiCall(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 429) {
        const retryAfter = err.parameters?.retry_after ?? (i + 1) * 2
        if (i < retries - 1) {
          console.warn(`[RATE_LIMIT] retry ${i + 1}/${retries} after ${retryAfter}s`)
          await new Promise(r => setTimeout(r, retryAfter * 1000))
          continue
        }
      }
      throw err
    }
  }
}

// ── Bot commands registration ──
safeApiCall(() =>
  bot.api.setMyCommands([
    { command: 'start', description: '开始对话' },
    { command: 'help', description: '帮助信息' },
    { command: 'status', description: '系统状态' },
    { command: 'clear', description: '清除对话上下文' },
  ])
).catch(() => {})

// ── Long polling ──
let pollingOffset = 0
let pollingActive = false

async function pollLoop() {
  if (pollingActive) return
  pollingActive = true
  try {
    const updates = await bot.api.getUpdates({
      offset: pollingOffset,
      timeout: 30,
      allowed_updates: ['message'],
    })
    for (const update of updates) {
      pollingOffset = update.update_id + 1
      const msg = update.message
      if (!msg || !msg.text) continue
      if (msg.from && msg.from.is_bot) continue

      const chatId = msg.chat.id
      const text = msg.text
      const from = msg.from ? (msg.from.username || msg.from.first_name || 'unknown') : 'unknown'

      // Authorization
      if (AUTHORIZED_USERS.size > 0 && msg.from && !AUTHORIZED_USERS.has(msg.from.id)) {
        safeApiCall(() => bot.api.sendMessage(chatId, '⛔ 未授权用户')).catch(() => {})
        continue
      }

      // Commands
      if (text === '/start') {
        safeApiCall(() => bot.api.sendMessage(chatId, '你好！我是秋山澪 AI 助手。直接发送消息即可与我对话。')).catch(() => {})
        continue
      }
      if (text === '/help') {
        safeApiCall(() =>
          bot.api.sendMessage(chatId, '🤖 *秋山澪 AI 助手*\n直接发送文字消息与我对话。\n/help - 显示此帮助\n/status - 系统状态\n/clear - 清除对话上下文', { parse_mode: 'Markdown' })
        ).catch(() => {})
        continue
      }
      if (text === '/status') {
        safeApiCall(() => bot.api.sendMessage(chatId, `✅ 系统运行中\n队列: ${messageQueue.length}/${MAX_QUEUE}`)).catch(() => {})
        continue
      }
      if (text === '/clear') {
        if (messageQueue.length < MAX_QUEUE) {
          messageQueue.push({ type: 'command', command: 'clear', chatId, userId: msg.from ? msg.from.id : undefined, timestamp: Date.now() })
        }
        safeApiCall(() => bot.api.sendMessage(chatId, '⏳ 清除请求已提交...')).catch(() => {})
        continue
      }

      // Normal message — 队列满时丢弃最早的消息
      if (messageQueue.length >= MAX_QUEUE) {
        const dropped = messageQueue.shift()
        console.warn('[QUEUE_DROP] dropped message from', dropped?.from || 'unknown')
      }
      messageQueue.push({
        type: 'message',
        messageId: msg.message_id,
        chatId,
        text,
        from,
        userId: msg.from ? msg.from.id : undefined,
        timestamp: Date.now(),
      })
      console.log('[MSG] ' + from + ': ' + text.slice(0, 100))
    }
  } catch (err) {
    const errMsg = String(err).slice(0, 200)
    if (!errMsg.includes('timeout') && !errMsg.includes('TIMEOUT') && !errMsg.includes('socket hang up')) {
      console.error('[POLL_ERR]', errMsg)
    }
  } finally {
    pollingActive = false
    setTimeout(pollLoop, 1000)
  }
}

// ── HTTP API (consumed by desktop app) ──

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    queueLength: messageQueue.length,
    maxQueue: MAX_QUEUE,
    pollingActive,
    botConnected: true,
  })
})

app.get('/poll', (_req, res) => {
  const batch = messageQueue.splice(0, Math.min(messageQueue.length, 50))
  res.json({ messages: batch, queueRemaining: messageQueue.length })
})

app.post('/reply', async (req, res) => {
  const { chatId, text } = req.body
  if (!chatId || !text) return res.status(400).json({ error: 'chatId and text required' })
  try {
    await safeApiCall(() => bot.api.sendMessage(chatId, text))
    res.json({ ok: true })
  } catch (err) {
    console.error('[REPLY_ERR]', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.post('/send', async (req, res) => {
  const { chatId, text, parseMode } = req.body
  if (!chatId || !text) return res.status(400).json({ error: 'chatId and text required' })
  try {
    const result = await safeApiCall(() => bot.api.sendMessage(chatId, text, parseMode ? { parse_mode: parseMode } : {}))
    res.json({ ok: true, messageId: result.message_id })
  } catch (err) {
    console.error('[SEND_ERR]', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.post('/edit', async (req, res) => {
  const { chatId, messageId, text, parseMode } = req.body
  if (!chatId || !messageId || text === undefined) return res.status(400).json({ error: 'chatId, messageId and text required' })
  try {
    await safeApiCall(() => bot.api.editMessageText(chatId, messageId, text, parseMode ? { parse_mode: parseMode } : {}))
    res.json({ ok: true })
  } catch (err) {
    if (err.message && err.message.includes('message is not modified')) {
      res.json({ ok: true, notModified: true })
    } else {
      console.error('[EDIT_ERR]', err.message)
      res.status(500).json({ ok: false, error: err.message })
    }
  }
})

app.post('/action', async (req, res) => {
  const { chatId, action } = req.body
  if (!chatId) return res.status(400).json({ error: 'chatId required' })
  try {
    await safeApiCall(() => bot.api.sendChatAction(chatId, action || 'typing'))
    res.json({ ok: true })
  } catch (err) {
    console.error('[ACTION_ERR]', err.message)
    res.status(500).json({ ok: false })
  }
})

// ── Start ──

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('[TG_BOT] listening on 0.0.0.0:' + PORT)
  console.log('[TG_BOT] authorized users: ' + (AUTHORIZED_USERS.size || 'anyone'))
  pollLoop()
})

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[TG_BOT] SIGTERM received, shutting down...')
  server.close(() => {
    console.log('[TG_BOT] server closed')
    process.exit(0)
  })
  setTimeout(() => {
    console.error('[TG_BOT] forced exit after timeout')
    process.exit(1)
  }, 5000)
})

process.on('SIGINT', () => {
  console.log('[TG_BOT] SIGINT received, shutting down...')
  server.close(() => {
    console.log('[TG_BOT] server closed')
    process.exit(0)
  })
})
