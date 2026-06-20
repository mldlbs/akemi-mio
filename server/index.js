const express = require('express')

const PORT = process.env.PORT || 3003
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!BOT_TOKEN) { console.error('FATAL: TELEGRAM_BOT_TOKEN not set'); process.exit(1) }

const AUTHORIZED_USERS = new Set(
  (process.env.TELEGRAM_AUTHORIZED_USERS || '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
)

const messageQueue = []
const app = express()
app.use(express.json())

const CURL = '/usr/bin/curl -s --connect-timeout 8 -m 12 -x http://127.0.0.1:7890'

function tgReq(method, params, cb, attempt) {
  attempt = attempt || 1
  var qs = ''
  if (params) {
    var parts = []
    for (var k in params) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k])))
    qs = '?' + parts.join('&')
  }
  var cmd = CURL + ' "' + 'https://api.telegram.org/bot' + BOT_TOKEN + '/' + method + qs + '"'
  require('child_process').exec(cmd, { timeout: 20000, encoding: 'utf-8' }, function(err, stdout) {
    if (err) {
      if (attempt < 3 && method === 'sendMessage') {
        setTimeout(function() { tgReq(method, params, cb, attempt + 1) }, 2000)
        return
      }
      if (cb) cb(err)
      return
    }
    try { var d = JSON.parse(stdout); if (cb) cb(null, d) } catch (e) { if (cb) cb(e) }
  })
}

app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime(), queueLength: messageQueue.length }))

app.get('/poll', (_req, res) => {
  const batch = messageQueue.splice(0, messageQueue.length)
  res.json({ messages: batch })
})

app.post('/reply', function(req, res) {
  var chatId = req.body.chatId
  var text = req.body.text
  if (!chatId || !text) return res.status(400).json({ error: 'chatId and text required' })
  tgReq('sendMessage', { chat_id: chatId, text: text }, function(err) {
    if (err) { console.error('[REPLY_ERR]', err.message); res.status(500).json({ error: err.message }) }
    else res.json({ ok: true })
  })
})

// 发送一条独立消息，返回 messageId
app.post('/send', function(req, res) {
  var chatId = req.body.chatId
  var text = req.body.text
<<<<<<< Updated upstream
  if (!chatId || !text) return res.status(400).json({ error: 'chatId and text required' })
  var params = { chat_id: chatId, text: text }
  if (req.body.parseMode) params.parse_mode = req.body.parseMode
=======
  var parseMode = req.body.parseMode
  if (!chatId || !text) return res.status(400).json({ error: 'chatId and text required' })
  var params = { chat_id: chatId, text: text }
  if (parseMode) params.parse_mode = parseMode
>>>>>>> Stashed changes
  tgReq('sendMessage', params, function(err, data) {
    if (err) { console.error('[SEND_ERR]', err.message); res.status(500).json({ error: err.message }) }
    else res.json({ ok: true, messageId: data.result && data.result.message_id })
  })
})

// 编辑已有消息
app.post('/edit', function(req, res) {
  var chatId = req.body.chatId
  var messageId = req.body.messageId
  var text = req.body.text
<<<<<<< Updated upstream
  if (!chatId || !messageId || text === undefined) return res.status(400).json({ error: 'chatId, messageId and text required' })
  var params = { chat_id: chatId, message_id: messageId, text: text }
  if (req.body.parseMode) params.parse_mode = req.body.parseMode
=======
  var parseMode = req.body.parseMode
  if (!chatId || !messageId || text === undefined) return res.status(400).json({ error: 'chatId, messageId and text required' })
  var params = { chat_id: chatId, message_id: messageId, text: text }
  if (parseMode) params.parse_mode = parseMode
>>>>>>> Stashed changes
  tgReq('editMessageText', params, function(err) {
    if (err) console.error('[EDIT_ERR]', err.message)
    res.json({ ok: !err, error: err ? err.message : undefined })
  })
})

// 发送 chat action（typing 等）
app.post('/action', function(req, res) {
  var chatId = req.body.chatId
  var action = req.body.action || 'typing'
  if (!chatId) return res.status(400).json({ error: 'chatId required' })
  tgReq('sendChatAction', { chat_id: chatId, action: action }, function(err) {
    if (err) console.error('[ACTION_ERR]', err.message)
    res.json({ ok: !err })
  })
})

app.listen(PORT, '0.0.0.0', function() {
  console.log('[TG_BOT] listening on 0.0.0.0:' + PORT)
  console.log('[TG_BOT] authorized users: ' + (AUTHORIZED_USERS.size || 'anyone'))

  var offset = 0
  function poll() {
    tgReq('getUpdates', { offset: offset }, function(err, data) {
      if (!err && data.ok && data.result && data.result.length) {
        for (var i = 0; i < data.result.length; i++) {
          var update = data.result[i]
          offset = update.update_id + 1
          var msg = update.message
          if (!msg || !msg.text) continue
<<<<<<< Updated upstream
          // 跳过 bot 自己发出的消息，防止回复被回传给 LLM
=======
          // 过滤 bot 自己的消息，防止 reply 被当成用户消息回传给 LLM
>>>>>>> Stashed changes
          if (msg.from && msg.from.is_bot) continue
          var chatId = msg.chat.id
          var text = msg.text
          var from = msg.from ? (msg.from.username || msg.from.first_name || 'unknown') : 'unknown'

          if (AUTHORIZED_USERS.size > 0 && msg.from && !AUTHORIZED_USERS.has(msg.from.id)) {
            tgReq('sendMessage', { chat_id: chatId, text: '⛔ 未授权用户' })
            continue
          }
          if (text === '/start') {
            tgReq('sendMessage', { chat_id: chatId, text: '你好！我是秋山澪 AI 助手。直接发送消息即可与我对话。' })
            continue
          }
          if (text === '/help') {
            tgReq('sendMessage', { chat_id: chatId, text: '🤖 *秋山澪 AI 助手*\n直接发送文字消息与我对话。\n/help - 显示此帮助\n/status - 系统状态\n/clear - 清除对话上下文', parse_mode: 'Markdown' })
            continue
          }
          if (text === '/status') {
            tgReq('sendMessage', { chat_id: chatId, text: '✅ 系统运行中' })
            continue
          }
          if (text === '/clear') {
            messageQueue.push({ type: 'command', command: 'clear', chatId: chatId, userId: msg.from ? msg.from.id : undefined })
            tgReq('sendMessage', { chat_id: chatId, text: '⏳ 清除请求已提交...' })
            continue
          }

          messageQueue.push({ type: 'message', messageId: msg.message_id, chatId: chatId, text: text, from: from, userId: msg.from ? msg.from.id : undefined, timestamp: Date.now() })
          console.log('[MSG] ' + from + ': ' + text.slice(0, 100))
        }
      } else if (err) {
        var em = (err.message || err).slice(0, 200)
        if (em.indexOf('timeout') === -1) console.error('[POLL_ERR]', em)
      }
      setTimeout(poll, 2000)
    })
  }
  poll()
})
