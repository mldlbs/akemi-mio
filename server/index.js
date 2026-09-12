/**
 * Telegram proxy server for Akemi Mio
 * Multi-bot: chat / push / gen / write
 * Uses /usr/bin/curl for all Telegram API calls.
 */

const cp = require('child_process')
const fs = require('fs')

// ── Bot tokens ──
const BOTS = {
  chat:  { token: process.env.TOKEN_CHAT  || process.env.TELEGRAM_BOT_TOKEN || '', chatId: 0 },
  push:  { token: process.env.TOKEN_PUSH  || '', chatId: 0 },
  gen:   { token: process.env.TOKEN_GEN   || '', chatId: 0 },
  write: { token: process.env.TOKEN_WRITE || '', chatId: 0 },
}

// Resolve default chat IDs from env
const DEFAULT_CHAT_ID = parseInt(process.env.TELEGRAM_CHAT_ID || '0', 10)
for (const k of Object.keys(BOTS)) {
  if (!BOTS[k].token) { console.error('FATAL: missing token for bot:', k); process.exit(1) }
  BOTS[k].chatId = parseInt(process.env[`CHAT_ID_${k.toUpperCase()}`] || '0', 10) || DEFAULT_CHAT_ID
}

const PORT = process.env.PORT || 3003

function getToken(bot) { return (BOTS[bot] || BOTS.chat).token }
function getDefaultChatId(bot) { return (BOTS[bot] || BOTS.chat).chatId }

// ── Proxy config ──
const PROXY = process.env.HTTP_PROXY || process.env.http_proxy || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || ''

// ── curl-based Telegram API ──

function tg(token, method, body) {
  return new Promise((resolve, reject) => {
    try {
      const api = 'https://api.telegram.org/bot' + token
      const args = ['-s', '--connect-timeout', '10', '--max-time', '15', '-X', 'POST', api + '/' + method]
      if (PROXY) args.push('-x', PROXY)
      if (body) args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(body))
      cp.execFile('/usr/bin/curl', args, { timeout: 16000, encoding: 'utf-8', maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(new Error(err.stderr ? String(err.stderr).slice(0, 200) : err.message))
        try { resolve(JSON.parse(stdout)) } catch { resolve({ ok: false, description: stdout.slice(0, 200) }) }
      })
    } catch (e) { reject(new Error(e.message)) }
  })
}

async function tgR(token, method, body, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const d = await tg(token, method, body)
      if (d && d.error_code === 429) {
        const w = d.parameters?.retry_after || 2
        await new Promise(r => setTimeout(r, w * 1000)); continue
      }
      return d
    } catch (e) {
      if (i < retries - 1) await new Promise(r => setTimeout(r, 2000)); else throw e
    }
  }
}

const express = require('express')
const app = express()
app.use(express.json({ limit: '50mb' }))

