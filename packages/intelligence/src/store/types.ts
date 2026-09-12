/**
 * Store — Memory/Agent 统一抽象层
 *
 * 分析「Memory」和「Agent」的对外接口后，将语义相似的操作抽象为共用接口。
 *
 * 设计原则：
 * - 只读接口（ReadableStore）优先，写接口（WritableStore）在其上扩展
 * - 保持各模块特性能力不丢失（通过 metadata / type 区分）
 * - 策略模式在运行时选择具体实现
 * - 与现有 IMemoryPlugin 兼容但不耦合
 */

// ══════════════════════════════════════════
//  基础类型
// ══════════════════════════════════════════

/** Store 类型标签，用于运行时区分实现来源 */
export type StoreType = 'memory' | 'agent' | 'cognitive' | 'capability'

/** 检索选项 */
export interface SearchOptions {
  /** 返回的最相关条目数（默认取决于具体实现） */
  topK?: number
  /** 最低相关性得分过滤（0-1） */
  minScore?: number
  /** 按类别/类型过滤 */
  filter?: Record<string, unknown>
}

/** 统一检索结果 */
export interface SearchResult {
  /** 条目内容 */
  content: string
  /** 相关性得分 0-1 */
  score: number
  /** 来源 store 名称 */
  source: string
  /** Store 类型标签 */
  sourceType: StoreType
  /** 可选唯一标识 */
  id?: string
  /** 附加元数据 */
  metadata?: Record<string, unknown>
  /** 时间戳 */
  timestamp?: number
}

// ══════════════════════════════════════════
//  只读接口（ReadableStore）
// ══════════════════════════════════════════

/**
 * ReadableStore — 只读存储接口
 *
 * 所有可查询的存储（Memory、Agent、Cognitive 等）实现此接口后，
 * 调用方可通过统一的 search / getContext 访问，无需感知具体实现。
 */
export interface ReadableStore {
  /** 唯一标识 */
  readonly name: string

  /** 类型标签 */
  readonly type: StoreType

  /**
   * 语义/关键词检索。
   * 适配不同存储的查询能力（向量搜索 / SQL LIKE / 关键词评分 / 实体查询）。
   */
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>

  /**
   * 获取格式化的上下文文本，用于注入 system prompt。
   * 各存储按自身逻辑组织上下文格式。
   */
  getContext(keywords?: string[]): Promise<string>

  /**
   * 获取描述性统计信息（可选）。
   * 用于监控和调试。
   */
  getStats?(): Record<string, unknown>
}

// ══════════════════════════════════════════
//  写入接口（WritableStore）
// ══════════════════════════════════════════

/** 写入操作结果 */
export interface WriteResult {
  id?: string
  success: boolean
  error?: string
}

/** 写入条目 */
export interface WriteInput {
  content: string
  type?: string
  confidence?: number
  tags?: string[]
  metadata?: Record<string, unknown>
}

/**
 * WritableStore — 可写存储接口
 *
 * 在 ReadableStore 基础上扩展写入能力。
 * 并非所有 ReadableStore 都需要实现写入（如只读分析器）。
 */
export interface WritableStore extends ReadableStore {
  /**
   * 存储一条新条目。
   * 各实现自行处理去重、更新、持久化逻辑。
   */
  store(input: WriteInput): Promise<WriteResult>

  /**
   * 按标识删除条目。
   * 返回 true 表示已删除，false 表示未找到。
   */
  delete(id: string): Promise<boolean>
}

// ══════════════════════════════════════════
//  策略选择器
// ══════════════════════════════════════════

/**
 * StoreSelector — 策略模式选择器
 *
 * 在运行时根据查询和上下文选择最佳的 ReadableStore。
 * 不同策略可实现不同的选择逻辑。
 */
export interface StoreSelector {
  /** 根据查询文本和可用存储列表，选择一个最匹配的存储 */
  select(query: string, stores: ReadableStore[]): ReadableStore | null

  /** 选择器的描述 */
  readonly description: string
}
