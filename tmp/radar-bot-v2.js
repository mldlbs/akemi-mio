#!/usr/bin/env node
/**
 * 创业雷达 Telegram Bot — 中文版 v2
 * 优化：axios替代curl、统一错误处理、/radar all 命令、Markdown格式
 */
const cp = require('child_process')
const fs2 = require('fs')
const path = require('path')
const axios = require('axios')

const TOKEN = process.env.TOKEN_RADAR || process.env.TOKEN_PUSH || process.env.TOKEN || ''
const CHAT_ID = process.env.RADAR_CHAT_ID || process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID || ''
const RADAR_URL = process.env.RADAR_URL || 'https://ai.crlkcloud.cyou/radar/pipeline'
const STATE_FILE = path.join(__dirname, 'state.json')
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL) || 3000

if (!TOKEN) { console.error('FATAL: TOKEN required'); process.exit(1) }
if (!CHAT_ID) { console.error('FATAL: CHAT_ID required'); process.exit(1) }

const CLASSIFICATION_CN = {
  'ai_infrastructure': 'AI 基础设施', 'dev_productivity': '开发者工具',
  'compliance_automation': '合规自动化', 'data_tools': '数据工具',
  'knowledge_management': '知识管理', 'collaboration': '协同办公',
  'nocode_lowcode': '低代码/无代码', 'fintech': '金融科技',
  'ai': '人工智能', 'saas': 'SaaS', 'b2b': '企业服务',
  'security': '网络安全', 'developer_tools': '开发者工具',
  'analytics': '数据分析', 'automation': '自动化'
}
function translateCn(key) {
  if (!key) return ''
  const k = key.toLowerCase().replace(/[-\s]/g, '_')
  return CLASSIFICATION_CN[k] || key
}
function interpretScore(score) {
  if (score >= 85) return '强烈信号，值得立即关注验证'
  if (score >= 75) return '高价值机会，建议深入研究'
  if (score >= 65) return '有潜力方向，持续观察'
  if (score >= 50) return '中等信号，可作为参考'
  return '早期信号，保持关注'
}

const TG_API = 'https://api.telegram.org/bot' + TOKEN

async function tg(method, body, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await axios.post(TG_API + '/' + method, body, { timeout: 15000 })
      return res.data
    } catch (err) {
      if (i === retries) throw new Error(err.response?.data?.description || err.message)
      await new Promise(r => setTimeout(r, 1000 * (i + 1)))
    }
  }
}

async function sendMsgSafe(chatId, text) {
  if (!text) return
  const maxLen = 4000
  if (text.length <= maxLen) {
    return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown' })
  }
  const parts = []
  for (let i = 0; i < text.length; i += maxLen) parts.push(text.slice(i, i + maxLen))
  for (const part of parts) {
    await tg('sendMessage', { chat_id: chatId, text: part, parse_mode: 'Markdown' })
    await new Promise(r => setTimeout(r, 500))
  }
}

async function fetchRadarData() {
  const res = await axios.get(RADAR_URL, { timeout: 20000 })
  return res.data
}

function formatSignals(data) {
  const signals = data.signals || []
  if (!signals.length) return '*暂无信号数据*'
  const sorted = [...signals].sort((a, b) => (b.score || 0) - (a.score || 0))
  let msg = '*📡 创业趋势雷达*\n'
  msg += '共 ' + signals.length + ' 条信号 | 更新于 ' + (data.reports?.[0]?.date || '今日') + '\n\n'
  sorted.slice(0, 8).forEach(function(s) {
    const score = s.score || 0
    const title = (s.problem || s.title || s.id || '未命名信号').substring(0, 60)
    msg += '*' + interpretScore(score) + '*\n'
    msg += '`[' + score + '分]` *' + title + '*\n'
    if (s.classification) msg += '领域: ' + translateCn(s.classification) + '\n'
    if (s.source) msg += '来源: ' + s.source + '\n'
    msg += '\n'
  })
  if (signals.length > 8) msg += '...还有 ' + (signals.length - 8) + ' 条信号，发 /radar high 看高分\n'
  if (data.themes && data.themes.length) {
    msg += '*📊 热门主题*\n'
    data.themes.slice(0, 5).forEach(function(t) {
      msg += '  `' + t.theme + '`: ' + t.count + '条'
      if (t.trend_score) msg += ' | 趋势分 ' + t.trend_score
      msg += '\n'
    })
  }
  return msg
}

function formatAllSignals(data) {
  const signals = data.signals || []
  if (!signals.length) return '*暂无信号数据*'
  const sorted = [...signals].sort((a, b) => (b.score || 0) - (a.score || 0))
  let msg = '*📡 全部创业信号（共 ' + signals.length + ' 条）*\n\n'
  sorted.forEach(function(s, i) {
    const title = (s.problem || s.title || '').substring(0, 80)
    msg += (i+1) + '. `[' + (s.score || 0) + '分]` *' + title + '*\n'
    if (s.classification) msg += '  领域: ' + translateCn(s.classification) + '\n'
    if (s.business_value) msg += '  定位: ' + s.business_value + '\n'
    msg += '\n'
  })
  return msg
}

