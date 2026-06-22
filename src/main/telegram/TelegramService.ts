import { AgentService } from '../agent/AgentService'
import { log } from '../logger/Logger'
import { credentialsManager } from '../credentials/CredentialsManager'
import { eventBus } from '../core/EventBus'
import { insertOutbox, type OutboxCategory } from '../db/outbox'

interface TelegramMessage {
  type: 'message' | 'command'
  messageId?: number
  chatId: number
  text?: string
  command?: string
  from: string
  userId?: number
  timestamp: number
}

interface ToolLine {
  name: string
  status: 'running' | 'done' | 'failed'
  latencyMs?: number
}

/** 延迟编辑调度：将频繁的 progress 更新 debounce 后直接 HTTP 编辑（不走 outbox，保证实时性） */
export class DebouncedEditor {
  private baseUrl = ''
  private timer: ReturnType<typeof setTimeout> | null = null
  private pendingChatId = 0
  private pendingText = ''
  private pendingTargetMsgId = 0

  /** 在 TelegramService 初始化后设置真实的 baseUrl */
  setBaseUrl(url: string): void {
    this.baseUrl = url
  }

  schedule(chatId: number, targetMessageId: number, text: string): void {
    this.pendingChatId = chatId
    this.pendingText = text
    this.pendingTargetMsgId = targetMessageId
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
    number,
    {
      messageId: number
      toolLines: ToolLine[]
      typingTimer: ReturnType<typeof setInterval> | null
      disposers: (() => void)[]
      editor: DebouncedEditor
    }
  >()
  private pushChatId: number | null = null
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

  async initialize(): Promise<void> {
    const url = credentialsManager.get('telegram_server_url') || process.env.TELEGRAM_SERVER_URL || 'https://skills.crlkcloud.cyou/telegram'
    this.baseUrl = url.replace(/\/+$/, '')

    // 所有 DebouncedEditor 共享 baseUrl
    DebouncedEditor.prototype.setBaseUrl(this.baseUrl)

    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const info = await res.json()
      log('INFO', 'telegram_server_connected', { url: this.baseUrl, queueLength: info.queueLength })
    } catch (err) {
      log('WARN', 'telegram_server_unreachable', { url: this.baseUrl, error: String(err) })
      return
    }

    const rawChatId = credentialsManager.get('telegram_chat_id') || process.env.TELEGRAM_CHAT_ID
    if (rawChatId) {
      this.pushChatId = parseInt(rawChatId, 10)
      if (isNaN(this.pushChatId)) {
        log('WARN', 'telegram_push_invalid_chat_id', { raw: rawChatId })
        this.pushChatId = null
      } else {
        log('INFO', 'telegram_push_enabled', { chatId: this.pushChatId })
        this.subscribePushEvents()
      }
    }

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
    const existing = this.activeSessions.get(chatId)
    if (existing) this.cleanupSession(chatId)

    // sendMessage 仍需同步获取 messageId，不走 outbox
    const initialText = `👤 你: ${userText}\n\n🤖 秋山澪 AI 处理中...\n  ⏳ 正在分析请求`
    const progressMsgId = await this.sendMessageSync(chatId, initialText)
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
          this.enqueueReply(msg.chatId, result.reply)
        } else if (result.error === 'BUSY') {
          this.enqueueReply(msg.chatId, `👤 ${userText}\n\n⏳ 秋山澪正在处理其他请求，你的消息已加入队列，处理完成后会自动回复`)
          insertOutbox({ chatId: String(chatId), msgType: 'reply', category: 'dialogue', message: userText })
        } else if (result.error) {
          this.enqueueReply(msg.chatId, `❌ 错误: ${result.error}`)
        } else {
          this.enqueueReply(msg.chatId, '❌ 处理失败，未获得有效回复')
        }
      } catch (err) {
        log('ERROR', 'telegram_process_error', { error: String(err) })
        this.enqueueReply(msg.chatId, '❌ 系统内部错误，请稍后重试')
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
      this.enqueueAction(chatId, 'typing')
    }, 4000)

    this.activeSessions.set(chatId, { messageId: progressMsgId, toolLines, typingTimer, disposers, editor })

    try {
      const result = await this.agentService.processTextInput(msg.text, undefined, 'telegram', {
        telegramChatId: msg.chatId,
        telegramUserId: msg.userId,
        telegramFrom: msg.from,
        telegramMessageId: msg.messageId,
      })

      if (result.reply) {
        const finalText = `👤 你: ${userText}\n\n━━━━━━━━━━━━━━━━━━━━\n\n🤖 秋山澪: ${result.reply}`
        editor.cancel()
        this.enqueueEdit(chatId, progressMsgId, finalText)
        log('INFO', 'telegram_reply_enqueued', { chatId, msgId: progressMsgId, replyLen: result.reply.length })
      } else if (result.error) {
        if (result.error === 'BUSY') {
          const busyText = `👤 你: ${userText}\n\n⏳ 秋山澪正在处理其他请求，你的消息已加入队列，处理完会自动回复`
          editor.cancel()
          this.enqueueEdit(chatId, progressMsgId, busyText)
          insertOutbox({ chatId: String(chatId), msgType: 'reply', category: 'dialogue', message: userText })
          if (this.retryQueue.length < 100) {
            this.retryQueue.push(msg)
          }
          log('INFO', 'telegram_busy_requeue', { text: msg.text?.slice(0, 50), queueSize: this.retryQueue.length })
        } else {
          const errorText = `👤 你: ${userText}\n\n━━━━━━━━━━━━━━━━━━━━\n\n❌ ${result.error}`
          editor.cancel()
          this.enqueueEdit(chatId, progressMsgId, errorText)
        }
      } else {
        // ★ 兜底：reply 和 error 都为空时不再静默失败
        log('WARN', 'telegram_empty_reply_no_error', { chatId, text: userText.slice(0, 100) })
        editor.cancel()
        const fallbackText = `👤 你: ${userText}\n\n━━━━━━━━━━━━━━━━━━━━\n\n🤖 秋山澪: 嗯，我在呢。想聊什么？`
        this.enqueueEdit(chatId, progressMsgId, fallbackText)
      }
    } catch (err) {
      log('ERROR', 'telegram_process_error', { error: String(err) })
      this.retryQueue.push(msg)
    } finally {
      this.cleanupSession(chatId)
    }
  }

  // ── 主动推送：全部系统事件 → Telegram ──

  private subscribePushEvents(): void {
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
      const lines = ['🧬 AI 自进化系统']
      lines.push(`━━━ 分析开始 ━━━`)
      if (p.mode) lines.push(`状态: ${p.mode}`)
      if (p.failures !== undefined && p.failures > 0) lines.push(`连续失败: ${p.failures} 次`)
      if (p.strategyName) lines.push(`策略: ${p.strategyName}`)
      if (p.historyCount !== undefined) lines.push(`历史记录: ${p.historyCount} 条`)
      lines.push(`\n📋 正在分析系统状态、检测退化、检查计划 Integrity...`)
      this.enqueueReply(chatId, lines.join('\n'), 'evolution')
      log('INFO', 'telegram_push_evolution_start')
    })
    eventBus.on('evolution.cycle.completed', (p: any) => {
      const lines = ['🧬 AI 自进化系统']
      if (p.success) lines.push(`━━━ ✅ 分析完成 ━━━`)
      else lines.push(`━━━ ❌ 分析失败 ━━━`)
      if (p.durationMs) {
        const secs = Math.round(p.durationMs / 1000)
        const mins = Math.floor(secs / 60)
        lines.push(`耗时: ${mins > 0 ? `${mins}分` : ''}${secs % 60}秒`)
      }
      if (p.mode) lines.push(`状态: ${p.mode}`)
      if (p.planTitle) {
        lines.push(`计划: ${p.planTitle}${p.planProgress ? ` (${p.planProgress})` : ''}`)
      }
      const summary = (p.summary || '').slice(0, 600)
      if (summary) lines.push(`\n📝 ${summary}`)
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
        lines.push(`  • ${idea.title} (新颖:${idea.novelty}% 可行:${idea.feasibility}% 影响:${idea.impact}%)`)
      }
      if (p.ideas?.length > 3) lines.push(`  ... 还有 ${p.ideas.length - 3} 条`)
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
    const msgId = await this.sendMessageSync(chatId, initialText)
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
    editor.schedule(chatId, msgId, lines.join('\n'))
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

  private enqueueReply(chatId: number, text: string, category?: OutboxCategory): void {
    insertOutbox({ chatId: String(chatId), msgType: 'reply', category, message: text })
  }

  private enqueueEdit(chatId: number, targetMessageId: number, text: string): void {
    const inserted = insertOutbox({ chatId: String(chatId), msgType: 'edit', message: text, targetMessageId })
    log('DEBUG', 'telegram_enqueue_edit', { chatId, targetMessageId, inserted, textLen: text.length })
  }

  private enqueueAction(chatId: number, action: string): void {
    insertOutbox({ chatId: String(chatId), msgType: 'action', message: action })
  }

  /** sendMessage 需要同步拿到 messageId，因此直接 HTTP 调用 */
  private async sendMessageSync(chatId: number, text: string): Promise<number | null> {
    try {
      const res = await fetch(`${this.baseUrl}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, text }),
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

  stop(): void {
    // 清理所有 push sessions
    for (const requestId of this.pushSessions.keys()) {
      this.cleanupPushSession(requestId)
    }
    for (const chatId of this.activeSessions.keys()) {
      this.cleanupSession(chatId)
    }
    this.isRunning = false
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    log('INFO', 'telegram_polling_stopped')
  }

  private cleanupSession(chatId: number): void {
    const session = this.activeSessions.get(chatId)
    if (!session) return
    if (session.typingTimer) clearInterval(session.typingTimer)
    for (const d of session.disposers) d()
    // ★ 修复：flush 保留最终进度编辑，不 cancel 丢弃
    session.editor.flushNow()
    this.activeSessions.delete(chatId)
  }
}

function simplifyToolName(name: string): string {
  return name.replace(/^.*[/\\]/, '').replace(/_/g, ' ')
}
