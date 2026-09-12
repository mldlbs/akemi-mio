import { buildTool, formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'
import { getMemoryService, getMemoryResourceProvider } from '@akemi-mio/capabilities/tool/deps'

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
              const pureContent = e.content.startsWith(keyPrefix) ? e.content.slice(keyPrefix.length) : e.content
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

          const formatted = results.map((r) => `- [${r.store}] (得分${r.score.toFixed(2)})\n  内容: ${r.content.slice(0, 200)}`)
          return formatToolResult(`检索到 ${results.length} 条与 "${queryStr}" 相关的记忆:\n${formatted.join('\n')}`)
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
  handler: async (args: { query: string; top_k?: number; min_score?: number }) => {
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

        const formatted = filtered.map((r) => `- [${r.source}] (相似度${r.score.toFixed(2)})\n  内容: ${r.content.slice(0, 200)}`)
        return formatToolResult(`语义搜索 "${query}" 找到 ${filtered.length} 条记忆:\n${formatted.join('\n')}`)
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
    '删除记忆系统中的指定记忆。支持按 key（删除所有匹配 key 的记忆）或按 id（精确删除单条）删除。' + '删除操作不可逆，请谨慎使用。',
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
  handler: async (args: { key?: string; id?: string; dry_run?: boolean }) => {
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
            return formatToolResult(`[DRY RUN] 将删除记忆: id="${target.id}", 内容="${target.content.slice(0, 100)}"`)
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
            const preview = matched.map((e) => `- id="${e.id}", 内容="${e.content.slice(0, 80)}"`).join('\n')
            return formatToolResult(`[DRY RUN] 将删除 ${matched.length} 条匹配 key="${keyStr}" 的记忆:\n${preview}`)
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

// ===== summarize_memory — 记忆分组摘要 =====

/**
 * 按主题标签或内容相似度对记忆进行分组，生成每组摘要。
 * 不修改记忆存储，为只读分析工具。
 */
export const summarizeMemoryTool = buildTool({
  name: 'summarize_memory',
  description:
    '按主题分组记忆并生成摘要。只读操作，不修改记忆存储。' + '支持按查询过滤（可选），返回分组结果和每组摘要，便于模型快速了解记忆全貌。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '可选搜索查询，仅对匹配的记忆进行分组摘要。留空则分析所有 user_fact 记忆',
      },
      min_group_size: {
        type: 'number',
        description: '最小分组大小（少于该数量的条目不单独成组），默认 2，范围 2-10',
      },
      max_groups: {
        type: 'number',
        description: '最多返回的分组数，默认 5，范围 1-20',
      },
      tier: {
        type: 'string',
        enum: ['permanent', 'semi', 'ephemeral'],
        description: '可选层级过滤：只分析指定层级的记忆',
      },
    },
    required: [],
  },
  handler: async (args: { query?: string; min_group_size?: number; max_groups?: number; tier?: 'permanent' | 'semi' | 'ephemeral' }) => {
    try {
      const ms = getMemoryService()
      if (!ms) return formatToolError('记忆服务暂不可用')

      const minGroupSize = Math.min(Math.max(args.min_group_size || 2, 2), 10)
      const maxGroups = Math.min(Math.max(args.max_groups || 5, 1), 20)
      const query = args.query ? String(args.query).trim() : ''
      const tier = args.tier

      // 1. 获取待分析的记忆条目
      const entries = ms.getEntries()

      // 过滤：只分析 user_fact 类型，排除 permanent（已固定不压缩）
      let candidates = entries.filter((e) => e.type === 'user_fact' && e.tier !== 'permanent' && !e.isPinned)

      // 层级过滤
      if (tier) {
        candidates = candidates.filter((e) => e.tier === tier)
      }

      // 语义搜索过滤
      if (query) {
        try {
          const searchResults = await ms.unifiedQuery.query(query, {
            topK: 50,
            minConfidence: 0.2,
          })
          const searchContentSet = new Set(searchResults.map((r) => r.content))
          candidates = candidates.filter((e) => searchContentSet.has(e.content))
        } catch {
          // 搜索失败则使用全部候选
        }
      }

      if (candidates.length === 0) {
        return formatToolResult('没有找到可分析的用户事实记忆。')
      }

      // 2. 按主题相似度分组
      const used = new Set<string>()
      const groups: Array<{
        entries: string[]
        contents: string[]
        commonTopics: string[]
        avgConfidence: number
        maxBehaviorScore: number
      }> = []

      for (const entry of candidates) {
        if (used.has(entry.id)) continue

        const group = {
          entries: [entry.id],
          contents: [entry.content],
          commonTopics: [...(entry.topics || [])],
          avgConfidence: entry.confidence,
          maxBehaviorScore: entry.behaviorScore,
        }
        used.add(entry.id)

        for (const other of candidates) {
          if (used.has(other.id)) continue

          // 计算主题重叠
          const topicsA = entry.topics || []
          const topicsB = other.topics || []
          const overlap = topicsA.filter((t) => topicsB.includes(t))

          // 主题重叠 >0 或内容关键词重叠 >= 30%
          if (overlap.length > 0 || contentsSimilar(entry.content, other.content)) {
            group.entries.push(other.id)
            group.contents.push(other.content)
            group.commonTopics = overlap.length > 0 ? overlap : group.commonTopics
            group.avgConfidence = (group.avgConfidence + other.confidence) / 2
            group.maxBehaviorScore = Math.max(group.maxBehaviorScore, other.behaviorScore)
            used.add(other.id)
          }
        }

        if (group.entries.length >= minGroupSize) {
          groups.push(group)
        }
      }

      // 按行为得分降序排列
      groups.sort((a, b) => b.maxBehaviorScore - a.maxBehaviorScore)

      if (groups.length === 0) {
        return formatToolResult(
          `没有找到可分组的话题（最小分组大小=${minGroupSize}）。` +
            '共 ' +
            candidates.length +
            ' 条记忆，但它们的主题相似度不足以形成分组。',
        )
      }

      // 3. 生成每组摘要（限制返回组数）
      const topGroups = groups.slice(0, maxGroups)
      const totalGrouped = topGroups.reduce((sum, g) => sum + g.entries.length, 0)
      const lines: string[] = [
        `记忆分组摘要 — 共 ${topGroups.length} 个分组，${totalGrouped} 条记忆（总候选 ${candidates.length} 条）`,
        query ? `过滤查询: "${query}"` : '',
        '---',
      ]

      for (let i = 0; i < topGroups.length; i++) {
        const g = topGroups[i]
        const topicLabel = g.commonTopics.length > 0 ? `【${g.commonTopics.slice(0, 3).join('、')}】` : '【未分类】'
        const summary = generateGroupSummary(g.contents, g.commonTopics)
        lines.push(`\n分组 ${i + 1}: ${topicLabel}`)
        lines.push(
          `  条目数: ${g.entries.length} | 平均置信度: ${g.avgConfidence.toFixed(2)} | 最高行为分: ${g.maxBehaviorScore.toFixed(2)}`,
        )
        lines.push(`  摘要: ${summary}`)
        lines.push(`  包含条目 ID: ${g.entries.join(', ')}`)
      }

      // 如果有太多未被分组的条目，提示
      const groupedTotal = groups.reduce((sum, g) => sum + g.entries.length, 0)
      const ungrouped = candidates.length - groupedTotal
      if (ungrouped > 0) {
        lines.push(`\n未分组条目: ${ungrouped} 条（主题不够相似，可降低 min_group_size 或调整 query）`)
      }

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

// ===== read_resource — 读取 MCP 资源 =====

export const readResourceTool = buildTool({
  name: 'read_resource',
  description:
    '通过 MCP 资源 URI 读取数据。支持以下 URI 方案：\n' +
    '- memory://entries                     → 所有记忆条目\n' +
    '- memory://entries/{id}               → 按 ID 读取单条记忆\n' +
    '- memory://entries/permanent          → 永久层记忆\n' +
    '- memory://entries/semi               → 半永久层记忆\n' +
    '- memory://entries/ephemeral          → 临时层记忆\n' +
    '- memory://search?q={query}&topK={n}  → 语义搜索\n' +
    '- memory://stats                      → 记忆系统统计\n' +
    '- memory://preferences                → 用户画像',
  inputJSONSchema: {
    type: 'object',
    properties: {
      uri: {
        type: 'string',
        description: '资源 URI，如 "memory://entries/mem_1234567890_1" 或 "memory://stats"',
      },
    },
    required: ['uri'],
  },
  handler: async (args: { uri: string }) => {
    try {
      const ms = getMemoryService()
      if (!ms) return formatToolError('记忆服务暂不可用')

      // 首先尝试通过 MemoryResourceProvider 读取（如果已注册）
      const rp = getMemoryResourceProvider()
      if (rp) {
        try {
          const result = await rp.readResource(args.uri)
          return formatToolResult(result.text)
        } catch {
          // 回退到直接解析
        }
      }

      // 回退：在工具内直接解析 URI
      const uri = String(args.uri)
      if (!uri.startsWith('memory://')) {
        return formatToolError(`不支持的 URI 协议: ${uri}。仅支持 memory:// 协议。`)
      }

      // 简便解析：memory://entries/{id}
      const path = uri.replace(/^memory:\/\//, '')
      if (path === 'entries' || path.startsWith('entries/')) {
        const afterEntries = path.slice('entries'.length).replace(/^\//, '')
        if (!afterEntries) {
          // 列出所有
          const entries = ms.getEntries()
          if (entries.length === 0) return formatToolResult('没有记忆条目。')
          const lines = entries.map((e) => {
            const pinned = e.isPinned ? ' ⭐' : ''
            return `[${e.id}] (${e.type}, ${e.tier}, conf=${e.confidence.toFixed(2)})${pinned}\n  ${e.content.slice(0, 120)}`
          })
          return formatToolResult(`记忆条目列表 — 共 ${entries.length} 条\n${lines.join('\n')}`)
        }

        // 按层级筛选
        if (afterEntries === 'permanent' || afterEntries === 'semi' || afterEntries === 'ephemeral') {
          const filtered = ms.getEntries().filter((e) => e.tier === afterEntries)
          if (filtered.length === 0) return formatToolResult(`没有 ${afterEntries} 层条目。`)
          const lines = filtered.map((e) => `[${e.id}] (${e.type}, conf=${e.confidence.toFixed(2)})\n  ${e.content.slice(0, 120)}`)
          return formatToolResult(`${afterEntries} 层条目 — 共 ${filtered.length} 条\n${lines.join('\n')}`)
        }

        // 按 ID 查找
        const entry = ms.getEntries().find((e) => e.id === afterEntries)
        if (!entry) {
          // 尝试按 key 前缀查找
          const byKey = ms.getEntries().find((e) => e.content.startsWith(`[${afterEntries}]`))
          if (byKey) {
            return formatToolResult(formatEntryDetail(byKey))
          }
          return formatToolError(`未找到记忆条目: id="${afterEntries}"`)
        }
        return formatToolResult(formatEntryDetail(entry))
      }

      // memory://stats
      if (path === 'stats') {
        const entries = ms.getEntries()
        const lines = [
          `记忆系统统计`,
          `条目总数: ${entries.length}`,
          `  永久层: ${entries.filter((e) => e.tier === 'permanent').length}`,
          `  半永久层: ${entries.filter((e) => e.tier === 'semi').length}`,
          `  临时层: ${entries.filter((e) => e.tier === 'ephemeral').length}`,
          `  已固定: ${entries.filter((e) => e.isPinned).length}`,
        ]
        return formatToolResult(lines.join('\n'))
      }

      // memory://preferences
      if (path === 'preferences') {
        const prefs = ms.getUserPreferences()
        if (prefs.length === 0) return formatToolResult('没有用户画像。')
        const lines = prefs.map((p) => `[${p.category}] ${p.key}: ${p.value}`)
        return formatToolResult(`用户画像 — 共 ${prefs.length} 条\n${lines.join('\n')}`)
      }

      // memory://search?q=...
      if (path.startsWith('search')) {
        const url = new URL(uri)
        const q = url.searchParams.get('q')
        if (!q) return formatToolError('搜索请求缺少 q 参数。使用 memory://search?q={query}')
        const topK = Math.min(Math.max(parseInt(url.searchParams.get('topK') || '5', 10), 1), 20)
        const results = await ms.unifiedQuery.query(q, { topK, minConfidence: 0.3 })
        if (results.length === 0) return formatToolResult(`未找到与 "${q}" 相关的记忆。`)
        const lines = results.map((r) => `[${r.store}] (得分 ${r.score.toFixed(2)})\n  ${r.content.slice(0, 200)}`)
        return formatToolResult(`搜索 "${q}" — 共 ${results.length} 条\n${lines.join('\n')}`)
      }

      return formatToolError(`无法解析 URI: ${uri}`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

// ===== configure_memory — 记忆服务器配置 =====

export const configureMemoryTool = buildTool({
  name: 'configure_memory',
  description: '配置记忆系统。支持启用/禁用、设置隐私级别、保留天数和自动压缩。' + '不传参数时返回当前配置。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        description: '是否启用记忆系统。禁用后所有记忆相关工具将返回"不可用"',
      },
      privacy_level: {
        type: 'string',
        enum: ['strict', 'normal', 'permissive'],
        description:
          '隐私级别：\n' +
          '  strict    → 需要明确同意才存储事实，资源中仅暴露非敏感元数据\n' +
          '  normal    → 自动存储用户事实，资源排除 user_profile 类型\n' +
          '  permissive → 存储所有交互，资源暴露所有条目类型',
      },
      retention_days: {
        type: 'number',
        description: '记忆保留天数。超过此天数的临时层条目会被自动清理。范围 1-365',
      },
      compression: {
        type: 'boolean',
        description: '是否启用自动记忆压缩（MemoryCompressor 定期将相似记忆合并为摘要）',
      },
    },
    required: [],
  },
  handler: async (args: {
    enabled?: boolean
    privacy_level?: 'strict' | 'normal' | 'permissive'
    retention_days?: number
    compression?: boolean
  }) => {
    try {
      const rp = getMemoryResourceProvider()

      // 没有配置提供者时尝试通过 MemoryService 返回基本信息
      if (!rp) {
        const ms = getMemoryService()
        if (!ms) return formatToolError('记忆服务暂不可用')
        return formatToolResult(
          '记忆系统配置管理暂时不可用（MemoryResourceProvider 未注册）。\n' + '当前记忆条目数: ' + ms.getEntries().length,
        )
      }

      const currentConfig = rp.getConfig()

      // 没有变更参数时返回当前配置
      const hasChanges =
        args.enabled !== undefined ||
        args.privacy_level !== undefined ||
        args.retention_days !== undefined ||
        args.compression !== undefined

      if (!hasChanges) {
        const status = currentConfig.enabled ? '已启用' : '已禁用'
        return formatToolResult(
          `记忆服务器当前配置:\n` +
            `  启用状态: ${status}\n` +
            `  隐私级别: ${currentConfig.privacyLevel}\n` +
            `  保留天数: ${currentConfig.retentionDays}\n` +
            `  自动压缩: ${currentConfig.compressionEnabled ? '已启用' : '已禁用'}\n\n` +
            `使用 configure_memory 传入参数即可修改。例如:\n` +
            `  enabled: false → 禁用记忆系统\n` +
            `  privacy_level: "strict" → 严格隐私模式`,
        )
      }

      // 应用变更
      const updates: Record<string, any> = {}
      if (args.enabled !== undefined) updates.enabled = args.enabled
      if (args.privacy_level !== undefined) updates.privacyLevel = args.privacy_level
      if (args.retention_days !== undefined) {
        updates.retentionDays = Math.min(Math.max(Math.round(args.retention_days), 1), 365)
      }
      if (args.compression !== undefined) updates.compressionEnabled = args.compression

      rp.updateConfig(updates)
      const newConfig = rp.getConfig()

      return formatToolResult(
        `记忆配置已更新:\n` +
          `  启用状态: ${newConfig.enabled ? '已启用' : '已禁用'}\n` +
          `  隐私级别: ${newConfig.privacyLevel}\n` +
          `  保留天数: ${newConfig.retentionDays}\n` +
          `  自动压缩: ${newConfig.compressionEnabled ? '已启用' : '已禁用'}`,
      )
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

// ══════════════════════════════════════════
//  辅助函数
// ══════════════════════════════════════════

/** 检查两条内容是否相似（关键词重叠率 >= 30%） */
function contentsSimilar(a: string, b: string): boolean {
  const wordsA = new Set(
    a
      .toLowerCase()
      .split(/[\s,，。；;：:！!？?、()（）[\]【】]+/)
      .filter((w) => w.length >= 2),
  )
  const wordsB = new Set(
    b
      .toLowerCase()
      .split(/[\s,，。；;：:！!？?、()（）[\]【】]+/)
      .filter((w) => w.length >= 2),
  )
  if (wordsA.size === 0 || wordsB.size === 0) return false
  let intersection = 0
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++
  }
  const union = wordsA.size + wordsB.size - intersection
  return union > 0 && intersection / union >= 0.3
}

/** 生成分组摘要（去重后拼接，保留关键信息） */
function generateGroupSummary(contents: string[], _topics: string[]): string {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const c of contents) {
    const normalized = c.trim().toLowerCase()
    if (!seen.has(normalized)) {
      seen.add(normalized)
      unique.push(c.trim())
    }
  }
  if (unique.length === 0) return '(空)'
  if (unique.length === 1) return unique[0].slice(0, 200)
  const combined = unique.map((c) => c.slice(0, 80)).join('；')
  return combined.slice(0, 200)
}

/** 格式化单条记忆为详细文本 */
function formatEntryDetail(entry: {
  id: string
  type: string
  tier: string
  confidence: number
  behaviorScore: number
  reinforceCount: number
  accessCount: number
  isPinned: boolean
  createdAt: number
  updatedAt: number
  lastAccessedAt?: number
  content: string
  topics?: string[]
  structuredData?: string | null
}): string {
  const lines: string[] = []
  lines.push(`ID: ${entry.id}`)
  lines.push(`类型: ${entry.type}`)
  lines.push(`层级: ${entry.tier}`)
  lines.push(`置信度: ${entry.confidence.toFixed(2)}`)
  lines.push(`行为得分: ${entry.behaviorScore.toFixed(2)}`)
  lines.push(`强化次数: ${entry.reinforceCount}`)
  lines.push(`访问次数: ${entry.accessCount}`)
  lines.push(`固定: ${entry.isPinned ? '是' : '否'}`)
  lines.push(`创建: ${new Date(entry.createdAt).toISOString()}`)
  lines.push(`更新: ${new Date(entry.updatedAt).toISOString()}`)
  if (entry.lastAccessedAt && entry.lastAccessedAt > 0) {
    lines.push(`最后访问: ${new Date(entry.lastAccessedAt).toISOString()}`)
  }
  if (entry.topics && entry.topics.length > 0) {
    lines.push(`标签: ${entry.topics.join(', ')}`)
  }
  lines.push(`---`)
  lines.push(entry.content)
  return lines.join('\n')
}