function formatHighValueSignals(data) {
  const signals = (data.signals || []).filter(function(s) { return (s.score || 0) >= 70 })
  if (!signals.length) return '*暂无高分信号*'
  let msg = '*💰 高价值创业信号（评分70+）*\n共 ' + signals.length + ' 条\n\n'
  signals.sort(function(a, b) { return (b.score || 0) - (a.score || 0) })
  signals.forEach(function(s, i) {
    const title = (s.problem || s.title || '').substring(0, 80)
    msg += (i+1) + '. *[' + s.score + '分]* ' + title + '\n'
    msg += '  ' + interpretScore(s.score) + '\n'
    if (s.classification) msg += '  领域: ' + translateCn(s.classification) + '\n'
    if (s.business_value) msg += '  商业定位: ' + s.business_value + '\n'
    msg += '\n'
  })
  return msg
}

function loadState() {
  try { return JSON.parse(fs2.readFileSync(STATE_FILE, 'utf-8')) } catch { return { lastSignals: [], lastPushDate: '' } }
}
function saveState(s) { fs2.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)) }

async function pushNewSignals(data) {
  const state = loadState()
  const signals = data.signals || []
  const today = new Date().toISOString().slice(0, 10)
  if (state.lastPushDate === today) return
  try {
    const newSignals = signals.filter(function(s) {
      return !state.lastSignals.find(function(ls) { return String(ls.id) === String(s.id) })
    })
    if (newSignals.length > 0) {
      let msg = '*🆕 新增创业信号 (' + newSignals.length + '条)*\n\n'
      newSignals.slice(0, 5).forEach(function(s, i) {
        msg += (i+1) + '. `[' + s.score + '分]` ' + (s.problem || s.title || '').substring(0, 60) + '\n'
        if (s.classification) msg += '   领域: ' + translateCn(s.classification) + '\n'
      })
      if (newSignals.length > 5) msg += '\n...还有 ' + (newSignals.length - 5) + ' 条新信号'
      await sendMsgSafe(parseInt(CHAT_ID), msg)
    }
    const highCount = signals.filter(function(s) { return (s.score || 0) >= 70 }).length
    let summary = '*📡 雷达日报 ' + today + '*\n\n'
    summary += '*今日概况:*\n'
    summary += '  总信号: ' + signals.length + ' 条\n'
    summary += '  高分信号: ' + highCount + ' 条\n'
    summary += '  覆盖主题: ' + (data.themes || []).length + ' 个\n'
    if (data.themes && data.themes.length) {
      summary += '\n*热门主题 TOP3:*\n'
      data.themes.slice(0, 3).forEach(function(t) {
        summary += '  `' + t.theme + '`: ' + t.count + '条'
        if (t.trend_score) summary += ' | 趋势分 ' + t.trend_score
        summary += '\n'
      })
    }
    summary += '\n发 /radar 查看详情 | /radar high 看高价值信号 | /radar all 看全部'
    await sendMsgSafe(parseInt(CHAT_ID), summary)
    state.lastSignals = signals.map(function(s) { return { id: s.id, score: s.score } })
    state.lastPushDate = today
    saveState(state)
  } catch (err) {
    console.error('[PUSH-ERROR]', err.message)
  }
}

let offset = 0
async function pollCommands() {
  try {
    const d = await tg('getUpdates', { offset, timeout: 10, allowed_updates: ['message'] })
    if (!d || !d.result) return
    for (const u of d.result) {
      offset = u.update_id + 1
      const m = u.message
      if (!m || !m.text) continue
      const chatId = m.chat.id
      const txt = m.text.trim()
      if (txt === '/radar' || txt.startsWith('/radar ')) {
        await sendMsgSafe(chatId, '*⏳* 正在获取雷达数据...')
        try {
          const data = await fetchRadarData()
          if (txt.includes('all')) {
            await sendMsgSafe(chatId, formatAllSignals(data))
          } else if (txt.includes('high')) {
            await sendMsgSafe(chatId, formatHighValueSignals(data))
          } else {
            await sendMsgSafe(chatId, formatSignals(data))
          }
        } catch (e) {
          await tg('sendMessage', { chat_id: chatId, text: '❌ 获取失败: ' + e.message })
        }
      }
    }
  } catch (e) {
    const s = String(e)
    if (!s.includes('timeout') && !s.includes('ETIMEDOUT')) {
      console.error('[POLL]', s.slice(0, 200))
    }
  }
}

let lastPushCheck = ''
async function pushLoop() {
  const today = new Date().toISOString().slice(0, 10)
  if (today !== lastPushCheck) {
    lastPushCheck = today
    try { const data = await fetchRadarData(); await pushNewSignals(data) }
    catch (e) { console.error('[PUSH]', e.message) }
  }
}

const express = require('express')
const app = express()
app.get('/health', function(req, res) { res.json({ ok: true, uptime: process.uptime() }) })
app.listen(Number(process.env.PORT) || 3010, function() { console.log('[RADAR-BOT] port ' + (process.env.PORT || 3010)) })

console.log('[RADAR-BOT] v2 starting... CHAT_ID:', CHAT_ID)
setInterval(pollCommands, POLL_INTERVAL)
setInterval(pushLoop, 60000)
pushLoop()
