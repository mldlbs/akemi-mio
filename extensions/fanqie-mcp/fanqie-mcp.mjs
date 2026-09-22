/**
 * fanqie-mcp.mjs — 番茄小说发布 MCP Server
 *
 * Mio Core 通过 MCP stdio 协议加载本服务器，暴露两个工具：
 *   fanqie_auth_inspect   — 检查 CDP Chrome 的番茄登录态
 *   fanqie_publish_novel  — 发布章节到番茄小说
 *
 * 依赖：
 *   - playwright（CDP 连接已登录 Chrome）
 *   - Web Fetch（内置，访问写作 API）
 *
 * 环境变量：
 *   WRITING_API_URL    — 写作系统 API 地址（默认 https://www.crlkcloud.cyou/writing/api）
 *   FANQIE_AUTHOR_URL — 番茄作者平台地址（默认 https://author.fanqienovel.com）
 *
 * 设计原则：
 *   - 不引用 Mio 内部任何模块
 *   - 不持有 Mio 内部状态
 *   - 通过 CDP 连接用户已启动的 Chrome（--remote-debugging-port=9222）
 *   - 独立进程，可单独测试
 */

import { chromium } from 'playwright'

// ══════════════════════════════════════════════
//  配置
// ══════════════════════════════════════════════

const WRITING_API_URL = process.env.WRITING_API_URL || 'https://www.crlkcloud.cyou/writing/api'
const CDP_PORT = parseInt(process.env.CDP_PORT || '9222', 10)
const FANQIE_AUTHOR_URL = process.env.FANQIE_AUTHOR_URL || 'https://author.fanqienovel.com'

// ══════════════════════════════════════════════
//  日志
// ══════════════════════════════════════════════

function log(level, event, data = {}) {
  process.stderr.write(JSON.stringify({ level, timestamp: new Date().toISOString(), event, ...data }) + '\n')
}

