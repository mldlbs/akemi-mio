/**
 * IMemoryPlugin — 记忆插件接口
 *
 * 使记忆检索和更新与 Agent 核心解耦。
 * 任何记忆存储（Vector、KG、Summary、Engineering 等）实现此接口后，
 * 可通过 UnifiedMemoryQuery.register() 注册为统一查询后端。
 *
 * 设计目标：
 * - 检索侧：Agent 推理循环前调用 retrieve() 获取上下文，注入 system prompt
 * - 更新侧：Agent 对话结束后调用 update() 异步持久化摘要和知识实体
 * - 插件可独立迭代，不影响 Agent 核心逻辑
 */

export interface MemoryRetrievalResult {
  /** 检索到的内容片段 */
  content: string
  /** 相关性得分 0-1 */
  score: number
  /** 来源存储名（如 'vector', 'kg', 'engineering'） */
  source: string
  /** 附加元数据 */
  metadata?: Record<string, unknown>
  /** 时间戳 */
  timestamp?: number
}

export interface MemoryUpdateInput {
  /** 用户消息文本 */
  userMessage: string
  /** Agent 回复文本 */
  assistantReply: string
  /** 对话中识别的话题标签 */
  topics?: string[]
  /** 对话中做出的决策描述 */
  decisions?: string[]
  /** 对话中涉及的实体 */
  entities?: string[]
  /** 交互时间戳 */
  timestamp: number
  /** 额外上下文 */
  metadata?: Record<string, unknown>
}

/**
 * 记忆插件接口。
 * 所有记忆存储系统应实现此接口以获得统一的检索和更新能力。
 */
export interface IMemoryPlugin {
  /** 插件唯一标识 */
  readonly name: string

  /**
   * 检索：根据查询文本返回相关记忆。
   * 在 Agent 推理循环前调用，结果注入 system prompt。
   *
   * @param query - 用户输入或查询文本
   * @param topK - 返回的最相关条目数
   * @returns 按相关性排序的记忆结果列表
   */
  retrieve(query: string, topK?: number): Promise<MemoryRetrievalResult[]>

  /**
   * 更新：对话结束后异步持久化。
   * 可用于生成摘要、提取知识实体、更新向量索引等。
   *
   * @param input - 对话上下文数据
   */
  update?(input: MemoryUpdateInput): Promise<void>

  /**
   * 获取格式化的上下文文本，用于注入 system prompt。
   * 如果插件有特殊的格式化需求，可覆盖此方法。
   *
   * @param query - 可选的查询文本用于定向检索
   * @returns 格式化的上下文字符串，空字符串表示无上下文
   */
  getContext?(query?: string): Promise<string> | string

  /**
   * 清理资源（可选）。
   * 在 Agent 关闭时调用。
   */
  dispose?(): void | Promise<void>
}

/**
 * 将现有 store 对象适配为 IMemoryPlugin 的工厂函数。
 * 适用于已经实现部分方法的 store（如 VectorMemory、KnowledgeGraph）。
 *
 * 使用宽松类型以兼容不同 store 的方法签名差异（适配器模式）。
 * 所有方法调用在运行时通过鸭子类型检查。
 */
export function adaptToPlugin(
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store: Record<string, any>,
): IMemoryPlugin {
  const hasSearch = typeof store.search === 'function'
  const hasQuery = typeof store.query === 'function'
  const hasGetFormattedContext = typeof store.getFormattedContext === 'function'
  const hasDispose = typeof store.dispose === 'function'

  return {
    name,
    async retrieve(query: string, topK: number = 5): Promise<MemoryRetrievalResult[]> {
      const results: MemoryRetrievalResult[] = []

      if (hasSearch) {
        const entries: any[] = await Promise.resolve(store.search(query, topK))
        if (Array.isArray(entries)) {
          for (const e of entries) {
            if (!e) continue
            results.push({
              content: typeof e.content === 'string' ? e.content : (typeof e.summary === 'string' ? e.summary : String(e.value || e.attribute || '')),
              score: typeof e.confidence === 'number' ? e.confidence : (typeof e.score === 'number' ? e.score : 0.5),
              source: name,
              metadata: { type: e.type, tags: e.tags },
              timestamp: e.updatedAt || e.createdAt || Date.now(),
            })
          }
        }
      } else if (hasQuery) {
        const contents: any = await Promise.resolve(store.query(query, topK))
        if (Array.isArray(contents)) {
          for (const c of contents) {
            if (c === null || c === undefined) continue
            results.push({
              content: typeof c === 'string' ? c : (typeof c.content === 'string' ? c.content : JSON.stringify(c)),
              score: typeof c.confidence === 'number' ? c.confidence : 0.5,
              source: name,
              timestamp: c.updatedAt || c.createdAt || Date.now(),
            })
          }
        }
      }

      return results
    },
    getContext(_query?: string): string {
      if (hasGetFormattedContext) {
        const ctx = store.getFormattedContext()
        return typeof ctx === 'string' ? ctx : ''
      }
      return ''
    },
    async dispose(): Promise<void> {
      if (hasDispose) {
        await Promise.resolve(store.dispose())
      }
    },
  }
}
