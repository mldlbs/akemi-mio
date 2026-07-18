import { AgentService } from '../agent/AgentService'
import { log } from '../logger/Logger'
import { credentialsManager } from '../credentials/CredentialsManager'
import { eventBus } from '../core/EventBus'
import { radarPushScheduler } from './radar/RadarPushScheduler'
import { insertOutbox, type OutboxCategory } from '../db/outbox'
import { WORKSPACE, TELEGRAM_SERVER_URL, TELEGRAM_CHAT_ID, TELEGRAM_ENABLED } from '../config'
import { writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

interface TelegramMessage {
  type: 'message' | 'command'
  messageId?: number
  chatId: number
  text?: string
  command?: string
  from: string
  userId?: number
  bot?: string
  timestamp: number
}

interface ToolLine {
  name: string
  status: 'running' | 'done' | 'failed'
  latencyMs?: number
}

// ── 路由表：消息分类 → 使用的 bot ──
// 4 个 bot：chat(对话) / push(推送) / gen(生图) / write(写作)

const ROUTING: Record<string, string> = {
  dialogue: 'chat',
  evolution: 'push',
  insight: 'push',
  creativity: 'push',
  plan: 'push',
  budget: 'push',
  recovery: 'push',
  stability: 'push',
  radar: 'push',
  system: 'push',
  image_gen: 'gen',
  image_result: 'gen',
  writing: 'write',
}

/** 延迟编辑调度：将频繁的 progress 更新 debounce 后直接 HTTP 编辑（不走 outbox，保证实时性） */
export class DebouncedEditor {
  private baseUrl = ''
  private timer: ReturnType<typeof setTimeout> | null = null
  private pendingChatId = 0
  private pendingText = ''
  private pendingTargetMsgId = 0
  private pendingBot = 'chat'

  /** 在 TelegramService 初始化后设置真实的 baseUrl */
  setBaseUrl(url: string): void {
    this.baseUrl = url
  }

  schedule(chatId: number, targetMessageId: number, text: string, bot: string = 'chat'): void {
    this.pendingChatId = chatId
    this.pendingText = text
    this.pendingTargetMsgId = targetMessageId
    this.pendingBot = bot
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 400)
    }
  }

  private async flush(): Promise<void> {
    this.timer = null
    try {
      await fetch(`${this.baseUrl}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: this.pendingChatId,
          messageId: this.pendingTargetMsgId,
          text: this.pendingText,
          bot: this.pendingBot,
        }),
        signal: AbortSignal.timeout(5000),
      })
    } catch {
      /* 编辑失败静默忽略，下一轮会继续更新 */
    }
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  flushNow(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
      this.flush()
    }
  }
}

export class TelegramService {
  private agentService: AgentService
  private baseUrl = ''
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private isRunning = false
  private retryQueue: TelegramMessage[] = []
  private activeSessions = new Map<
    string,
    {
      messageId: number
      bot: string
      toolLines: ToolLine[]
      typingTimer: ReturnType<typeof setInterval> | null
      disposers: (() => void)[]
      editor: DebouncedEditor
    }
  >()
  private pushChatId: number | null = null
  /** 标记是否已订阅推送事件，防止重复注册 */
  private pushEventsSubscribed = false
  /** 当 outbox 任务被禁用时，通过此回调重新激活 */
  private reactivateOutbox: (() => void) | null = null
  // ★ 修复：Map<requestId, session> 通过 EventBus requestId 精确匹配输入/回复
  private pushSessions = new Map<
    string,
    {
      messageId: number
      userText: string
      toolLines: ToolLine[]
      editor: DebouncedEditor
      typingTimer: ReturnType<typeof setInterval> | null
      disposers: (() => void)[]
      createdAt: number
    }
  >()

  constructor(agentService: AgentService) {
    this.agentService = agentService
  }

  /** 注册 outbox 任务重新激活回调，当 outbox 被 TaskRunner disable 后自动恢复 */
  setReactivateOutbox(cb: () => void): void {
    this.reactivateOutbox = cb
  }

  private tryReactivateOutbox(): void {
    if (this.reactivateOutbox) {
      try {
        this.reactivateOutbox()
      } catch {
        /* 静默 */
      }
    }
  }

  async initialize(): Promise<void> {
    // 检查启用状态：优先 credentialsManager，回退 config/env
    const enabledFlag = credentialsManager.get('telegram_enabled')
    const isEnabled = enabledFlag !== null ? enabledFlag === 'true' : TELEGRAM_ENABLED
    if (!isEnabled) {
      log('INFO', 'telegram_disabled', { msg: 'Telegram 功能未启用，跳过初始化' })
      return
    }

    const url = credentialsManager.get('telegram_server_url') || TELEGRAM_SERVER_URL
    this.baseUrl = url.replace(/\/+$/, '')

    // 所有 DebouncedEditor 共享 baseUrl
    DebouncedEditor.prototype.setBaseUrl(this.baseUrl)

    // push chatId 不论 health 是否可达都读取（push 路径走本地发送）
    const rawChatId = credentialsManager.get('telegram_chat_id') || (TELEGRAM_CHAT_ID ? String(TELEGRAM_CHAT_ID) : undefined)
    if (rawChatId) {
      this.pushChatId = parseInt(rawChatId, 10)
      if (isNaN(this.pushChatId)) {
        log('WARN', 'telegram_push_invalid_chat_id', { raw: rawChatId })
        this.pushChatId = null
      } else {
        log('INFO', 'telegram_push_enabled', { chatId: this.pushChatId })
        this.subscribePushEvents()
        radarPushScheduler.start()
      }
    }

    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const info = await res.json()
      log('INFO', 'telegram_server_connected', { url: this.baseUrl, queueLength: info.queueLength })
      this.startPolling()
    } catch (err) {
      log('WARN', 'telegram_server_unreachable', { url: this.baseUrl, error: String(err) })
      // health 失败时后台重试，不阻塞初始化
      this.scheduleReconnect()
    }
  }

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0

  private scheduleReconnect(): void {
    const delay = Math.min(30000 + this.reconnectAttempts * 10000, 120000)
    log('INFO', 'telegram_reconnect_scheduled', { delay, attempt: this.reconnectAttempts + 1 })
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      try {
        const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(5000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        this.reconnectAttempts = 0
        log('INFO', 'telegram_reconnected', { url: this.baseUrl })
        this.startPolling()
      } catch {
        this.reconnectAttempts++
        this.scheduleReconnect()
      }
    }, delay)
  }

  private startPolling(): void {
    this.isRunning = true
    this.pollTimer = setInterval(() => this.poll(), 1000)
    log('INFO', 'telegram_polling_started', { url: this.baseUrl, pushChatId: this.pushChatId })
  }

  private staleCleanupCounter = 0

  private async poll(): Promise<void> {
    if (!this.isRunning) return
    try {
      const res = await fetch(`${this.baseUrl}/poll`, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) return
      const data = await res.json()
      if (!data.messages?.length) return
      for (const msg of data.messages as TelegramMessage[]) {
        await this.handleMessage(msg)
      }
    } catch {
      /* 超时或网络错误，静默忽略 */
    }

    // 每 30 次 poll 清理一次孤儿 push session（防泄漏）
    this.staleCleanupCounter++
    if (this.staleCleanupCounter >= 30) {
      this.staleCleanupCounter = 0
      this.cleanupStalePushSessions()
    }

    if (this.retryQueue.length > 0) {
      const batchSize = Math.min(this.retryQueue.length, 5)
      for (let j = 0; j < batchSize; j++) {
        const msg = this.retryQueue.shift()!
        try {
          await this.handleMessage(msg)
        } catch {
          /* 丢弃 */
        }
      }
    }
  }

  private async handleMessage(msg: TelegramMessage): Promise<void> {
    log('INFO', 'telegram_msg', { from: msg.from, type: msg.type, text: msg.text?.slice(0, 100) })

    if (msg.type === 'command') {
      if (msg.command === 'clear') this.agentService.clearContext()
      return
    }
    if (!msg.text) return

    const chatId = msg.chatId
    const userText = msg.text
    const botName = msg.bot || 'chat'

    // gen bot → 直连 CogView 生图，不走 Agent
    if (botName === 'gen') {
      this.handleGenBotMessage(chatId, userText)
      return
    }

    const existing = this.activeSessions.get(sessionKey(chatId, botName))
    if (existing) this.cleanupSession(chatId, botName)

    // sendMessage 仍需同步获取 messageId，不走 outbox
    const initialText = `👤 你: ${userText}\n\n🤖 秋山澪 AI 处理中...\n  ⏳ 正在分析请求`
    const progressMsgId = await this.sendMessageSync(chatId, initialText, botName)
    if (progressMsgId === null) {
      // sendMessageSync 失败（网络/服务器不可达），退化到直接处理 + outbox 回复
      try {
        const result = await this.agentService.processTextInput(msg.text, undefined, 'telegram', {
          telegramChatId: msg.chatId,
          telegramUserId: msg.userId,
          telegramFrom: msg.from,
          telegramMessageId: msg.messageId,
        })
        if (result.reply) {
          this.enqueueReply(msg.chatId, result.reply, 'dialogue', botName)
        } else if (result.error === 'BUSY') {
          this.enqueueReply(
            msg.chatId,
            `👤 ${userText}\n\n⏳ 秋山澪正在处理其他请求，你的消息已加入队列，处理完成后会自动回复`,
            'dialogue',
            botName,
          )
          insertOutbox({ chatId: String(chatId), msgType: 'reply', category: 'dialogue', message: userText })
        } else if (result.error) {
          this.enqueueReply(msg.chatId, `❌ 错误: ${result.error}`, 'dialogue', botName)
        } else {
          this.enqueueReply(msg.chatId, '❌ 处理失败，未获得有效回复', 'dialogue', botName)
        }
      } catch (err) {
        log('ERROR', 'telegram_process_error', { error: String(err) })
        this.enqueueReply(msg.chatId, '❌ 系统内部错误，请稍后重试', 'dialogue', botName)
      }
      return
    }

    const toolLines: ToolLine[] = []
    const disposers: (() => void)[] = []
    const editor = new DebouncedEditor()

    disposers.push(
      eventBus.on('agent.tool.invoked', (p) => {
        toolLines.push({ name: p.tool, status: 'running' })
        this.refreshProgressMessage(chatId, progressMsgId, userText, toolLines, editor)
      }),
    )
    disposers.push(
      eventBus.on('agent.tool.completed', (p) => {
        const line = toolLines.find((l) => l.name === p.tool && l.status === 'running')
        if (line) {
          line.status = 'done'
          line.latencyMs = (p as any).latencyMs || 0
        }
        this.refreshProgressMessage(chatId, progressMsgId, userText, toolLines, editor)
        this.handleToolPhoto(chatId, p.tool, p.result)
      }),
    )
    disposers.push(
      eventBus.on('agent.tool.failed', (p) => {
        const line = toolLines.find((l) => l.name === p.tool && l.status === 'running')
        if (line) line.status = 'failed'
        this.refreshProgressMessage(chatId, progressMsgId, userText, toolLines, editor)
      }),
    )

    const typingTimer = setInterval(() => {
      this.enqueueAction(chatId, 'typing', botName)
    }, 4000)

    this.activeSessions.set(sessionKey(chatId, botName), {
      messageId: progressMsgId,
      bot: botName,
      toolLines,
      typingTimer,
      disposers,
      editor,
    })

    // ⏱ 超时预警：处理超过 20 秒未返回时告知用户
    const timeoutNoticeTimer = setTimeout(() => {
      this.enqueueEdit(chatId, progressMsgId, `👤 你: ${userText}\n\n━━━━━━━━━━━━━━━━━━━━\n\n⚠️ 正在恢复中，请稍候……`, botName)
    }, 20000)

    try {
      const result = await this.agentService.processTextInput(msg.text, undefined, 'telegram', {
        telegramChatId: msg.chatId,
        telegramUserId: msg.userId,
        telegramFrom: msg.from,
        telegramMessageId: msg.messageId,
      })
      clearTimeout(timeoutNoticeTimer)

      if (result.reply) {
        const finalText = `👤 你: ${userText}\n\n━━━━━━━━━━━━━━━━━━━━\n\n🤖 秋山澪: ${result.reply}`
        editor.cancel()
        this.enqueueEdit(chatId, progressMsgId, finalText, botName)
        log('INFO', 'telegram_reply_enqueued', { chatId, msgId: progressMsgId, replyLen: result.reply.length })
      } else if (result.error) {
        if (result.error === 'BUSY') {
          const busyText = `👤 你: ${userText}\n\n⏳ 秋山澪正在处理其他请求，你的消息已加入队列，处理完会自动回复`
          editor.cancel()
          this.enqueueEdit(chatId, progressMsgId, busyText, botName)
          insertOutbox({ chatId: String(chatId), msgType: 'reply', category: 'dialogue', message: userText })
          if (this.retryQueue.length < 100) {
            this.retryQueue.push(msg)
          }
          log('INFO', 'telegram_busy_requeue', { text: msg.text?.slice(0, 50), queueSize: this.retryQueue.length })
        } else {
          const errorText = `👤 你: ${userText}\n\n━━━━━━━━━━━━━━━━━━━━\n\n❌ ${result.error}`
          editor.cancel()
          this.enqueueEdit(chatId, progressMsgId, errorText, botName)
        }
      } else {
        log('WARN', 'telegram_empty_reply_no_error', { chatId, text: userText.slice(0, 100) })
        editor.cancel()
        const fallbackText = `👤 你: ${userText}\n\n━━━━━━━━━━━━━━━━━━━━\n\n🤖 秋山澪: 嗯，我在呢。想聊什么？`
        this.enqueueEdit(chatId, progressMsgId, fallbackText, botName)
      }
    } catch (err) {
      clearTimeout(timeoutNoticeTimer)
      log('ERROR', 'telegram_process_error', { error: String(err) })
      const errorText = `👤 你: ${userText}\n\n━━━━━━━━━━━━━━━━━━━━\n\n❌ 抱歉，处理失败，请重新发送。`
      editor.cancel()
      this.enqueueEdit(chatId, progressMsgId, errorText, botName)
    } finally {
      this.cleanupSession(chatId, botName)
    }
  }

  // ── 主动推送：全部系统事件 → Telegram ──

  private subscribePushEvents(): void {
    if (this.pushEventsSubscribed) return
    this.pushEventsSubscribed = true
    const chatId = this.pushChatId
    if (!chatId) return

    // === 💬 对话 ===
    eventBus.on('agent.input.received', (p: any) => {
      if (p.source !== 'electron') return
      // ★ 修复：透传 requestId 用于响应精确匹配
      this.handlePushInput(chatId, p.text, p.requestId)
    })
    eventBus.on('agent.response.generated', (p: any) => {
      if (p.source !== 'electron') return
      // ★ 修复：通过 requestId 精确匹配到对应的 push session
      this.handlePushResponse(chatId, p.text, p.requestId)
    })

    // === 🧬 进化 ===
    eventBus.on('evolution.cycle.started', (p: any) => {
      const lines = ['🧬 秋山澪 - 自进化检查']
      lines.push(`系统正在进行每 ${p.historyCount > 0 ? '2 小时' : '首次'} 的例行自我检查`)
      lines.push('')
      lines.push('📋 检查项目：')
      lines.push('  1. 系统配置是否正确（参数有没有被人改偏）')
      lines.push('  2. 代码质量有没有退化（bug、坏味道）')
      lines.push('  3. 运行状态是否健康（内存、超时、异常）')
      lines.push('  4. 计划任务是否在正常推进')
      if (p.failures > 0) lines.push(`\n⚠️ 注意：上次检查失败了 ${p.failures} 次，本次会更保守`)
      if (p.strategyName === 'conservative') lines.push('🔒 当前处于保守模式，只检查不修改')
      this.enqueueReply(chatId, lines.join('\n'), 'evolution')
      log('INFO', 'telegram_push_evolution_start')
    })
    eventBus.on('evolution.cycle.completed', (p: any) => {
      if (p.success && p.summary?.startsWith('预过滤跳过')) {
        const reasonMap: Record<string, string> = {
          recent_cycles_all_idle: '最近几轮检查都没发现问题，系统状态稳定',
          not_enough_time: '距离上次检查时间太短，没必要重复运行',
        }
        const reason = reasonMap[p.summary.replace('预过滤跳过: ', '')] || p.summary.replace('预过滤跳过: ', '')
        const lines = ['🧬 秋山澪 - 自进化检查']
        lines.push('━━━ ⏭ 跳过本轮 ━━━')
        lines.push('')
        lines.push(`原因：${reason}`)
        lines.push('')
        if (p.failures > 0) lines.push(`📊 连续失败次数：${p.failures}`)
        if (p.historyCount > 0) lines.push(`📊 历史检查次数：${p.historyCount}`)
        lines.push('')
        lines.push('✅ 系统运行正常，无需干预')
        this.enqueueReply(chatId, lines.join('\n'), 'evolution')
        return
      }

      const lines = ['🧬 秋山澪 - 自进化检查']
      if (p.success) {
        lines.push('━━━ ✅ 检查完成 ━━━')
      } else {
        lines.push('━━━ ❌ 检查出问题 ━━━')
      }
      lines.push('')
      if (p.durationMs) {
        const secs = Math.round(p.durationMs / 1000)
        const mins = Math.floor(secs / 60)
        lines.push(`⏱ 耗时：${mins > 0 ? `${mins}分` : ''}${secs % 60}秒`)
      }
      if (p.planTitle) {
        lines.push(`📋 当前计划：${p.planTitle}（进度 ${p.planProgress}）`)
      }
      const summary = (p.summary || '').slice(0, 2000)
      if (summary && !summary.startsWith('预过滤跳过')) {
        // LLM 分析摘要直接展示，这才是最有价值的信息
        lines.push('')
        lines.push('📝 分析报告：')
        lines.push(summary)
      }
      this.enqueueReply(chatId, lines.join('\n'), 'evolution')
    })
    eventBus.on('evolution.snapshot.created', (p: any) => {
      this.enqueueReply(chatId, `🧬 快照: ${p.tag} (${p.branch})`, 'evolution')
    })
    eventBus.on('evolution.rollback.completed', (p: any) => {
      this.enqueueReply(chatId, `🧬 回滚${p.success ? '完成' : '失败'}: ${p.level}/${p.ref}`, 'evolution')
    })
    eventBus.on('evolution.proposal.validated', (p: any) => {
      const icon = p.passed ? '✅' : '⚠️'
      this.enqueueReply(chatId, `🧬 提案验证: ${p.proposalId} ${icon} 风险:${p.regressionRisk}`, 'evolution')
    })
    eventBus.on('evolution.action.executed', (p: any) => {
      const lines = ['🧬 秋山澪 - 自动修正']
      if (p.allOk) {
        lines.push('━━━ ✅ 配置修正成功 ━━━')
      } else {
        lines.push('━━━ ⚠️ 部分修正失败 ━━━')
      }
      lines.push('')
      for (const d of p.details || []) {
        if (!d.success) {
          lines.push(`❌ ${d.name} 执行失败：${d.summary}`)
          continue
        }
        if (d.name === 'batch_fix_config') {
          // "修正 4 个配置漂移: xx, yy" → 更清晰
          const items = d.summary.replace('修正 ', '').replace(' 个配置漂移: ', '\n  ')
          lines.push(`📝 修复了以下配置：`)
          lines.push(`  ${items.replace(/, /g, '\n  ')}`)
        } else {
          lines.push(`📝 ${d.summary}`)
        }
      }
      if (p.durationMs) {
        lines.push(`⚡ 全部在 ${p.durationMs}ms 内完成，未使用 AI`)
      }
      this.enqueueReply(chatId, lines.join('\n'), 'evolution')
    })

    // === 🤖 自动修复管道 ===
    eventBus.on('pipeline.started', (p: any) => {
      const lines = ['🤖 秋山澪 - 自动修复管道']
      lines.push('━━━ ⏳ 开始检查 ━━━')
      lines.push('')
      lines.push('运行项目自动化检查项，查找可修复的问题...')
      if (p.timestamp) {
        const time = new Date(p.timestamp).toLocaleString('zh-CN', { hour12: false })
        lines.push(`🕐 ${time}`)
      }
      this.enqueueReply(chatId, lines.join('\n'), 'evolution')
    })

    eventBus.on('pipeline.completed', (p: any) => {
      const lines = ['🤖 秋山澪 - 自动修复管道']
      if (p.fixed > 0 || p.failed > 0) {
        lines.push('━━━ ✅ 本轮执行完成 ━━━')
      } else {
        lines.push('━━━ ⏭ 本轮无需修复 ━━━')
      }
      lines.push('')

      // 概览
      const totalRun = (p.fixed || 0) + (p.failed || 0)
      lines.push(`📊 采集 ${p.collected || 0} 个问题，本轮处理 ${totalRun} 个`)
      if (p.fixed > 0) lines.push(`✅  修复成功：${p.fixed} 个`)
      if (p.failed > 0) lines.push(`❌  修复失败：${p.failed} 个`)
      if (p.queueRemaining > 0) lines.push(`⏳  队列剩余：${p.queueRemaining} 个待处理`)
      lines.push('')

      // 每个修复详情
      const details = p.details || []
      for (const d of details) {
        const icon = d.success ? '✅' : '❌'
        const loc = d.file ? d.file.split('/').pop() + (d.line ? `:${d.line}` : '') : '未知'
        const dur = d.durationMs ? ` (${(d.durationMs / 1000).toFixed(0)}s)` : ''
        if (d.success) {
          lines.push(`${icon} [${d.source}] ${loc}${dur}`)
          if (d.summary && d.summary !== '修复完成') {
            lines.push(`   └ ${d.summary.slice(0, 200)}`)
          }
        } else {
          lines.push(`${icon} [${d.source}] ${d.title?.slice(0, 80) || loc}${dur}`)
          const reason = d.error || d.summary
          if (reason) lines.push(`   └ ${reason.slice(0, 200)}`)
        }
      }

      // 队列头部预览
      if (p.queueRemaining > 0 && details.length > 0) {
        lines.push('')
        lines.push(`📋 待处理列表：`)
      }
      lines.push('')

      lines.push(`⚡ 耗时：${p.durationMs ? (p.durationMs / 1000).toFixed(0) : '?'}s`)
      this.enqueueReply(chatId, lines.join('\n'), 'evolution')
    })

    eventBus.on('pipeline.errored', (p: any) => {
      const lines = ['🤖 秋山澪 - 自动修复管道']
      lines.push('━━━ ❌ 执行异常 ━━━')
      lines.push('')
      lines.push('管道在执行过程中抛出了异常：')
      lines.push('')
      lines.push(`⚠️ ${p.error || '未知错误'}`)
      lines.push('')
      lines.push('⏳ 将在下一周期自动重试')
      this.enqueueReply(chatId, lines.join('\n'), 'evolution')
    })

    // === 🔍 洞察 ===
    eventBus.on('insight.analysis.started', () => {
      this.enqueueReply(chatId, `🔍 洞察分析开始...`, 'insight')
    })
    eventBus.on('insight.analysis.completed', (p: any) => {
      if (p.count > 0) {
        this.enqueueReply(chatId, `🔍 洞察分析完成: ${p.count} 条发现${p.hasValue ? ' (含高价值)' : ''}`, 'insight')
      } else {
        this.enqueueReply(chatId, `🔍 洞察分析完成: 无发现`, 'insight')
      }
    })
    eventBus.on('insight.found', (p: any) => {
      const lines = [`🔍 高价值洞察 x${p.count}`]
      for (const i of (p.insights || []).slice(0, 5)) {
        lines.push(`  • ${i.title} (${i.score}分/${Math.round(i.confidence * 100)}%置信)`)
      }
      if (p.insights?.length > 5) lines.push(`  ... 还有 ${p.insights.length - 5} 条`)
      this.enqueueReply(chatId, lines.join('\n'), 'insight')
    })

    // === 💡 创意 ===
    eventBus.on('creativity.cycle.started', () => {
      this.enqueueReply(chatId, `💡 创意生成开始...`, 'creativity')
    })
    eventBus.on('creativity.cycle.completed', (p: any) => {
      if (p.count > 0 && p.hasValue) {
        this.enqueueReply(chatId, `💡 创意生成完成: ${p.count} 个新想法`, 'creativity')
      } else if (p.count > 0) {
        this.enqueueReply(chatId, `💡 创意生成完成: ${p.count} 个想法全部重复`, 'creativity')
      } else {
        this.enqueueReply(chatId, `💡 创意生成完成: 无新想法`, 'creativity')
      }
    })
    eventBus.on('creativity.dream.completed', (p: any) => {
      this.enqueueReply(chatId, `💡 梦境完成: ${p.count} 个组合, 最高新颖度 ${p.topNovelty}%`, 'creativity')
    })
    eventBus.on('creativity.ideas.generated', (p: any) => {
      const lines = [`💡 创意想法 x${p.count}`]
      for (const idea of (p.ideas || []).slice(0, 3)) {
        const src = Array.isArray(idea.sourceLabels) ? idea.sourceLabels.join(' × ') : ''
        lines.push(``)
        lines.push(`📌 ${idea.title}`)
        lines.push(`  来源: ${src}`)
        lines.push(`  评分: 新颖 ${idea.novelty}% · 可行 ${idea.feasibility}% · 影响 ${idea.impact}%`)
        if (idea.idea) {
          lines.push(`  ${idea.idea}`)
        }
        if (idea.expectedBenefit) {
          lines.push(`  ✅ ${idea.expectedBenefit}`)
        }
        if (idea.risk) {
          lines.push(`  ⚠️ ${idea.risk}`)
        }
      }
      if (p.ideas?.length > 3) lines.push(`\n  ... 还有 ${p.ideas.length - 3} 条`)
      this.enqueueReply(chatId, lines.join('\n'), 'creativity')
    })

    // === 📋 计划 ===
    eventBus.on('agent.plan.created', (p: any) => {
      this.enqueueReply(chatId, `📋 计划创建: ${p.title}`, 'plan')
    })
    eventBus.on('agent.plan.step', (p: any) => {
      this.enqueueReply(chatId, `📋 计划步骤: #${p.stepIndex} ${p.status}`, 'plan')
    })
    eventBus.on('agent.plan.completed', (p: any) => {
      this.enqueueReply(chatId, `📋 计划完成: ${p.planId}`, 'plan')
    })

    // === ⚡ 预算 ===
    eventBus.on('budget.exhausted', (p: any) => {
      this.enqueueReply(chatId, `⚡ 预算耗尽: ${p.resource} (使用率 ${Math.round(p.utilization * 100)}%)`, 'budget')
    })
    eventBus.on('budget.restored', (p: any) => {
      this.enqueueReply(chatId, `⚡ 预算恢复: ${p.resource}`, 'budget')
    })

    // === 🔄 恢复 ===
    eventBus.on('recovery.checkpoint.created', (p: any) => {
      this.enqueueReply(chatId, `🔄 检查点: ${p.trigger}`, 'recovery')
    })
    eventBus.on('recovery.session.restored', (p: any) => {
      this.enqueueReply(chatId, `🔄 会话恢复: ${p.runId}${p.hasUnfinishedPlan ? ' (有未完成计划)' : ''}`, 'recovery')
    })
    eventBus.on('recovery.error.classified', (p: any) => {
      this.enqueueReply(chatId, `🔄 错误分类: ${p.category} → ${p.strategy}`, 'recovery')
    })
    eventBus.on('recovery.recovery.completed', (p: any) => {
      const icon = p.success ? '✅' : '❌'
      this.enqueueReply(chatId, `🔄 恢复${p.success ? '完成' : '失败'}: ${p.newRunId}`, 'recovery')
    })

    // === 📊 稳定性（仅状态变更时推送，避免每60秒刷屏） ===
    eventBus.on('stability.status.changed', (p: any) => {
      this.enqueueReply(chatId, `📊 稳定性状态变更: ${p.previous} → ${p.current} (${p.score}分)`, 'stability')
    })

    // === 📡 雷达（发到独立的群组 chat，不混入个人推送） ===
    eventBus.on('radar.push.rule_fired', (p: any) => {
      const rawChatId = credentialsManager.get('radar_chat_id')
      const targetChatId = rawChatId ? parseInt(rawChatId, 10) : chatId
      if (!isNaN(targetChatId)) {
        this.enqueueReply(targetChatId, p.message, 'radar')
      }
    })

    // === ⚙️ 系统 ===
    eventBus.on('plugin.registered', (p: any) => {
      this.enqueueReply(chatId, `⚙️ 插件加载: ${p.name} v${p.version} (${p.toolCount} 工具)`, 'system')
    })
    eventBus.on('plugin.unregistered', (p: any) => {
      this.enqueueReply(chatId, `⚙️ 插件卸载: ${p.name}${p.reason ? ` (${p.reason})` : ''}`, 'system')
    })
    eventBus.on('plugin.error', (p: any) => {
      this.enqueueReply(chatId, `⚙️ 插件错误: ${p.name} [${p.phase}]: ${p.error}`, 'system')
    })
    eventBus.on('engine.registered', (p: any) => {
      this.enqueueReply(chatId, `⚙️ 引擎注册: ${p.name} (${p.type})`, 'system')
    })
    eventBus.on('engine.unregistered', (p: any) => {
      this.enqueueReply(chatId, `⚙️ 引擎卸载: ${p.name}`, 'system')
    })
    eventBus.on('engine.activated', (p: any) => {
      this.enqueueReply(chatId, `⚙️ 引擎激活: ${p.name}${p.previous ? ` (从 ${p.previous})` : ''}`, 'system')
    })
    eventBus.on('skill.enabled', (p: any) => {
      this.enqueueReply(chatId, `⚙️ 技能启用: ${p.name}`, 'system')
    })
    eventBus.on('skill.disabled', (p: any) => {
      this.enqueueReply(chatId, `⚙️ 技能禁用: ${p.name}${p.reason ? ` (${p.reason})` : ''}`, 'system')
    })
  }

  private async handlePushInput(chatId: number, text: string, requestId: string): Promise<void> {
    const initialText = `👤 你: ${text}\n\n🤖 秋山澪 AI 处理中...\n  ⏳ 正在处理`
    const msgId = await this.sendMessageSync(chatId, initialText, 'chat')
    if (msgId === null) return

    const editor = new DebouncedEditor()
    const toolLines: ToolLine[] = []

    // 如果已存在相同 requestId 的 session（极端情况），先清理
    if (this.pushSessions.has(requestId)) {
      this.cleanupPushSession(requestId)
    }

    const d1 = eventBus.on('agent.tool.invoked', (p: any) => {
      const session = this.pushSessions.get(requestId)
      if (!session) return
      session.toolLines.push({ name: p.tool, status: 'running' })
      this.refreshPushMessage(chatId, msgId, text, session.toolLines, editor)
    })
    const d2 = eventBus.on('agent.tool.completed', (p: any) => {
      const session = this.pushSessions.get(requestId)
      if (!session) return
      const line = session.toolLines.find((l) => l.name === p.tool && l.status === 'running')
      if (line) {
        line.status = 'done'
        line.latencyMs = (p as any).latencyMs || 0
      }
      this.refreshPushMessage(chatId, msgId, text, session.toolLines, editor)
      this.handleToolPhoto(chatId, p.tool, p.result)
    })
    const d3 = eventBus.on('agent.tool.failed', (p: any) => {
      const session = this.pushSessions.get(requestId)
      if (!session) return
      const line = session.toolLines.find((l) => l.name === p.tool && l.status === 'running')
      if (line) line.status = 'failed'
      this.refreshPushMessage(chatId, msgId, text, session.toolLines, editor)
    })

    const typingTimer = setInterval(() => this.enqueueAction(chatId, 'typing'), 4000)

    this.pushSessions.set(requestId, {
      messageId: msgId,
      userText: text,
      toolLines,
      editor,
      typingTimer,
      disposers: [d1, d2, d3],
      createdAt: Date.now(),
    })
  }

  private async handlePushResponse(chatId: number, reply: string, requestId: string): Promise<void> {
    const session = this.pushSessions.get(requestId)
    if (session) {
      const finalText = `👤 你: ${session.userText}\n\n━━━━━━━━━━━━━━━━━━━━\n\n🤖 秋山澪: ${reply}`
      session.editor.flushNow()
      this.enqueueEdit(chatId, session.messageId, finalText)
      this.cleanupPushSession(requestId)
    } else {
      this.enqueueReply(chatId, reply)
    }
  }

  private refreshPushMessage(chatId: number, msgId: number, userText: string, toolLines: ToolLine[], editor: DebouncedEditor): void {
    const lines: string[] = [`👤 你: ${userText}\n`]
    let hasRunning = false
    for (const tl of toolLines) {
      if (tl.status === 'running') {
        lines.push(`  ⏳ ${simplifyToolName(tl.name)}`)
        hasRunning = true
      } else if (tl.status === 'done') {
        const ms = tl.latencyMs ? ` (${(tl.latencyMs / 1000).toFixed(1)}s)` : ''
        lines.push(`  ✅ ${simplifyToolName(tl.name)}${ms}`)
      } else {
        lines.push(`  ❌ ${simplifyToolName(tl.name)}`)
      }
    }
    if (!hasRunning && toolLines.length > 0) lines.push('\n✍️ 正在生成回复...')
    editor.schedule(chatId, msgId, lines.join('\n'), 'chat')
  }

  private cleanupPushSession(requestId: string): void {
    const session = this.pushSessions.get(requestId)
    if (!session) return
    for (const d of session.disposers) d()
    if (session.typingTimer) clearInterval(session.typingTimer)
    session.editor.flushNow()
    this.pushSessions.delete(requestId)
  }

  /** 清理 10 分钟前的孤儿 push session（防泄漏） */
  private cleanupStalePushSessions(): void {
    const now = Date.now()
    for (const [requestId, session] of this.pushSessions) {
      if (now - session.createdAt > 600_000) {
        this.cleanupPushSession(requestId)
      }
    }
  }

  // ── Outbox 写入 ──

  private enqueueReply(chatId: number, text: string, category?: OutboxCategory, bot?: string): void {
    insertOutbox({
      chatId: String(chatId),
      bot: (bot || (category && ROUTING[category]) || 'chat') as any,
      msgType: 'reply',
      category,
      message: text,
    })
    this.tryReactivateOutbox()
  }

  private enqueueEdit(chatId: number, targetMessageId: number, text: string, bot: string = 'chat'): void {
    const inserted = insertOutbox({ chatId: String(chatId), bot: bot as any, msgType: 'edit', message: text, targetMessageId })
    log('DEBUG', 'telegram_enqueue_edit', { chatId, targetMessageId, inserted, textLen: text.length })
    this.tryReactivateOutbox()
  }

  private enqueueAction(chatId: number, action: string, bot: string = 'chat'): void {
    insertOutbox({ chatId: String(chatId), bot: bot as any, msgType: 'action', message: action })
    this.tryReactivateOutbox()
  }

  /** sendMessage 需要同步拿到 messageId，因此直接 HTTP 调用 */
  private async sendMessageSync(chatId: number, text: string, bot: string = 'chat'): Promise<number | null> {
    try {
      const res = await fetch(`${this.baseUrl}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, text, bot }),
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) return null
      const data = await res.json()
      return data.messageId ?? null
    } catch {
      return null
    }
  }

  private refreshProgressMessage(chatId: number, msgId: number, userText: string, toolLines: ToolLine[], editor: DebouncedEditor): void {
    const lines: string[] = [`👤 你: ${userText}\n`]
    let hasRunning = false
    for (const tl of toolLines) {
      if (tl.status === 'running') {
        lines.push(`  ⏳ ${simplifyToolName(tl.name)}`)
        hasRunning = true
      } else if (tl.status === 'done') {
        const ms = tl.latencyMs ? ` (${(tl.latencyMs / 1000).toFixed(1)}s)` : ''
        lines.push(`  ✅ ${simplifyToolName(tl.name)}${ms}`)
      } else {
        lines.push(`  ❌ ${simplifyToolName(tl.name)}`)
      }
    }
    if (!hasRunning && toolLines.length > 0) lines.push('\n✍️ 正在生成回复...')
    editor.schedule(chatId, msgId, lines.join('\n'))
  }

  // ── gen bot：直连 ComfyUI 生图，不经过 Agent 对话 ──

  private async handleGenBotMessage(chatId: number, prompt: string): Promise<void> {
    const COMFYUI_URL = process.env.COMFYUI_URL || 'http://127.0.0.1:8188'

    try {
      const r = await fetch(`${COMFYUI_URL}/system_stats`, { signal: AbortSignal.timeout(5000) })
      if (!r.ok) throw new Error('not ok')
    } catch {
      this.sendGenReply(chatId, '❌ ComfyUI 未运行')
      return
    }

    const statusMsgId = await this.sendMessageSync(chatId, '⏳ ComfyUI 生成中...', 'gen')
    if (statusMsgId === null) return

    try {
      const seed = Math.floor(Math.random() * 2 ** 32)
      const workflow = {
        '3': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['11', 0] } },
        '4': {
          class_type: 'KSampler',
          inputs: {
            seed,
            steps: 4,
            cfg: 1,
            sampler_name: 'euler',
            scheduler: 'simple',
            denoise: 1,
            model: ['10', 0],
            positive: ['3', 0],
            negative: ['7', 0],
            latent_image: ['12', 0],
          },
        },
        '7': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, low quality, distorted', clip: ['11', 0] } },
        '8': { class_type: 'VAEDecode', inputs: { samples: ['4', 0], vae: ['13', 0] } },
        '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'gen_bot' } },
        '10': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'flux-schnell\\flux1-schnell-Q4_K_S.gguf' } },
        '11': {
          class_type: 'DualCLIPLoaderGGUF',
          inputs: { clip_name1: 'clip_l.safetensors', clip_name2: 't5-v1_1-xxl-encoder-Q6_K.gguf', type: 'flux' },
        },
        '12': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
        '13': { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
      }
      const wfRes = await fetch(`${COMFYUI_URL}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: workflow }),
        signal: AbortSignal.timeout(30000),
      })
      if (!wfRes.ok) {
        this.sendGenReply(chatId, `❌ ComfyUI 提交失败 (${wfRes.status})`)
        const b = await wfRes.text().catch(() => '')
        log('WARN', 'telegram_gen_comfyui_submit_fail', { status: wfRes.status, body: b.slice(0, 200) })
        return
      }
      const { prompt_id } = (await wfRes.json()) as { prompt_id: string }
      log('INFO', 'telegram_gen_comfyui_submitted', { prompt_id })

      // 轮询结果
      const t0 = Date.now()
      let imageBuffer: Buffer | null = null
      while (Date.now() - t0 < 300000) {
        await new Promise((r) => setTimeout(r, 1500))
        try {
          const histRes = await fetch(`${COMFYUI_URL}/history/${prompt_id}`, { signal: AbortSignal.timeout(5000) })
          if (!histRes.ok) continue
          const history = (await histRes.json()) as Record<string, any>
          const entry = history[prompt_id]
          if (!entry?.outputs) continue
          for (const nodeId of Object.keys(entry.outputs)) {
            for (const img of entry.outputs[nodeId].images || []) {
              if (img.type !== 'output') continue
              const viewUrl = `${COMFYUI_URL}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || '')}&type=output`
              const imgRes = await fetch(viewUrl)
              if (imgRes.ok) {
                imageBuffer = Buffer.from(await imgRes.arrayBuffer())
                break
              }
            }
            if (imageBuffer) break
          }
          if (imageBuffer) break
        } catch {
          /* retry */
        }
      }

      if (!imageBuffer) {
        this.sendGenReply(chatId, '⏰ ComfyUI 生成超时')
        return
      }

      // 发图到 Telegram
      fetch(`${this.baseUrl}/photo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, photo: imageBuffer.toString('base64'), caption: `🎨 ${prompt}`, bot: 'gen' }),
        signal: AbortSignal.timeout(60000),
      }).catch((err) => log('WARN', 'telegram_gen_send_photo_error', { error: String(err) }))

      log('INFO', 'telegram_gen_completed', { chatId, prompt: prompt.slice(0, 50) })
    } catch (err) {
      log('ERROR', 'telegram_gen_error', { error: String(err) })
      this.sendGenReply(chatId, `❌ 生图失败: ${String(err).slice(0, 100)}`)
    }
  }

  private sendGenReply(chatId: number, text: string): void {
    insertOutbox({ chatId: String(chatId), bot: 'gen', msgType: 'reply', category: 'dialogue', message: text })
  }

  // ── 图片处理：生图工具完成 → 发送图片到 Telegram ──

  private handleToolPhoto(chatId: number, tool: string, result: string): void {
    if (tool !== 'generate_image') return
    if (!result) return

    // 从结果中提取图片文件路径（行: "文件: /some/path.png"）
    const filePaths: string[] = []
    for (const line of result.split('\n')) {
      const m = line.match(/^文件:\s*(.+\.\w+)$/)
      if (m) filePaths.push(m[1].trim())
    }
    if (filePaths.length === 0) {
      log('WARN', 'telegram_handle_tool_photo_no_file', { result: result.slice(0, 200) })
      return
    }

    for (const filePath of filePaths) {
      try {
        const photoBuffer = require('fs').readFileSync(filePath)
        const base64 = photoBuffer.toString('base64')
        // 直接发送到代理服务器（不走 outbox，避免 SQLite 存巨量 base64）
        fetch(`${this.baseUrl}/photo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId, photo: base64, bot: 'gen' }),
          signal: AbortSignal.timeout(60000),
        })
          .then((r) => {
            if (r.ok) log('INFO', 'telegram_photo_sent', { chatId, filePath })
            else r.text().then((t) => log('WARN', 'telegram_photo_send_failed', { status: r.status, error: t.slice(0, 200) }))
          })
          .catch((err) => log('WARN', 'telegram_photo_send_error', { error: String(err) }))
      } catch (err) {
        log('WARN', 'telegram_handle_tool_photo_failed', { filePath, error: String(err) })
      }
    }
  }

  stop(): void {
    // 清理所有 push sessions
    for (const requestId of this.pushSessions.keys()) {
      this.cleanupPushSession(requestId)
    }
    for (const key of this.activeSessions.keys()) {
      this.cleanupSessionByKey(key)
    }
    this.isRunning = false
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    log('INFO', 'telegram_polling_stopped')
  }

  private cleanupSession(chatId: number, bot: string): void {
    this.cleanupSessionByKey(sessionKey(chatId, bot))
  }

  private cleanupSessionByKey(key: string): void {
    const session = this.activeSessions.get(key)
    if (!session) return
    if (session.typingTimer) clearInterval(session.typingTimer)
    for (const d of session.disposers) d()
    session.editor.flushNow()
    this.activeSessions.delete(key)
  }
}

function sessionKey(chatId: number, bot: string): string {
  return `${chatId}:${bot}`
}

function simplifyToolName(name: string): string {
  return name.replace(/^.*[/\\]/, '').replace(/_/g, ' ')
}