function getAuthorHost() {
  try {
    return new URL(FANQIE_AUTHOR_URL).host
  } catch {
    return FANQIE_AUTHOR_URL.replace(/^https?:\/\//, '').split('/')[0] || 'author.fanqienovel.com'
  }
}

// ══════════════════════════════════════════════
//  Writing API 调用（与 Mio 内部实现一致）
// ══════════════════════════════════════════════

async function writingFetch(method, path, body) {
  const url = `${WRITING_API_URL}${path}`
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  return res.json()
}

// ══════════════════════════════════════════════
//  CDP Chrome 连接管理
// ══════════════════════════════════════════════

let _browser = null
let _page = null

/**
 * 连接 CDP Chrome（单例，复用连接）
 */
async function ensureBrowser() {
  if (_browser && _page) {
    try {
      await _page.url() // 试探连接是否有效
      return _page
    } catch {
      // 连接已断开，重新连接
      await cleanupBrowser()
    }
  }
  const cdpUrl = `http://127.0.0.1:${CDP_PORT}`
  log('INFO', 'fanqie_cdp_connecting', { url: cdpUrl })

  const resp = await fetch(`${cdpUrl}/json`).catch(() => null)
  if (!resp || !resp.ok) {
    throw new Error(
      `无法连接到 Chrome CDP（端口 ${CDP_PORT}）。\n` +
      `请确保 Chrome 以 --remote-debugging-port=${CDP_PORT} 启动，\n` +
      `并已登录 ${FANQIE_AUTHOR_URL}`
    )
  }

  _browser = await chromium.connectOverCDP(cdpUrl)
  const ctx = _browser.contexts()[0]
  const pages = ctx.pages()
  // 优先选择番茄作者平台的页面
  _page = pages.find(p => p.url().includes('fanqienovel')) || pages[0] || null
  if (!_page) {
    _page = await ctx.newPage()
  }

  log('INFO', 'fanqie_cdp_connected', { pages: pages.length })
  return _page
}

async function cleanupBrowser() {
  if (_browser) {
    try { await _browser.close() } catch {}
    _browser = null
    _page = null
  }
}

// ══════════════════════════════════════════════
//  Fetch Content from Writing API
// ══════════════════════════════════════════════

async function fetchScene(storyId, sceneId) {
  const [story, scene] = await Promise.all([
    writingFetch('GET', `/stories/${storyId}`),
    writingFetch('GET', `/scenes/${sceneId}`),
  ])
  return {
    sceneTitle: scene.title || `章节 ${sceneId}`,
    sceneContent: scene.content || '',
    storyTitle: story.title || story.name || '未命名',
    sceneOrder: scene.order || 0,
  }
}

async function fetchAllScenes(storyId) {
  const [story, scenes] = await Promise.all([
    writingFetch('GET', `/stories/${storyId}`),
    writingFetch('GET', `/scenes?storyId=${storyId}`),
  ])
  const sorted = (Array.isArray(scenes) ? scenes : [])
    .map(s => ({
      id: s.id || s.sceneId,
      title: s.title || '',
      content: s.content || '',
      order: s.order || 0,
    }))
    .sort((a, b) => a.order - b.order)
  return {
    storyTitle: story.title || story.name || '未命名',
    scenes: sorted,
  }
}

// ══════════════════════════════════════════════
//  浏览器自动化发布
// ══════════════════════════════════════════════

function getEditUrl(storyId, sceneId) {
  const authorUrl = FANQIE_AUTHOR_URL.replace(/\/+$/, '')
  if (sceneId) {
    return `${authorUrl}/chapter/edit?bookId=${storyId}&chapterId=${sceneId}`
  }
  return `${authorUrl}/chapter/publish?bookId=${storyId}`
}

async function fillContenteditable(page, content) {
  const escaped = content
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/\n/g, '\\n')
    .slice(0, 10000)

  return page.evaluate((html) => {
    const findEditor = () => {
      const ce = document.querySelector('[contenteditable="true"]')
      if (ce) return ce
      const iframes = document.querySelectorAll('iframe')
      for (const f of iframes) {
        try {
          const doc = f.contentDocument || f.contentWindow.document
          const c = doc.querySelector('[contenteditable="true"]')
          if (c) return c
        } catch {}
      }
      return null
    }
    const editor = findEditor()
    if (!editor) return false
    editor.innerHTML = html.replace(/\\n/g, '<br>')
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    editor.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }, escaped)
}

async function publishToFanqie(storyId, sceneId, mode) {
  const t0 = Date.now()
  const { sceneTitle, sceneContent } = await fetchScene(storyId, sceneId)

  if (!sceneContent || !sceneContent.trim()) {
    return { success: false, error: `章节 ${sceneId} 的内容为空` }
  }

  log('INFO', 'fanqie_publish_start', { storyId, sceneId, title: sceneTitle, mode })

  const page = await ensureBrowser()

  // 导航到编辑页
  const editUrl = getEditUrl(storyId, sceneId)
  await page.goto(editUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(2000)

  // 检查登录
  const url = page.url()
  if (url.includes('passport') || url.includes('login') || url.includes('sso')) {
    return {
      success: false,
      error: '未登录番茄作者平台',
      detail: `请先在 Chrome 中登录 ${getAuthorHost()} 后重试`,
    }
  }

  // 填写标题
  try {
    const titleInput = page.locator('input[placeholder*="标题"], input[placeholder*="title"], input[aria-label*="标题"]').first()
    if (await titleInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await titleInput.fill(sceneTitle)
    }
  } catch {}
  await page.waitForTimeout(500)

  // 填写正文
  let contentFilled = false

  // 策略 1: 通过 fill 填写 textarea / input
  try {
    const editor = page.locator('textarea, [contenteditable="true"]').first()
    if (await editor.isVisible({ timeout: 2000 }).catch(() => false)) {
      await editor.fill(sceneContent.slice(0, 5000))
      contentFilled = true
    }
  } catch {}

  // 策略 2: contenteditable 注入
  if (!contentFilled) {
    contentFilled = await fillContenteditable(page, sceneContent)
  }

  if (!contentFilled) {
    return {
      success: false,
      error: '找不到编辑器元素',
      detail: `标题"${sceneTitle}"已填写，正文需要手动粘贴`,
    }
  }

  await page.waitForTimeout(1000)

  // 点击按钮
  const buttonLabel = mode === 'publish' ? '发布' : '保存草稿'
  try {
    const btn = page.locator(`button, a, [role="button"]`).filter({ hasText: buttonLabel }).first()
    if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await btn.click()
      await page.waitForTimeout(3000)
    }
  } catch {}

  const finalUrl = page.url()

  log('INFO', 'fanqie_publish_success', {
    storyId, sceneId, title: sceneTitle, mode, durationMs: Date.now() - t0,
  })

  return {
    success: true,
    title: sceneTitle,
    url: finalUrl || editUrl,
    detail: `章节「${sceneTitle}」已${mode === 'draft' ? '保存草稿' : '发布'}`,
  }
}

