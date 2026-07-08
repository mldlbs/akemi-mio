import { buildTool, formatToolResult, formatToolError } from '../types'
import { getMemoryService } from '../deps'

// ── 权限白名单（预留：当前所有内置调用均可访问；未来由 ServerManager 层拦截）──
const ALLOWED_SERVERS = new Set(['@builtin/core', '@akemi/agent', '@akemi/cognitive'])

// ── 并发队列：避免 MemoryService 竞态 ──
let queueLock = false
const pendingQueue: Array<() => void> = []

function enqueue(fn: () => Promise<any>): Promise<any> {
  return new Promise((resolve, reject) => {
    const run = async () => {
      queueLock = true
      try {
        const result = await fn()
        resolve(result)
      } catch (err) {
        reject(err)
      } finally {
        queueLock = false
        const next = pendingQueue.shift()
        if (next) next()
      }
    }
    if (queueLock) {
      pendingQueue.push(run)
    } else {
      run()
    }
  })
}

// ===== store_memory — 通用记忆存储 =====

export const storeMemoryTool = buildTool({
  name: 'store_memory',
  description:
    '存储一条记忆到记忆系统。支持 key（唯一标识）、content（内容）、metadata（元数据）。' +
    '用于持久化重要信息、对话上下文、用户偏好等。如果 key 已存在则更新内容。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description: '记忆的唯一标识，用于后续检索和更新。建议使用有意义的命名，如 "user_name"、"project_config"',
      },
      content: {
        type: 'string',
        description: '记忆内容，可以是文本、结构化 JSON 字符串等',
      },
      metadata: {
        type: 'object',
        description: '附加元数据，如 { type: "preference", confidence: 0.9, tags: ["important"] }',
        properties: {
          type: {
            type: 'string',
            enum: ['user_fact', 'interaction', 'task_state', 'user_profile', 'fictional'],
            description: '记忆类型',
          },
          confidence: { type: 'number', description: '确信度 0-1，默认 0.7' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: '标签列表',
          },
        },
      },
    },
    required: ['key', 'content'],
  },
  handler: async (args: {
    key: string
    content: string
    metadata?: {
      type?: 'user_fact' | 'interaction' | 'task_state' | 'user_profile' | 'fictional'
      confidence?: number
      tags?: string[]
    }
  }) => {
    return enqueue(async () => {
      try {
        const ms = getMemoryService()
        if (!ms) return formatToolError('记忆服务暂不可用')

        const key = String(args.key)
        const content = String(args.content)
        const meta = args.metadata || {}
        const memType = meta.type || 'user_fact'
        const confidence = typeof meta.confidence === 'number' ? meta.confidence : 0.7

        // 构建带 key 前缀的内容，便于检索时按 key 匹配
        const enrichedContent = `[${key}] ${content}`
        ms.addEntry(memType, enrichedContent, confidence, { tier: 'semi' })

        // 如果有 tags，追加一条索引记忆
        if (meta.tags && meta.tags.length > 0) {
          const tagContent = `[tags:${key}] ${meta.tags.join(', ')}`
          ms.addEntry('user_fact', tagContent, 0.5, { tier: 'ephemeral' })
        }

        return formatToolResult(`已存储记忆: key="${key}", 类型=${memType}, 置信度=${confidence}`)
      } catch (err: any) {
        return formatToolError(err.message)
      }
    })
  },
  isReadOnly: false,
})

// ===== retrieve_memory — 结构化记忆检索 =====