const MAX_QUEUE = 1000
const msgQueue = []
const AUTH_USERS = new Set(
  (process.env.TELEGRAM_AUTHORIZED_USERS || '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
)

// ── Long polling (multi-bot) ──
let pollOffsets = { chat: 0, gen: 0, push: 0, write: 0 }
let pollActive = false

async function pollLoop() {
  if (pollActive) return
  pollActive = true
  const botsToPoll = ['chat', 'gen', 'write'] // chat 对话 / gen 生图 / write 写作
  try {
    for (const botName of botsToPoll) {
      const token = getToken(botName)
      if (!token) continue
      try {
        const d = await tg(token, 'getUpdates', { offset: pollOffsets[botName], timeout: 10, allowed_updates: ['message'] })
        if (!d || !d.result) continue
        for (const u of d.result) {
          pollOffsets[botName] = u.update_id + 1
          const m = u.message
          if (!m || !m.text || (m.from && m.from.is_bot)) continue
          if (AUTH_USERS.size > 0 && m.from && !AUTH_USERS.has(m.from.id)) continue
          const chatId = m.chat.id
          const txt = m.text
          const from = m.from ? (m.from.username || m.from.first_name || 'unknown') : 'unknown'
          if (txt === '/start') { tg(token, 'sendMessage', { chat_id: chatId, text: '你好！我是秋山澪 AI 助手。' }).catch(() => {}); continue }
          if (txt === '/status') { tg(token, 'sendMessage', { chat_id: chatId, text: '✅ 运行中\n队列: ' + msgQueue.length + '/' + MAX_QUEUE }).catch(() => {}); continue }
          if (txt === '/clear') {
            if (msgQueue.length < MAX_QUEUE) msgQueue.push({ type: 'command', command: 'clear', chatId, userId: m.from ? m.from.id : undefined, timestamp: Date.now() })
            tg(token, 'sendMessage', { chat_id: chatId, text: '⏳ 清除请求已提交...' }).catch(() => {}); continue
          }
          if (msgQueue.length >= MAX_QUEUE) msgQueue.shift()
          msgQueue.push({ type: 'message', messageId: m.message_id, chatId, text: txt, from, userId: m.from ? m.from.id : undefined, bot: botName, timestamp: Date.now() })
        }
      } catch (err) {
        const s = String(err)
        if (!s.includes('timeout') && !s.includes('TIMEOUT')) console.error('[POLL:' + botName + ']', s.slice(0, 200))
      }
    }
  } finally {
    pollActive = false
    setTimeout(pollLoop, 1000)
  }
}

// ── HTTP API ──
// Every endpoint accepts optional `bot` field ('chat'|'push'|'gen'|'write'), defaults 'chat'

app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), queueLength: msgQueue.length, maxQueue: MAX_QUEUE, pollingActive: pollActive, bots: Object.keys(BOTS) })
})

app.get('/poll', (req, res) => {
  const batch = msgQueue.splice(0, Math.min(msgQueue.length, 50))
  res.json({ messages: batch, queueRemaining: msgQueue.length })
})