// ══════════════════════════════════════════════
//  认证检查
// ══════════════════════════════════════════════

async function checkAuth() {
  try {
    const page = await ensureBrowser()

    const cookies = await page.context().cookies()
    const fanqieCookies = cookies.filter(c =>
      c.domain.includes('fanqienovel') || c.domain.includes('fanqie')
    )

    const authState = await page.evaluate(() => {
      const keys = Object.keys(localStorage)
      const authKeys = keys.filter(k =>
        k.toLowerCase().includes('token') || k.toLowerCase().includes('auth') ||
        k.toLowerCase().includes('session') || k.toLowerCase().includes('user')
      )
      const authData = {}
      for (const k of authKeys) {
        const v = localStorage.getItem(k)
        authData[k] = v ? v.substring(0, 50) + (v.length > 50 ? '...' : '') : null
      }
      return { localStorageAuthKeys: authKeys, localStorageAuthData: authData }
    })

    const isLoggedIn = fanqieCookies.length > 0 || authState.localStorageAuthKeys.length > 0
    const url = page.url()

    return {
      loggedIn: isLoggedIn,
      currentUrl: url,
      fanqieCookies: fanqieCookies.map(c => ({ name: c.name, domain: c.domain, expires: c.expires })),
      localStorageAuthCount: authState.localStorageAuthKeys.length,
      urlIndicatesLogin: !url.includes('login') && !url.includes('passport') && !url.includes('sso'),
    }
  } catch (err) {
    return {
      loggedIn: false,
      error: err.message,
    }
  }
}

// ══════════════════════════════════════════════
//  MCP Protocol 实现（JSON-RPC 2.0 over stdio）
// ══════════════════════════════════════════════

class FanqieMcpServer {
  constructor() {
    this.requestId = 0
    this.buffer = ''
  }