export const retrieveMemoryTool = buildTool({
  name: 'retrieve_memory',
  description:
    '检索记忆系统中的记忆。支持按 key 精确查找、按 query 语义搜索、按类型筛选。' +
    '返回匹配的记忆条目及其元数据。用于对话管理、上下文恢复等场景。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索查询文本。如果提供 key 则优先按 key 精确匹配，否则进行语义搜索',
      },
      key: {
        type: 'string',
        description: '记忆的唯一标识 key。如果提供则直接按 key 查找，忽略 query',
      },
      options: {
        type: 'object',
        description: '检索选项',
        properties: {
          topK: { type: 'number', description: '返回的最大结果数，默认 5' },
          minConfidence: { type: 'number', description: '最低置信度阈值，默认 0.3' },
          types: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['user_fact', 'engineering', 'summary', 'knowledge_graph', 'vector'],
            },
            description: '限定检索的记忆类型',
          },
        },
      },
    },
    required: [],
  },
  handler: async (args: {
    query?: string
    key?: string
    options?: {
      topK?: number
      minConfidence?: number
      types?: Array<'user_fact' | 'engineering' | 'summary' | 'knowledge_graph' | 'vector'>
    }
  }) => {
    return enqueue(async () => {
      try {
        const ms = getMemoryService()
        if (!ms) return formatToolError('记忆服务暂不可用')

        const opts = args.options || {}
        const topK = opts.topK || 5

        // 如果提供了 key，先精确匹配
        if (args.key) {
          const keyStr = String(args.key)
          const keyPrefix = `[${keyStr}] `
          const allEntries = ms.getEntries()
          const matched = allEntries.filter((e) => e.content.startsWith(keyPrefix))

          if (matched.length > 0) {
            const formatted = matched.map((e) => {
              const pureContent = e.content.startsWith(keyPrefix)
                ? e.content.slice(keyPrefix.length)
                : e.content
              return `- [${e.id}] (${e.type}, 置信度${e.confidence.toFixed(1)}, tier=${e.tier})\n  内容: ${pureContent.slice(0, 200)}`
            })
            return formatToolResult(`检索到 ${matched.length} 条匹配 key="${keyStr}" 的记忆:\n${formatted.join('\n')}`)
          }

          return formatToolResult(`未找到 key="${keyStr}" 的记忆。`)
        }

        // 语义搜索
        if (args.query) {
          const queryStr = String(args.query)
          const results = await ms.unifiedQuery.query(queryStr, {
            topK,
            minConfidence: opts.minConfidence ?? 0.3,
            types: opts.types,
          })

          if (results.length === 0) {
            return formatToolResult(`未找到与 "${queryStr}" 相关的记忆。`)
          }

          const formatted = results.map(
            (r) => `- [${r.store}] (得分${r.score.toFixed(2)})\n  内容: ${r.content.slice(0, 200)}`,
          )
          return formatToolResult(
            `检索到 ${results.length} 条与 "${queryStr}" 相关的记忆:\n${formatted.join('\n')}`,
          )
        }

        // 没给 query 也没给 key，返回最近条目
        const entries = ms.getEntries().slice(-topK)
        if (entries.length === 0) {
          return formatToolResult('记忆系统为空。')
        }
        const formatted = entries.map(
          (e) => `- [${e.id}] (${e.type}, 置信度${e.confidence.toFixed(1)}, tier=${e.tier})\n  内容: ${e.content.slice(0, 200)}`,
        )
        return formatToolResult(`最近 ${entries.length} 条记忆:\n${formatted.join('\n')}`)
      } catch (err: any) {
        return formatToolError(err.message)
      }
    })
  },
  isReadOnly: true,
})

// ===== search_memories — 批量语义搜索 =====

export const searchMemoriesTool = buildTool({
  name: 'search_memories',
  description:
    '批量语义搜索记忆系统。接受查询文本（内部自动计算 embedding），返回 top_k 个最相似记忆。' +
    '比 retrieve_memory 更轻量，专用于快速语义匹配场景。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索查询文本，内部会自动转换为 embedding 向量进行余弦相似度匹配',
      },
      top_k: {
        type: 'number',
        description: '返回的最大结果数，默认 5，范围 1-20',
      },
      min_score: {
        type: 'number',
        description: '最低相似度阈值 0-1，默认 0.3。低于此分数的结果将被过滤',
      },
    },
    required: ['query'],
  },
  handler: async (args: {
    query: string
    top_k?: number
    min_score?: number
  }) => {
    return enqueue(async () => {
      try {
        const ms = getMemoryService()
        if (!ms) return formatToolError('记忆服务暂不可用')

        const query = String(args.query)
        const topK = Math.min(Math.max(args.top_k || 5, 1), 20)
        const minScore = args.min_score ?? 0.3

        // 使用 VectorMemory 进行语义搜索（返回 content 字符串数组）
        const vectorContents: string[] = await ms.vector.query(query, topK)

        // 也用 UnifiedMemoryQuery 进行跨库搜索
        const unifiedResults = await ms.unifiedQuery.query(query, {
          topK: Math.ceil(topK / 2),
          minConfidence: minScore,
        })

        // 合并去重结果
        const seen = new Set<string>()
        const merged: Array<{
          content: string
          score: number
          source: string
        }> = []

        // vector 结果：content 字符串，赋予默认相似度
        for (const content of vectorContents) {
          if (!seen.has(content)) {
            seen.add(content)
            merged.push({
              content,
              score: 0.6, // VectorMemory 内部已用 cosineSimilarity > 0.5 过滤
              source: 'vector',
            })
          }
        }

        // unified 结果：QueryResult 对象
        for (const r of unifiedResults) {
          if (!seen.has(r.content)) {
            seen.add(r.content)
            merged.push({
              content: r.content,
              score: r.score,
              source: r.store,
            })
          }
        }

        // 按分数排序并过滤
        const filtered = merged
          .filter((r) => r.score >= minScore)
          .sort((a, b) => b.score - a.score)
          .slice(0, topK)

        if (filtered.length === 0) {
          return formatToolResult(`未找到与 "${query}" 语义相似的记忆 (min_score=${minScore})。`)
        }

        const formatted = filtered.map(
          (r) => `- [${r.source}] (相似度${r.score.toFixed(2)})\n  内容: ${r.content.slice(0, 200)}`,
        )
        return formatToolResult(
          `语义搜索 "${query}" 找到 ${filtered.length} 条记忆:\n${formatted.join('\n')}`,
        )
      } catch (err: any) {
        return formatToolError(err.message)
      }
    })
  },
  isReadOnly: true,
})