app.post('/send', async (req, res) => {
  const { chatId, text, parseMode, bot } = req.body
  if (!chatId || !text) return res.status(400).json({ error: 'chatId and text required' })
  try {
    const token = getToken(bot || 'chat')
    const b = { chat_id: chatId, text }
    if (parseMode) b.parse_mode = parseMode
    const r = await tgR(token, 'sendMessage', b)
    if (r.ok) res.json({ ok: true, messageId: r.result.message_id })
    else res.status(500).json({ error: 'Telegram: ' + (r.description || 'unknown') })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/reply', async (req, res) => {
  const { chatId, text, bot } = req.body
  if (!chatId || !text) return res.status(400).json({ error: 'chatId and text required' })
  try {
    const token = getToken(bot || 'chat')
    const r = await tgR(token, 'sendMessage', { chat_id: chatId, text })
    res.json({ ok: !!r.ok })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/edit', async (req, res) => {
  const { chatId, messageId, text, parseMode, bot } = req.body
  if (!chatId || !messageId || text === undefined) return res.status(400).json({ error: 'chatId, messageId, text required' })
  try {
    const token = getToken(bot || 'chat')
    const b = { chat_id: chatId, message_id: messageId, text }
    if (parseMode) b.parse_mode = parseMode
    const r = await tgR(token, 'editMessageText', b)
    if (r.ok || (r.description && r.description.includes('not modified'))) res.json({ ok: true })
    else res.status(500).json({ ok: false, error: r.description || 'unknown' })
  } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
})

app.post('/action', async (req, res) => {
  const { chatId, action, bot } = req.body
  if (!chatId) return res.status(400).json({ error: 'chatId required' })
  try {
    const token = getToken(bot || 'chat')
    await tg(token, 'sendChatAction', { chat_id: chatId, action: action || 'typing' })
    res.json({ ok: true })
  } catch { res.status(500).json({ ok: false }) }
})

app.post('/photo', async (req, res) => {
  const { chatId, photo, caption, bot } = req.body
  if (!chatId || !photo) return res.status(400).json({ error: 'chatId and photo required' })
  try {
    const token = getToken(bot || 'gen')
    const api = 'https://api.telegram.org/bot' + token
    if (typeof photo === 'string' && (photo.startsWith('http://') || photo.startsWith('https://'))) {
      const r = await tgR(token, 'sendPhoto', { chat_id: chatId, photo, caption })
      if (r.ok) return res.json({ ok: true, messageId: r.result.message_id })
      return res.status(500).json({ error: r.description || 'sendPhoto failed' })
    }
    // Base64 → temp file → curl → cleanup
    const matches = typeof photo === 'string' && photo.startsWith('data:')
      ? photo.match(/^data:image\/(\w+);base64,(.+)$/) : null
    const raw = matches ? Buffer.from(matches[2], 'base64') : Buffer.from(photo, 'base64')
    const ext = matches ? (matches[1] === 'jpeg' ? 'jpg' : matches[1]) : 'png'
    const tmp = '/tmp/tgp_' + Date.now() + '.' + ext
    fs.writeFileSync(tmp, raw)
    let cmd = '/usr/bin/curl -s --max-time 30 -X POST "' + api + '/sendPhoto" -F chat_id="' + chatId + '" -F photo="@' + tmp + '"'
    if (caption) cmd += ' -F caption="' + caption.replace(/"/g, '\\"') + '"'
    const out = cp.execSync(cmd, { timeout: 30000, shell: '/bin/bash' }).toString()
    try { fs.unlinkSync(tmp) } catch {}
    const r = JSON.parse(out)
    if (r.ok) return res.json({ ok: true, messageId: r.result.message_id })
    res.status(500).json({ error: r.description || 'sendPhoto failed' })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/media_group', async (req, res) => {
  const { chatId, media, caption, bot } = req.body
  if (!chatId || !media?.length) return res.status(400).json({ error: 'chatId and media array required' })
  try {
    const token = getToken(bot || 'gen')
    const api = 'https://api.telegram.org/bot' + token
    const results = []
    for (let i = 0; i < media.length; i++) {
      const item = media[i]
      let urlOrFile
      if (item.media.startsWith('http://') || item.media.startsWith('https://')) {
        urlOrFile = item.media
      } else {
        const m = item.media.startsWith('data:') ? item.media.match(/^data:image\/(\w+);base64,(.+)$/) : null
        const raw = m ? Buffer.from(m[2], 'base64') : Buffer.from(item.media, 'base64')
        const tmp = '/tmp/tgm_' + Date.now() + '_' + i + '.png'
        fs.writeFileSync(tmp, raw)
        urlOrFile = '@' + tmp
      }
      results.push({ type: 'photo', media: urlOrFile })
    }
    const first = results[0]
    const captionText = caption || ''
    let cmd = '/usr/bin/curl -s --max-time 30 -X POST "' + api + '/sendPhoto" -F chat_id="' + chatId + '" -F photo="' + first.media + '"'
    if (captionText) cmd += ' -F caption="' + captionText.replace(/"/g, '\\"') + '"'
    const out = cp.execSync(cmd, { timeout: 30000, shell: '/bin/bash' }).toString()
    for (const item of results) { if (item.media.startsWith('@')) try { fs.unlinkSync(item.media.slice(1)) } catch {} }
    const r = JSON.parse(out)
    if (r.ok) return res.json({ ok: true, messageId: r.result.message_id })
    res.status(500).json({ error: r.description || 'sendMediaGroup failed' })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── Start ──
app.listen(PORT, '0.0.0.0', () => {
  console.log('[TG] multi-bot server port ' + PORT)
  console.log('[TG] bots: ' + Object.keys(BOTS).join(', '))
  pollLoop()
})
