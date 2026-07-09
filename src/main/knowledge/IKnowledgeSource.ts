/**
 * IKnowledgeSource — Memory/Agent 统一知识源接口
 *
 * 将 Memory（IMemoryPlugin）和 Agent（ProceduralMemory、ReflectLoop、FailureAnalyzer 等）
 * 对外语义相似的操作抽象为共用接口。
 *
 * 设计原则：
 * - 先只读（查询类），再扩展到写接口
 * - 调用方无需感知具体实现（策略模式在 UnifiedKnowledgeQuery 中运行时选择）
 * - 适配器模式将现有实现包装为 IKnowledgeSource
 */

// ─── 共用类型 ───

export interface QueryOptions {
  topK?: number
  minScore?: number
  /** 按来源名过滤（仅 UnifiedKnowledgeQuery 复合查询时有效） */
  sourceNames?: string[]
}

export interface KnowledgeItem {
  /** 条目唯一标识 */
  id: string
  /** 文本内容 */
  content: string
  /** 相关性/置信度得分 (0-1) */
  score: number
  /** 来源知识源名称 */
  source: string
  /** 附加元数据 */
  metadata?: Record<string, unknown>
  /** 时间戳 */
  timestamp: number
}

export interface SaveInput {
  content: string
  type?: string
  tags?: string[]
  metadata?: Record<string, unknown>
}

// ─── 只读接口（所有知识源必须实现） ───

export interface IKnowledgeSource {
  /** 知识源唯一标识名 */
  readonly name: string

  /**
   * 语义查询：根据查询文本返回最相关的知识条目。
   * Memory 侧：向量检索 + 关键词匹配
   * Agent 侧：embedding 检索 + 关键词匹配 + 热点模式排序
   *
   * @param query - 查询文本
   * @param options - 查询选项
   * @returns 按相关性降序排列的知识条目列表
   */
  query(query: string, options?: QueryOptions): Promise<KnowledgeItem[]>

  /**
   * 获取格式化上下文文本，用于注入 system prompt。
   * Memory 侧：综合格式化记忆上下文
   * Agent 侧：流程记忆/反思/失败模式的格式化摘要
   *
   * @param query - 可选的定向查询文本
   * @returns 格式化的上下文字符串，空字符串表示无可注入上下文
   */
  getContext(query?: string): Promise<string> | string

  /**
   * 清理资源（可选）。
   */
  dispose?(): void | Promise<void>
}

// ─── 可写接口（支持变动的知识源可选实现） ───

export interface IMutableKnowledgeSource extends IKnowledgeSource {
  /**
   * 保存一条知识条目。
   *
   * @param input - 保存内容
   * @returns 新条目的 ID
   */
  save(input: SaveInput): Promise<string>

  /**
   * 按 ID 删除一条知识条目。
   *
   * @param id - 条目 ID
   * @returns true 表示成功删除
   */
  delete(id: string): Promise<boolean>

  /**
   * 列出所有条目（支持分页）。
   */
  listAll?(): Promise<KnowledgeItem[]>
}

// ─── 类型守卫 ───

export function isMutable(source: IKnowledgeSource): source is IMutableKnowledgeSource {
  return 'save' in source && typeof (source as IMutableKnowledgeSource).save === 'function'
}