// ===== forget_memory — 删除记忆 =====

export const forgetMemoryTool = buildTool({
  name: 'forget_memory',
  description:
    '删除记忆系统中的指定记忆。支持按 key（删除所有匹配 key 的记忆）或按 id（精确删除单条）删除。' +
    '删除操作不可逆，请谨慎使用。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description: '要删除的记忆 key。会删除所有内容以 [key] 开头的记忆条目',
      },
      id: {
        type: 'string',
        description: '要删除的记忆 ID（精确删除单条）。与 key 二选一，优先使用 id',
      },
      dry_run: {
        type: 'boolean',
        description: '如果为 true，仅返回将要删除的记忆而不实际执行删除，默认 false',
      },
    },
    required: [],
  },
  handler: async (args: {
    key?: string
    id?: string
    dry_run?: boolean
  }) => {
    return enqueue(async () => {
      try {
        const ms = getMemoryService()
        if (!ms) return formatToolError('记忆服务暂不可用')

        if (!args.key && !args.id) {
          return formatToolError('必须提供 key 或 id 参数之一')
        }

        const dryRun = args.dry_run === true

        // 按 id 精确删除
        if (args.id) {
          const idStr = String(args.id)
          const entries = ms.getEntries()
          const target = entries.find((e) => e.id === idStr)

          if (!target) {
            return formatToolResult(`未找到 id="${idStr}" 的记忆。`)
          }

          if (dryRun) {
            return formatToolResult(
              `[DRY RUN] 将删除记忆: id="${target.id}", 内容="${target.content.slice(0, 100)}"`,
            )
          }

          const removed = ms.forgetEntry(idStr)
          if (removed) {
            // 也从 vector 中删除
            ms.vector.forgetByContent(target.content)
            ms.flush()
            return formatToolResult(`已删除记忆: id="${idStr}", 内容="${target.content.slice(0, 100)}"`)
          }
          return formatToolError(`删除记忆失败: id="${idStr}"`)
        }

        // 按 key 批量删除
        if (args.key) {
          const keyStr = String(args.key)
          const keyPrefix = `[${keyStr}] `
          const entries = ms.getEntries()
          const matched = entries.filter((e) => e.content.startsWith(keyPrefix))

          if (matched.length === 0) {
            return formatToolResult(`未找到 key="${keyStr}" 的记忆。`)
          }

          if (dryRun) {
            const preview = matched
              .map((e) => `- id="${e.id}", 内容="${e.content.slice(0, 80)}"`)
              .join('\n')
            return formatToolResult(
              `[DRY RUN] 将删除 ${matched.length} 条匹配 key="${keyStr}" 的记忆:\n${preview}`,
            )
          }

          let removedCount = 0
          for (const e of matched) {
            if (ms.forgetEntry(e.id)) {
              ms.vector.forgetByContent(e.content)
              removedCount++
            }
          }
          ms.flush()
          return formatToolResult(`已删除 ${removedCount} 条匹配 key="${keyStr}" 的记忆。`)
        }

        return formatToolError('未知错误')
      } catch (err: any) {
        return formatToolError(err.message)
      }
    })
  },
  isReadOnly: false,
})
