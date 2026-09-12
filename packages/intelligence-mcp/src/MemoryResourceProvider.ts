/**
 * MemoryResourceProvider — 将长期记忆系统作为 MCP 资源暴露
 *
 * 资源 URI 方案：
 *   memory://entries                     → 所有记忆条目（摘要列表）
 *   memory://entries/{id}                → 按 ID 读取单条记忆
 *   memory://entries/permanent           → 永久层条目列表
 *   memory://entries/semi                → 半永久层条目列表
 *   memory://entries/ephemeral           → 临时层条目列表
 *   memory://stats                       → 记忆系统统计信息
 *   memory://preferences                 → 用户画像条目
 *   memory://search?q={query}&topK={n}   → 语义搜索结果
 *
 * 集成方式：
 *   由 ServerManager.setMemoryService() 在内存服务就绪时自动创建并注入。
 *   ServerManager 通过 getResourceDefinitions() / readResource() 对外暴露。
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { MemoryService } from '@akemi-mio/intelligence-memory'
import type { MemoryEntry } from '@akemi-mio/intelligence-memory'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

export interface MemoryResourceDefinition {
  /** 资源的 MCP URI，如 "memory://entries/mem_xxx" */
  uri: string
  /** 人类可读的名称 */
  name: string
  /** 资源描述 */
  description: string
  /** MIME 类型，默认 "text/plain" */
  mimeType?: string
}

export interface ResourceContent {
  /** 资源的完整 URI */
  uri: string
  /** 资源的 MIME 类型 */
  mimeType: string
  /** 资源内容（纯文本） */
  text: string
}

// ══════════════════════════════════════════
//  记忆服务器配置
// ══════════════════════════════════════════

export interface MemoryServerConfig {
  /** 是否启用记忆系统 */
  enabled: boolean
  /**
   * 隐私级别：
   *   strict    → 需要明确同意才存储事实，仅暴露非敏感元数据
   *   normal    → 自动存储用户事实，暴露条目内容但不包含 `user_profile` 类型
   *   permissive → 存储所有交互，暴露所有条目类型
   */
  privacyLevel: 'strict' | 'normal' | 'permissive'
  /** 记忆保留天数（临时层条目超过此天数会被自动清理） */
  retentionDays: number
  /** 是否启用自动记忆压缩（MemoryCompressor） */
  compressionEnabled: boolean
}

const DEFAULT_CONFIG: MemoryServerConfig = {
  enabled: true,
  privacyLevel: 'normal',
  retentionDays: 90,
  compressionEnabled: true,
}

// ══════════════════════════════════════════
//  URI 解析工具
// ══════════════════════════════════════════

interface ParsedUri {
  /** URI 类型：list / single / search / stats / preferences */
  type: 'entry-list' | 'entry-single' | 'search' | 'stats' | 'preferences'
  /** 条目 ID（仅 type='entry-single' 时存在） */
  entryId?: string
  /** 层级过滤（仅 type='entry-list' 时存在） */
  tier?: 'permanent' | 'semi' | 'ephemeral'
  /** 搜索查询（仅 type='search' 时存在） */
  query?: string
  /** topK（仅 type='search' 时存在） */
  topK?: number
}

/**
 * 解析 memory:// URI 为结构化参数。
 * 使用 URL API 进行解析，注意：
 *   memory://entries/{id} → hostname=entries, pathname=/{id}
 *   memory://stats         → hostname=stats, pathname=""
 *   memory://search?q=...  → hostname=search, pathname="", searchParams={q}
 * 无法解析的 URI 返回 null。
 */
function parseMemoryUri(uri: string): ParsedUri | null {
  try {
    const url = new URL(uri)
    if (url.protocol !== 'memory:') return null

    const resourceType = url.hostname
    const pathPart = url.pathname.replace(/^\/+/, '') // 移除前导斜杠

    // memory://entries/{id} 或 memory://entries/permanent
    if (resourceType === 'entries') {
      if (pathPart === 'permanent') return { type: 'entry-list', tier: 'permanent' }
      if (pathPart === 'semi') return { type: 'entry-list', tier: 'semi' }
      if (pathPart === 'ephemeral') return { type: 'entry-list', tier: 'ephemeral' }
      if (pathPart.length > 0) return { type: 'entry-single', entryId: pathPart }
      return { type: 'entry-list' }
    }

    // memory://search?q=xxx&topK=5
    if (resourceType === 'search') {
      const q = url.searchParams.get('q')
      const topK = parseInt(url.searchParams.get('topK') || '5', 10)
      return q ? { type: 'search', query: q, topK: Math.min(Math.max(topK, 1), 20) } : null
    }

    // memory://stats
    if (resourceType === 'stats') return { type: 'stats' }

    // memory://preferences
    if (resourceType === 'preferences') return { type: 'preferences' }

    return null
  } catch {
    return null
  }
}

