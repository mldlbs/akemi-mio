/**
 * BrowserAgentRuntime — Stagehand 浏览器智能操作运行时
 *
 * 封装 Stagehand SDK，提供 observe / act / extract 三个核心能力。
 * MIO 通过 browser_agent_execute 工具发出语义指令（如"点击登录按钮"），
 * Stagehand 负责解析 accessibility tree、定位元素、执行动作、验证结果。
 *
 * 设计原则：
 * - 不暴露 Playwright 细节，MIO 只关心"做什么"不关心"怎么做"
 * - 持久化 Chromium profile，登录态跨会话保持
 * - 可更换底层模型（通过 CustomOpenAIClient 支持任意兼容 API）
 */

import { Stagehand, CustomOpenAIClient } from '@browserbasehq/stagehand'
import OpenAI from 'openai'
import { app } from 'electron'
import { join } from 'path'
import { log } from '../logger/Logger'
import type {
  BrowserSession,
  PageObservation,
  SemanticAction,
  ActionResult,
  BrowserTask,
  BrowserTaskStep,
  SiteKnowledge,
} from './types'

// =============================================================================
// 单例
// =============================================================================

let _instance: BrowserAgentRuntime | null = null

export function getBrowserAgentRuntime(): BrowserAgentRuntime {
  if (!_instance) {
    _instance = new BrowserAgentRuntime()
  }
  return _instance
}

// =============================================================================
// BrowserAgentRuntime
// =============================================================================

export class BrowserAgentRuntime {
  private stagehand: Stagehand | null = null
  private session: BrowserSession | null = null
  private apiKey: string = ''
  private baseURL: string = 'https://opencode.ai/zen/go/v1'
  private modelName: string = 'deepseek-v4-flash'