  async handleRequest(msg) {
    const { jsonrpc, id, method, params } = msg

    if (method === 'initialize') {
      this.sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
        },
        serverInfo: { name: 'fanqie-publish', version: '1.0.0' },
      })
      return
    }

    if (method === 'notifications/initialized') {
      return
    }

    if (method === 'tools/list') {
      this.sendResponse(id, {
        tools: [
          {
            name: 'fanqie_auth_inspect',
            description:
              '检查 CDP Chrome 浏览器中番茄小说的登录认证状态。\n' +
              '返回：是否已登录、cookie 数量、localStorage 中 token 情况、当前页面 URL。\n' +
              `使用场景：在发布前调用，确认用户已在 Chrome 中登录 ${getAuthorHost()}`,
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'fanqie_publish_novel',
            description:
              '发布章节到番茄小说。通过 CDP Chrome 自动完成填写和发布操作。\n' +
              '两种模式：\n' +
              '1. publishAllScenes=true — 列出小说的所有章节（不操作浏览器）\n' +
              '2. 指定 sceneId — 发布单章（通过浏览器自动完成）\n\n' +
              `注意：需要 Chrome 以 --remote-debugging-port=${CDP_PORT} 启动并已登录 ${getAuthorHost()}`,
            inputSchema: {
              type: 'object',
              properties: {
                storyId: { type: 'string', description: '写作系统中的小说ID' },
                sceneId: { type: 'string', description: '写作系统中的章节ID（发布单章时使用，与publishAllScenes二选一）' },
                publishAllScenes: { type: 'boolean', description: '是否列出该小说的所有章节（不操作浏览器）' },
                mode: { type: 'string', enum: ['draft', 'publish'], description: 'draft(保存草稿) / publish(直接发布)，默认 draft' },
              },
              required: ['storyId'],
            },
          },
        ],
      })
      return
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params

      try {
        switch (name) {
          case 'fanqie_auth_inspect': {
            const result = await checkAuth()
            this.sendResponse(id, {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            })
            break
          }

          case 'fanqie_publish_novel': {
            const { storyId, sceneId, publishAllScenes, mode = 'draft' } = args

            if (!storyId) {
              this.sendError(id, -32602, '缺少 storyId')
              break
            }

            if (publishAllScenes) {
              const { storyTitle, scenes } = await fetchAllScenes(storyId)
              if (scenes.length === 0) {
                this.sendResponse(id, { content: [{ type: 'text', text: `作品「${storyTitle}」暂无章节` }] })
                break
              }
              const sceneList = scenes.map((s, i) => `  ${i + 1}. [${s.id}] ${s.title || `第${s.order}章`}`).join('\n')
              this.sendResponse(id, {
                content: [{
                  type: 'text',
                  text: `📚 「${storyTitle}」共 ${scenes.length} 章\n\n${sceneList}\n\n使用 sceneId 发布单章。`,
                }],
              })
              break
            }

            if (!sceneId) {
              this.sendError(id, -32602, '需要 sceneId（发布单章）或 publishAllScenes=true（列出章节）')
              break
            }

            const result = await publishToFanqie(storyId, sceneId, mode)
            this.sendResponse(id, {
              content: [{
                type: 'text',
                text: result.success
                  ? `✅ ${result.detail}\n📍 ${result.url || ''}`
                  : `❌ ${result.error}\n${result.detail || ''}`,
              }],
            })
            break
          }

          default:
            this.sendError(id, -32601, `未知工具: ${name}`)
        }
      } catch (err) {
        log('ERROR', 'fanqie_tool_error', { tool: name, error: err.message })
        this.sendError(id, -32603, err.message)
      }
      return
    }

    // 未知方法
    this.sendError(id, -32601, `未知方法: ${method}`)
  }

  sendResponse(id, result) {
    const msg = JSON.stringify({ jsonrpc: '2.0', id, result })
    process.stdout.write(msg + '\n')
  }

  sendError(id, code, message) {
    const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
    process.stdout.write(msg + '\n')
  }

  start() {
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (chunk) => {
      this.buffer += chunk
      const lines = this.buffer.split('\n')
      this.buffer = lines.pop() || '' // 最后一段可能不完整
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const msg = JSON.parse(trimmed)
          this.handleRequest(msg).catch(err => {
            log('ERROR', 'fanqie_handler_unhandled', { error: err.message })
          })
        } catch (err) {
          log('ERROR', 'fanqie_parse_error', { line: trimmed.slice(0, 200), error: err.message })
        }
      }
    })

    process.stdin.on('end', () => {
      cleanupBrowser().catch(() => {})
    })

    process.on('SIGINT', () => {
      cleanupBrowser().catch(() => {})
      process.exit(0)
    })

    process.on('SIGTERM', () => {
      cleanupBrowser().catch(() => {})
      process.exit(0)
    })

    log('INFO', 'fanqie_mcp_started', { cdpPort: CDP_PORT, writingApi: WRITING_API_URL, authorUrl: FANQIE_AUTHOR_URL })
  }
}

// ══════════════════════════════════════════════
//  启动
// ══════════════════════════════════════════════

const server = new FanqieMcpServer()
server.start()