// ══════════════════════════════════════════
//  MemoryResourceProvider
// ══════════════════════════════════════════

export class MemoryResourceProvider {
  private memoryService: MemoryService | null = null
  private config: MemoryServerConfig = { ...DEFAULT_CONFIG }

  /** 设置内存服务引用 */
  setMemoryService(ms: MemoryService | null): void {
    this.memoryService = ms
    log('INFO', 'memory_resource_provider_service_set', {
      available: ms !== null,
    })
  }

  /** 获取当前配置 */
  getConfig(): Readonly<MemoryServerConfig> {
    return { ...this.config }
  }

  /**
   * 更新记忆服务器配置。
   * 返回更新后的完整配置。
   */
  updateConfig(partial: Partial<MemoryServerConfig>): MemoryServerConfig {
    const oldEnabled = this.config.enabled
    this.config = { ...this.config, ...partial }
    log('INFO', 'memory_server_config_updated', {
      changed: Object.keys(partial),
      oldEnabled,
      newEnabled: this.config.enabled,
    })
    return { ...this.config }
  }

  // ══════════════════════════════════════════
  //  资源定义
  // ══════════════════════════════════════════

  /**
   * 获取所有资源定义（包含动态和静态资源）。
   * 静态资源：URI 模板，如 memory://entries/{id}
   * 动态资源：具体条目 URI（由内存服务实时生成）
   *
   * 注意：具体条目的 URI 由 readResource 动态处理。
   * 此处返回的 definitions 是资源发现入口。
   */
  getResourceDefinitions(): MemoryResourceDefinition[] {
    const defs: MemoryResourceDefinition[] = [
      {
        uri: 'memory://entries',
        name: '所有记忆条目',
        description: '列出所有记忆条目的摘要列表（包含 ID、类型、层级、置信度）',
      },
      {
        uri: 'memory://entries/{id}',
        name: '单条记忆条目',
        description: '按 ID 读取单条记忆条目的完整内容。将 {id} 替换为具体记忆 ID',
      },
      {
        uri: 'memory://entries/permanent',
        name: '永久层条目',
        description: '永久层（permanent）记忆条目列表',
      },
      {
        uri: 'memory://entries/semi',
        name: '半永久层条目',
        description: '半永久层（semi）记忆条目列表',
      },
      {
        uri: 'memory://entries/ephemeral',
        name: '临时层条目',
        description: '临时层（ephemeral）记忆条目列表',
      },
      {
        uri: 'memory://search?q={query}&topK={n}',
        name: '记忆语义搜索',
        description: '语义搜索记忆内容。替换 {query} 为搜索查询文本，{n} 为返回结果数（默认 5, 最大 20）',
      },
      {
        uri: 'memory://stats',
        name: '记忆系统统计',
        description: '记忆系统的统计信息，包括条目数、层级分布、访问模式等',
      },
      {
        uri: 'memory://preferences',
        name: '用户画像',
        description: '已存储的用户偏好/画像条目',
      },
    ]

    return defs
  }

  // ══════════════════════════════════════════
  //  资源读取
  // ══════════════════════════════════════════

  /**
   * 读取指定 URI 的资源内容。
   * 如果记忆服务不可用或 URI 无法解析，返回错误内容。
   */
  async readResource(uri: string): Promise<ResourceContent> {
    // 配置检查：禁用时返回不可用
    if (!this.config.enabled) {
      return {
        uri,
        mimeType: 'text/plain',
        text: '记忆系统已禁用。请使用 configure_memory 工具启用。',
      }
    }

    const parsed = parseMemoryUri(uri)
    if (!parsed) {
      return {
        uri,
        mimeType: 'text/plain',
        text: `无效的资源 URI: ${uri}\n\n可用资源：\n${this.getResourceDefinitions()
          .map((d) => `  ${d.uri} — ${d.description}`)
          .join('\n')}`,
      }
    }

    switch (parsed.type) {
      case 'entry-list':
        return this.readEntryList(uri, parsed.tier)
      case 'entry-single':
        return this.readEntrySingle(uri, parsed.entryId!)
      case 'search':
        return this.readSearch(uri, parsed.query!, parsed.topK!)
      case 'stats':
        return this.readStats(uri)
      case 'preferences':
        return this.readPreferences(uri)
    }
  }

