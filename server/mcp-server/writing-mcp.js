/**
 * Akemi Mio 写作系统 MCP 服务器
 * 封装远程写作 API (http://127.0.0.1:3300) 为结构化 MCP 工具
 * 使 AI 可以通过 MCP 协议直接操作写作系统，无需手动拼接 JSON
 */
const http = require('http')

const WRITING_API = process.env.WRITING_API || 'http://127.0.0.1:3300'
const PORT = parseInt(process.env.PORT || '3301', 10)
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || ''

// ── 进程级错误处理 ──────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error(`[Writing MCP] Uncaught exception: ${err.message}`, err.stack)
})
process.on('unhandledRejection', (reason) => {
  console.error(`[Writing MCP] Unhandled rejection: ${reason}`)
})

let requestId = 0

function createResponse(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}
function createError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
}

// ─── Writing API 调用封装 ───

async function apiFetch(method, path, body) {
  const url = `${WRITING_API}${path}`
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    timeout: 60000,
  }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(url, opts)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`API ${res.status}: ${text.slice(0, 300)}`)
  }
  return res.json()
}

// ─── 工具定义 ───

const TOOLS = [
  {
    name: 'writing_list_stories',
    description: '列出写作系统中所有故事',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'writing_get_story',
    description: '获取单个故事的详细信息（包含角色列表、章节列表）',
    inputSchema: {
      type: 'object',
      properties: {
        storyId: { type: 'string', description: '故事 ID' },
      },
      required: ['storyId'],
    },
  },
  {
    name: 'writing_create_story',
    description: '创建一个新故事',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '故事标题' },
        genre: { type: 'string', description: '故事类型，如 玄幻/都市/仙侠/科幻/言情' },
        description: { type: 'string', description: '故事简介' },
      },
      required: ['title', 'genre', 'description'],
    },
  },
  {
    name: 'writing_list_characters',
    description: '列出指定故事下的所有角色',
    inputSchema: {
      type: 'object',
      properties: {
        storyId: { type: 'string', description: '故事 ID' },
      },
      required: ['storyId'],
    },
  },
  {
    name: 'writing_create_character',
    description: '为故事创建一个新角色',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '角色名称' },
        storyId: { type: 'string', description: '所属故事 ID' },
        role: { type: 'string', description: '角色定位，如 主角/配角/反派/路人' },
        personality: { type: 'string', description: '性格描述' },
        background: { type: 'string', description: '背景故事' },
        appearance: { type: 'string', description: '外貌描述' },
      },
      required: ['name', 'storyId', 'role'],
    },
  },
  {
    name: 'writing_list_scenes',
    description: '列出指定故事的所有章节',
    inputSchema: {
      type: 'object',
      properties: {
        storyId: { type: 'string', description: '故事 ID' },
      },
      required: ['storyId'],
    },
  },
  {
    name: 'writing_create_scene',
    description: '创建新章节（或添加内容到已有章节）',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '章节标题，如 "第一章 初入江湖"' },
        content: { type: 'string', description: '章节正文内容' },
        storyId: { type: 'string', description: '所属故事 ID' },
        order: { type: 'number', description: '章节序号，如 1, 2, 3' },
      },
      required: ['title', 'storyId', 'order'],
    },
  },
  {
    name: 'writing_create_relationship',
    description: '创建两个角色之间的关系',
    inputSchema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: '源角色 ID' },
        targetId: { type: 'string', description: '目标角色 ID' },
        type: { type: 'string', description: '关系类型，如 师徒/恋人/仇敌/兄弟/朋友/主仆' },
      },
      required: ['sourceId', 'targetId', 'type'],
    },
  },
  {
    name: 'writing_ai_write',
    description: '让 AI 辅助写作一段内容（生成新文本或续写）',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '写作提示，描述要写的内容' },
        storyId: { type: 'string', description: '关联的故事 ID（可选）' },
        temperature: { type: 'number', description: '创作温度 0.1~1.0，越高越有创意，默认 0.8' },
      },
      required: ['prompt'],
    },
  },
]

// ─── 工具执行 ───