  /**
   * 初始化运行时。需要在首次操作前调用。
   */
  async init(): Promise<void> {
    if (this.stagehand) return

    // 从凭证管理器获取 API key
    try {
      const { getCredentialsManager } = await import('../tool/deps')
      const cm = getCredentialsManager()
      this.apiKey = cm?.get('llm_api_key') || process.env.LLM_KEY || ''
    } catch {
      this.apiKey = process.env.LLM_KEY || ''
    }

    // model 配置
    this.modelName = process.env.LLM_VISION_MODEL || process.env.LLM_MODEL || 'deepseek-v4-flash'
    this.baseURL = (process.env.LLM_API_URL || 'https://opencode.ai/zen/go/v1/chat/completions')
      .replace('/chat/completions', '')

    const openai = new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseURL,
    })

    const userDataDir = join(app.getPath('userData'), 'stagehand-profile')

    log('INFO', 'browser_agent_init_start', { modelName: this.modelName, apiKeyLength: this.apiKey.length })

    try {
      this.stagehand = new Stagehand({
        headless: true,
        env: 'LOCAL',
        verbose: 2,
        domSettleTimeoutMs: 10000,
        actTimeoutMs: 30000,
        llmClient: new CustomOpenAIClient({
          modelName: this.modelName,
          client: openai,
        }),
      })

      log('INFO', 'browser_agent_init_calling', {})
      await this.stagehand.init()
      log('INFO', 'browser_agent_init_done', {})

      // 获取 context
      const ctx = this.stagehand.context
      log('INFO', 'browser_agent_init_ctx', { hasCtx: !!ctx })
      if (!ctx) {
        // 有时候 context 延迟可用，等待一会再试
        await new Promise(r => setTimeout(r, 3000))
        const ctx2 = this.stagehand.context
        log('INFO', 'browser_agent_init_ctx_retry', { hasCtx: !!ctx2 })
        if (!ctx2) {
          log('ERROR', 'browser_agent_init_no_context')
          throw new Error('Stagehand init 后 context 为 null（等待 3s 后仍然 null）')
        }
        const page2 = ctx2.pages()?.[0]
        if (!page2) {
          log('ERROR', 'browser_agent_init_no_page')
          throw new Error('Stagehand init 后无可用页面')
        }
        const url = typeof page2.url === 'function' ? await tryCatch(() => page2.url(), 'about:blank') : 'about:blank'
        const title = typeof page2.title === 'function' ? await tryCatch(() => page2.title(), '') : ''
        this.session = {
          id: `stagehand-${Date.now().toString(36)}`,
          state: 'ready' as const,
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
          currentUrl: url,
          currentTitle: title,
        }
        log('INFO', 'browser_agent_ready', { url, title })
        return
      }

      const page = ctx.pages()?.[0]
      log('INFO', 'browser_agent_init_page', { hasPage: !!page, pageType: typeof page })

      if (!page) {
        log('ERROR', 'browser_agent_init_page_null')
        throw new Error('Stagehand init 后 page 为 null/undefined')
      }

      // Playwright 的 page 对象在 Electron 中可能没有 .catch 方法
      const safeUrl = (p: any) => {
        const r = p.url()
        return r instanceof Promise ? r : Promise.resolve(r)
      }
      const safeTitle = (p: any) => {
        const r = p.title()
        return r instanceof Promise ? r : Promise.resolve(r)
      }

      const url = await safeUrl(page).catch(() => 'about:blank')
      const title = await safeTitle(page).catch(() => '')

      this.session = {
        id: `stagehand-${Date.now().toString(36)}`,
        state: 'ready',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        currentUrl: url,
        currentTitle: title,
      }

      log('INFO', 'browser_agent_ready', { model: this.modelName, sessionId: this.session.id, url })
    } catch (err: any) {
      log('ERROR', 'browser_agent_init_failed', { error: err.message, stack: err.stack?.slice(0,500) })
      this.stagehand = null
      throw err
    }
  }

  /**
   * 观察当前页面。
   */
  async observe(instruction?: string): Promise<PageObservation> {
    await this.ensureReady()
    if (!this.stagehand) throw new Error('Stagehand not initialized')

    // Context 可能因浏览器崩溃变为 null，重试机制
    let ctx = this.stagehand.context
    for (let attempt = 0; attempt < 3 && !ctx; attempt++) {
      log('WARN', 'browser_agent_ctx_null', { attempt })
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
      // 尝试重新初始化
      try {
        await this.init()
      } catch {
        // 继续重试
      }
      ctx = this.stagehand?.context || null
    }
    if (!ctx) throw new Error('无法获取浏览器上下文（context 为 null）')

    const pages = ctx.pages()
    if (!pages || pages.length === 0) throw new Error('浏览器上下文无可用页面')

    const page = pages[0]
    const url = page.url()
    const title = await page.title()

    // 获取 accessibility tree
    const obs = await this.stagehand.observe({
      instruction: instruction || '列出当前页面上所有可用于操作的按钮、链接、输入框等交互元素',
    })

    const keyElements = obs.map(o => ({
      selector: o.selector || '',
      description: o.description || '',
      method: (o as any).method || 'click',
    }))

    // 判断登录态
    const loginState = this.inferLoginState(url, title, keyElements)

    // 更新 session
    if (this.session) {
      this.session.currentUrl = url
      this.session.currentTitle = title
      this.session.lastActiveAt = Date.now()
    }

    return {
      url,
      title,
      keyElements,
      loginState,
      observedAt: Date.now(),
    }
  }

  /**
   * 执行语义动作。
   */
  async act(action: SemanticAction): Promise<ActionResult> {
    await this.ensureReady()
    if (!this.stagehand) throw new Error('Stagehand not initialized')

    const startTime = Date.now()

    try {
      // 导航类动作直接用 Playwright page
      if (action.type === 'navigate' && action.value) {
        const page = this.stagehand.context.pages()[0]
        await page.goto(action.value, { waitUntil: 'networkidle', timeout: 30000 })
      }
      // 观察类动作
      else if (action.type === 'observe') {
        const obs = await this.observe()
        return { success: true, observation: obs, durationMs: Date.now() - startTime }
      }
      // 语义动作
      else {
        // 构建 act 指令字符串
        let actInstruction = ''
        switch (action.type) {
          case 'click':
            actInstruction = `点击"${action.target || ''}"`
            break
          case 'fill':
          case 'type':
            actInstruction = `在"${action.target || ''}"输入框中填入"${action.value || ''}"`
            break
          case 'select':
            actInstruction = `选择"${action.value || ''}"`
            break
          case 'scroll':
            actInstruction = `滚动到"${action.target || ''}"`
            break
          case 'wait':
            actInstruction = `等待"${action.target || ''}"出现`
            break
          default:
            actInstruction = `${action.type}: ${action.target || ''} ${action.value || ''}`
        }

        // Stagehand act() 支持两种签名：
        // 1. act(instruction: string)
        // 2. act(action: Action)
        await this.stagehand.act(actInstruction)
      }

      // 观察执行后的页面
      const obs = await this.observe()
      return { success: true, observation: obs, durationMs: Date.now() - startTime }

    } catch (err: any) {
      return {
        success: false,
        error: err.message,
        durationMs: Date.now() - startTime,
      }
    }
  }

  /**
   * 提取页面信息。
   */
  async extract<T = any>(instruction: string, schema: Record<string, any>): Promise<T> {
    await this.ensureReady()
    if (!this.stagehand) throw new Error('Stagehand not initialized')

    const result = await this.stagehand.extract({
      instruction,
      schema,
    })

    return result as T
  }

// ── 内部方法 ──

  private async tryCatch<T>(fn: () => T, fallback: T): Promise<T> {
    try { return await fn() } catch { return fallback }
  }

  /**
   * 关闭运行时而清理资源。
   */
  async close(): Promise<void> {
    if (this.stagehand) {
      try { await this.stagehand.close() } catch {}
      this.stagehand = null
    }
    this.session = null
  }

  // ── 内部方法 ──

  private async ensureReady(): Promise<void> {
    if (!this.stagehand) {
      await this.init()
    }
    if (this.session) {
      this.session.lastActiveAt = Date.now()
    }
  }

  private inferLoginState(
    url: string,
    _title: string,
    elements: Array<{ selector: string; description: string }>,
  ): 'unknown' | 'logged_in' | 'logged_out' | 'login_page' {
    const u = url.toLowerCase()
    const descs = elements.map(e => e.description.toLowerCase()).join(' ')

    // 登录页检测
    if (u.includes('/login') || u.includes('/passport') || u.includes('login')) {
      return 'login_page'
    }

    // 找登录相关元素
    const hasLoginForm = descs.includes('登录') || descs.includes('密码') || descs.includes('验证码')
    const hasUserContent = descs.includes('作品') || descs.includes('章节') || descs.includes('管理')

    if (hasUserContent) return 'logged_in'
    if (hasLoginForm) return 'login_page'

    return 'unknown'
  }
}

// =============================================================================
// 重新导出类型供工具使用
// =============================================================================

export type { PageObservation, SemanticAction, ActionResult, BrowserSession }