  // ══════════════════════════════════════════
  //  内部读取方法
  // ══════════════════════════════════════════

  private formatEntrySummary(entry: MemoryEntry): string {
    const id = entry.id
    const type = entry.type.padEnd(20)
    const tier = entry.tier.padEnd(12)
    const conf = entry.confidence.toFixed(2)
    const score = entry.behaviorScore.toFixed(2)
    const pinned = entry.isPinned ? ' ⭐' : ''
    const content = entry.content.slice(0, 120)
    return `  [${id}] ${type} tier=${tier} conf=${conf} score=${score}${pinned}\n    ${content}`
  }

  private shouldExcludeByPrivacy(entry: MemoryEntry): boolean {
    if (this.config.privacyLevel === 'permissive') return false
    // strict 级别：只暴露明确要求记住的条目
    if (this.config.privacyLevel === 'strict') {
      // strict 下只包含 pinned 或永久层条目
      return !entry.isPinned && entry.tier !== 'permanent'
    }
    // normal 级别：排除 user_profile 类型（敏感信息）
    return entry.type === 'user_profile'
  }

  private readEntryList(uri: string, tier?: 'permanent' | 'semi' | 'ephemeral'): ResourceContent {
    const ms = this.memoryService
    if (!ms) {
      return { uri, mimeType: 'text/plain', text: '记忆服务暂不可用。' }
    }

    const entries = ms.getEntries()
    const filtered = entries.filter((e) => {
      if (tier && e.tier !== tier) return false
      if (this.shouldExcludeByPrivacy(e)) return false
      return true
    })

    if (filtered.length === 0) {
      return { uri, mimeType: 'text/plain', text: `没有找到记忆条目${tier ? ` (tier=${tier})` : ''}。` }
    }

    const header = tier ? `记忆条目列表 (tier=${tier}) — 共 ${filtered.length} 条\n` : `记忆条目列表 — 共 ${filtered.length} 条\n`
    const lines = filtered.map((e) => this.formatEntrySummary(e))
    return { uri, mimeType: 'text/plain', text: header + lines.join('\n') }
  }

  private readEntrySingle(uri: string, entryId: string): ResourceContent {
    const ms = this.memoryService
    if (!ms) {
      return { uri, mimeType: 'text/plain', text: '记忆服务暂不可用。' }
    }

    const entries = ms.getEntries()
    const entry = entries.find((e) => e.id === entryId)

    if (!entry) {
      // 尝试在所有条目中搜索包含该 ID 的内容（可能为 key 格式 [key]）
      const byKeyPrefix = entries.find((e) => e.content.startsWith(`[${entryId}]`))
      if (byKeyPrefix) {
        return this.formatEntryDetail(uri, byKeyPrefix)
      }
      return { uri, mimeType: 'text/plain', text: `未找到记忆条目: id="${entryId}"` }
    }

    if (this.shouldExcludeByPrivacy(entry)) {
      return { uri, mimeType: 'text/plain', text: `条目 ${entry.id} 因隐私设置不可见。` }
    }

    return this.formatEntryDetail(uri, entry)
  }

  private formatEntryDetail(uri: string, entry: MemoryEntry): ResourceContent {
    const lines: string[] = []
    lines.push(`ID: ${entry.id}`)
    lines.push(`类型: ${entry.type}`)
    lines.push(`层级: ${entry.tier}`)
    lines.push(`置信度: ${entry.confidence.toFixed(2)}`)
    lines.push(`行为得分: ${entry.behaviorScore.toFixed(2)}`)
    lines.push(`强化次数: ${entry.reinforceCount}`)
    lines.push(`访问次数: ${entry.accessCount}`)
    lines.push(`是否固定: ${entry.isPinned ? '是' : '否'}`)
    lines.push(`创建时间: ${new Date(entry.createdAt).toISOString()}`)
    lines.push(`更新时间: ${new Date(entry.updatedAt).toISOString()}`)
    if (entry.lastAccessedAt > 0) {
      lines.push(`最后访问: ${new Date(entry.lastAccessedAt).toISOString()}`)
    }
    if (entry.topics && entry.topics.length > 0) {
      lines.push(`话题标签: ${entry.topics.join(', ')}`)
    }
    if (entry.structuredData) {
      lines.push(`结构化数据: ${entry.structuredData}`)
    }
    lines.push(`---`)
    lines.push(`内容:`)
    lines.push(entry.content)

    return { uri, mimeType: 'text/plain', text: lines.join('\n') }
  }

