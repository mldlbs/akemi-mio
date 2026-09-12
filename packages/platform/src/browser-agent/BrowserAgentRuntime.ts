/**
 * BrowserAgentRuntime — 浏览器会话运行时 + CDP 动作执行器
 *
 * 统一管理两种浏览器会话：
 * 1. cdp — 通过 CDP 连接用户已有的 Chrome（已登录）
 *
 * 提供核心能力：
 * - connect() — CDP 连接
 * - observe() — 观察页面
 * - act() — 执行语义动作（click / fill / navigate）
 *
 * act() 内部使用 Playwright 的 connectOverCDP，
 * 直接在用户已登录的 Chrome 上操作页面。
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { BrowserSession, PageObservation, ActionResult, CdpEndpoint, CdpConnectResult } from './types'

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
  private session: BrowserSession | null = null
  private pwBrowser: any = null // Playwright Browser (connectOverCDP)
  private pwPage: any = null // Playwright Page

  /**
   * 通过 CDP 连接用户已有的 Chrome 浏览器。
   * 使用 Playwright connectOverCDP 建立完整控制。
   */
  async connect(endpoint?: CdpEndpoint): Promise<CdpConnectResult> {
    const port = endpoint?.port || 9220
    const url = `http://127.0.0.1:${port}`

    log('INFO', 'browser_connect_cdp_start', { url })

    try {
      // 获取页面列表
      const resp = await fetch(`${url}/json`)
      if (!resp.ok) throw new Error(`CDP ${url} 不可达 (HTTP ${resp.status})`)
      const targets = await resp.json()
      const pages = targets.filter((t: any) => t.type === 'page').map((t: any) => ({ url: t.url || '', title: t.title || '' }))

      // 用 Playwright connectOverCDP 建立完整控制连接
      const { chromium } = require('playwright') as any
      this.pwBrowser = await chromium.connectOverCDP(url)
      const ctx = this.pwBrowser.contexts()[0]
      const availablePages = ctx.pages()

      // 找一个已登录番茄的页面
      this.pwPage =
        availablePages.find((p: any) => p.url().includes('fanqienovel') && !p.url().includes('login')) || availablePages[0] || null

      const id = `cdp-${port}-${Date.now().toString(36)}`
      this.session = {
        id,
        source: 'cdp',
        cdpPort: port,
        cdpEndpoint: `ws://127.0.0.1:${port}`,
        state: 'ready',
        currentUrl: this.pwPage?.url() || pages[0]?.url,
        currentTitle: this.pwPage ? '' : pages[0]?.title,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      }

      log('INFO', 'browser_connect_cdp_ok', { id, pages: pages.length, connectedPages: availablePages.length })

      return {
        connected: true,
        pages,
        sessionId: id,
      }
    } catch (err: any) {
      log('ERROR', 'browser_connect_cdp_failed', { url, error: err.message })
      this.cleanup()
      return {
        connected: false,
        pages: [],
        sessionId: '',
        error: `CDP 连接失败: ${err.message}`,
      }
    }
  }

  /**
   * 执行语义动作（在 CDP 连接的 Chrome 上直接操作）。
   */
  async act(action: {
    type: 'navigate' | 'click' | 'fill' | 'observe' | 'evaluate'
    target?: string // 文本或选择器
    value?: string // fill 时的值
  }): Promise<ActionResult> {
    const start = Date.now()

    try {
      if (!this.pwBrowser || !this.session) {
        return { success: false, error: '请先 connect', durationMs: Date.now() - start }
      }

      // 确保有可用 page
      if (!this.pwPage) {
        const ctx = this.pwBrowser.contexts()[0]
        const pages = ctx.pages()
        this.pwPage = pages[0] || (await ctx.newPage())
      }

      const page = this.pwPage

      switch (action.type) {
        case 'navigate': {
          if (!action.value) return { success: false, error: 'navigate 需要 value', durationMs: Date.now() - start }
          await page.goto(action.value, { waitUntil: 'domcontentloaded', timeout: 30000 })
          await page.waitForTimeout(1500)
          break
        }

        case 'click': {
          if (!action.target) return { success: false, error: 'click 需要 target', durationMs: Date.now() - start }

          // 多策略定位：text → role → CSS selector
          let clicked = false

          // 策略 1: 文本匹配
          try {
            const el = page.getByText(action.target, { exact: false }).first()
            if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
              await el.click()
              clicked = true
            }
          } catch {}

          // 策略 2: button/svg 文本匹配
          if (!clicked && action.target.length < 10) {
            try {
              const el = page.locator(`button, a, [role="button"]`).filter({ hasText: action.target }).first()
              if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
                await el.click()
                clicked = true
              }
            } catch {}
          }

          // 策略 3: CSS 选择器
          if (!clicked) {
            try {
              const el = page.locator(action.target).first()
              if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
                await el.click()
                clicked = true
              }
            } catch {}
          }

          if (!clicked) {
            // 兜底：用 evaluate 尝试
            await page.evaluate((text: string) => {
              const els = Array.from(document.querySelectorAll('button, a, div, span'))
              const target = els.find((el) => el.textContent?.trim() === text)
              if (target) (target as HTMLElement).click()
            }, action.target)
          }
          await page.waitForTimeout(1000)
          break
        }

        case 'fill': {
          if (!action.target || action.value === undefined) {
            return { success: false, error: 'fill 需要 target + value', durationMs: Date.now() - start }
          }

          let filled = false

          // 策略 1: 通过 placeholder 定位
          try {
            const el = page.locator(`input[placeholder*="${action.target}"], textarea[placeholder*="${action.target}"]`).first()
            if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
              await el.fill(action.value)
              filled = true
            }
          } catch {}

          // 策略 2: 通过 aria-label 定位
          if (!filled) {
            try {
              const el = page.locator(`[aria-label*="${action.target}"]`).first()
              if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
                await el.fill(action.value)
                filled = true
              }
            } catch {}
          }

          // 策略 3: 通过 label 文本定位
          if (!filled) {
            try {
              const el = page.locator('input, textarea').filter({ hasText: action.target }).first()
              if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
                await el.fill(action.value)
                filled = true
              }
            } catch {}
          }

          // 策略 4: 第一个可见的 input/textarea
          if (!filled) {
            try {
              const el = page.locator('input:not([type="hidden"]), textarea').first()
              if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
                await el.fill(action.value)
                filled = true
              }
            } catch {}
          }

          if (!filled) {
            return { success: false, error: `找不到输入框: ${action.target}`, durationMs: Date.now() - start }
          }
          await page.waitForTimeout(500)
          break
        }

        case 'evaluate': {
          if (!action.value) {
            return { success: false, error: 'evaluate 需要 value（JS 代码）', durationMs: Date.now() - start }
          }
          const evalResult = await page.evaluate(action.value)
          await page.waitForTimeout(500)
          return {
            success: true,
            data: evalResult,
            durationMs: Date.now() - start,
          }
        }

        case 'observe': {
          const url = await page.url()
          const title = await page.title()
          const text = await page.locator('body').innerText()
          const lines = text
            .split('\n')
            .filter((l: string) => l.trim().length > 3)
            .slice(0, 30)

          // 更新 session
          if (this.session) {
            this.session.currentUrl = url
            this.session.currentTitle = title
            this.session.lastActiveAt = Date.now()
          }

          return {
            success: true,
            observation: {
              url,
              title,
              keyElements: lines.map((l: string) => ({
                selector: '',
                description: l.slice(0, 80),
                method: '',
              })),
              loginState: url.includes('login')
                ? ('login_page' as const)
                : url.includes('writer') || url.includes('book')
                  ? ('logged_in' as const)
                  : ('unknown' as const),
              observedAt: Date.now(),
            },
            durationMs: Date.now() - start,
          }
        }
      }

      await page.waitForTimeout(500)

      // 观察操作后的页面
      const url = await page.url()
      const title = await page.title()

      if (this.session) {
        this.session.currentUrl = url
        this.session.currentTitle = title
        this.session.lastActiveAt = Date.now()
      }

      return {
        success: true,
        observation: {
          url,
          title,
          keyElements: [],
          loginState: 'unknown',
          observedAt: Date.now(),
        },
        durationMs: Date.now() - start,
      }
    } catch (err: any) {
      return { success: false, error: err.message, durationMs: Date.now() - start }
    }
  }

  /**
   * 观察当前页面（通过 CDP HTTP API）。
   */
  async observe(): Promise<PageObservation> {
    if (!this.session || this.session.source !== 'cdp' || !this.session.cdpPort) {
      return { url: '', title: '', keyElements: [], loginState: 'unknown', observedAt: Date.now() }
    }

    const port = this.session.cdpPort
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json`)
      const targets = await resp.json()
      const page = targets.find((t: any) => t.type === 'page' && t.url && !t.url.includes('devtools'))
      const url = page?.url || ''
      const title = page?.title || ''

      if (this.session) {
        this.session.currentUrl = url
        this.session.currentTitle = title
        this.session.lastActiveAt = Date.now()
      }

      return {
        url,
        title,
        keyElements: targets
          .filter((t: any) => t.type === 'page')
          .map((t: any) => ({ selector: '', description: t.title || t.url || '', method: '' })),
        loginState: url.includes('login')
          ? ('login_page' as const)
          : url.includes('writer') || url.includes('book')
            ? ('logged_in' as const)
            : ('unknown' as const),
        observedAt: Date.now(),
      }
    } catch {
      return { url: '', title: '', keyElements: [], loginState: 'unknown', observedAt: Date.now() }
    }
  }

  getSession(): BrowserSession | null {
    return this.session
  }

  async close(): Promise<void> {
    this.cleanup()
  }

  private cleanup(): void {
    if (this.pwBrowser) {
      try {
        this.pwBrowser.close().catch(() => {})
      } catch {}
      this.pwBrowser = null
    }
    this.pwPage = null
    this.session = null
  }
}

export type { BrowserSession, PageObservation, ActionResult, CdpConnectResult }