async function handleToolCall(name, args) {
  try {
    switch (name) {
      case 'writing_list_stories': {
        const stories = await apiFetch('GET', '/api/stories')
        return { content: [{ type: 'text', text: JSON.stringify(stories, null, 2) }], isError: false }
      }

      case 'writing_get_story': {
        if (!args.storyId) throw new Error('storyId 是必填参数')
        const story = await apiFetch('GET', `/api/stories/${args.storyId}`)
        return { content: [{ type: 'text', text: JSON.stringify(story, null, 2) }], isError: false }
      }

      case 'writing_create_story': {
        const body = {
          title: args.title,
          genre: args.genre,
          description: args.description || '',
        }
        const result = await apiFetch('POST', '/api/stories', body)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false }
      }

      case 'writing_list_characters': {
        if (!args.storyId) throw new Error('storyId 是必填参数')
        const chars = await apiFetch('GET', `/api/characters?storyId=${args.storyId}`)
        return { content: [{ type: 'text', text: JSON.stringify(chars, null, 2) }], isError: false }
      }

      case 'writing_create_character': {
        const body = {
          name: args.name,
          storyId: args.storyId,
          role: args.role,
          attributes: {
            personality: args.personality || '',
            background: args.background || '',
            appearance: args.appearance || '',
          },
        }
        const result = await apiFetch('POST', '/api/characters', body)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false }
      }

      case 'writing_list_scenes': {
        if (!args.storyId) throw new Error('storyId 是必填参数')
        const scenes = await apiFetch('GET', `/api/scenes?storyId=${args.storyId}`)
        return { content: [{ type: 'text', text: JSON.stringify(scenes, null, 2) }], isError: false }
      }

      case 'writing_create_scene': {
        const body = {
          title: args.title,
          content: args.content || '',
          storyId: args.storyId,
          order: args.order,
        }
        const result = await apiFetch('POST', '/api/scenes', body)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false }
      }

      case 'writing_create_relationship': {
        const body = {
          sourceId: args.sourceId,
          targetId: args.targetId,
          type: args.type,
        }
        const result = await apiFetch('POST', '/api/relationships', body)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false }
      }

      case 'writing_ai_write': {
        const body = {
          prompt: args.prompt,
          storyId: args.storyId || '',
          temperature: args.temperature ?? 0.8,
        }
        const result = await apiFetch('POST', '/api/ai/write', body)
        return { content: [{ type: 'text', text: result.content || JSON.stringify(result) }], isError: false }
      }

      default:
        return { content: [{ type: 'text', text: `未知工具: ${name}` }], isError: true }
    }
  } catch (e) {
    return { content: [{ type: 'text', text: `错误: ${e.message}` }], isError: true }
  }
}

// ─── HTTP 服务器 ───

function parseBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => resolve(body))
  })
}

const server = http.createServer(async (req, res) => {
  // 为每个请求添加 error 事件监听，防止未捕获的响应错误
  res.on('error', (err) => {
    console.error(`[Writing MCP] Response error: ${err.message}`)
  })
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  // SSE
  if (req.url === '/sse' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' })
    res.write('data: {"jsonrpc":"2.0","method":"server/connected"}\n\n')
    const keepAlive = setInterval(() => res.write(': keepalive\n\n'), 15000)
    req.on('close', () => clearInterval(keepAlive))
    return
  }

  // MCP
  if (req.method === 'POST' && ['/', '/message', '/mcp'].includes(req.url)) {
    if (AUTH_TOKEN) {
      const auth = req.headers['authorization']
      if (!auth || auth !== `Bearer ${AUTH_TOKEN}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }))
        return
      }
    }

    const body = await parseBody(req)
    let msg
    try { msg = JSON.parse(body) } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(createError(null, -32700, 'Parse error'))
      return
    }

    const id = msg.id || ++requestId

    if (msg.method === 'initialize') {
      res.end(createResponse(id, {
        protocolVersion: '0.1.0',
        serverInfo: { name: 'akemi-mio-writing', version: '1.0.0' },
        capabilities: { tools: {} },
      }))
    } else if (msg.method === 'tools/list') {
      res.end(createResponse(id, { tools: TOOLS }))
    } else if (msg.method === 'tools/call') {
      const { name: tname, arguments: targs } = msg.params || {}
      if (!tname) { res.end(createError(id, -32602, 'Missing tool name')); return }
      try {
        const result = await handleToolCall(tname, targs || {})
        res.end(createResponse(id, result))
      } catch (e) {
        res.end(createResponse(id, { content: [{ type: 'text', text: `错误: ${e.message}` }], isError: true }))
      }
    } else if (msg.method === 'ping') {
      res.end(createResponse(id, {}))
    } else if (msg.method === 'shutdown') {
      res.end(createResponse(id, {}))
      setTimeout(() => process.exit(0), 100)
    } else {
      res.end(createError(id, -32601, `Method not found: ${msg.method}`))
    }
    return
  }

  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', server: 'akemi-mio-writing', tools: TOOLS.length }))
    return
  }

  res.writeHead(404)
  res.end('Not found')
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Writing MCP Server] running on http://0.0.0.0:${PORT}`)
  console.log(`[Writing MCP Server] api: ${WRITING_API}`)
  console.log(`[Writing MCP Server] tools: ${TOOLS.map(t => t.name).join(', ')}`)
})