  private async readSearch(uri: string, query: string, topK: number): Promise<ResourceContent> {
    const ms = this.memoryService
    if (!ms) {
      return { uri, mimeType: 'text/plain', text: '记忆服务暂不可用。' }
    }

    try {
      const results = await ms.unifiedQuery.query(query, { topK, minConfidence: 0.3 })
      if (results.length === 0) {
        return { uri, mimeType: 'text/plain', text: `未找到与 "${query}" 相关的记忆。` }
      }

      const header = `语义搜索 "${query}" 结果 — 共 ${results.length} 条\n`
      const lines = results.map((r, i) => {
        const entry = ms.getEntries().find((e) => e.content === r.content)
        const idStr = entry ? `[${entry.id}]` : ''
        return `  ${i + 1}. ${idStr} (${r.store}, 得分 ${r.score.toFixed(2)})\n    ${r.content.slice(0, 200)}`
      })
      return { uri, mimeType: 'text/plain', text: header + lines.join('\n') }
    } catch (err: any) {
      return { uri, mimeType: 'text/plain', text: `搜索失败: ${err.message}` }
    }
  }

  private readStats(uri: string): ResourceContent {
    const ms = this.memoryService
    if (!ms) {
      return { uri, mimeType: 'text/plain', text: '记忆服务暂不可用。' }
    }

    const entries = ms.getEntries()
    const totalEntries = entries.length
    const permanent = entries.filter((e) => e.tier === 'permanent').length
    const semi = entries.filter((e) => e.tier === 'semi').length
    const ephemeral = entries.filter((e) => e.tier === 'ephemeral').length
    const pinned = entries.filter((e) => e.isPinned).length
    const userFacts = entries.filter((e) => e.type === 'user_fact').length
    const profiles = entries.filter((e) => e.type === 'user_profile').length
    const interactions = entries.filter((e) => e.type === 'interaction').length

    // 尝试获取优化统计
    let extraStats = ''
    try {
      const optStats = ms.getOptimizationStats()
      extraStats = `\n访问统计:\n  从未访问: ${optStats.accessStats.neverAccessedCount}\n  7天未访问: ${optStats.accessStats.staleEntriesCount}\n  长尾条目: ${optStats.accessStats.longTailCount}\n效用统计:\n  高效用: ${optStats.utilityStats.highUtilityCount}\n  低效用: ${optStats.utilityStats.lowUtilityCount}\n行为得分均值: ${optStats.behaviorStats.meanBehaviorScore.toFixed(3)}`
    } catch {
      // 静默
    }

    const config = this.getConfig()
    const text = `记忆系统统计
================
条目总数: ${totalEntries}
  永久层: ${permanent}
  半永久层: ${semi}
  临时层: ${ephemeral}
  已固定: ${pinned}
  用户事实: ${userFacts}
  用户画像: ${profiles}
  交互记录: ${interactions}

记忆服务器配置:
  启用状态: ${config.enabled ? '已启用' : '已禁用'}
  隐私级别: ${config.privacyLevel}
  保留天数: ${config.retentionDays}
  自动压缩: ${config.compressionEnabled ? '已启用' : '已禁用'}
${extraStats}`

    return { uri, mimeType: 'text/plain', text }
  }

  private readPreferences(uri: string): ResourceContent {
    const ms = this.memoryService
    if (!ms) {
      return { uri, mimeType: 'text/plain', text: '记忆服务暂不可用。' }
    }

    // 隐私检查
    if (this.config.privacyLevel === 'strict') {
      return { uri, mimeType: 'text/plain', text: '用户画像在 strict 隐私级别下不可见。' }
    }

    const prefs = ms.getUserPreferences()
    if (prefs.length === 0) {
      return { uri, mimeType: 'text/plain', text: '没有存储的用户画像。' }
    }

    const header = `用户画像 — 共 ${prefs.length} 条\n`
    const lines = prefs.map((p) => {
      const cat = p.category.padEnd(12)
      return `  [${cat}] ${p.key}: ${p.value} (置信度: ${p.confidence.toFixed(2)})`
    })
    return { uri, mimeType: 'text/plain', text: header + lines.join('\n') }
  }
}
