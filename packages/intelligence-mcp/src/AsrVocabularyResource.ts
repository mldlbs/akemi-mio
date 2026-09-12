/**
 * AsrVocabularyResource — 将 ASR 领域词表作为 MCP 资源暴露
 *
 * 资源 URI 方案：
 *   asr://vocabulary/entities                     → 所有已提取的命名实体（按频率降序）
 *   asr://vocabulary/domain/person                → 人名实体列表
 *   asr://vocabulary/domain/project               → 项目名实体列表
 *   asr://vocabulary/domain/location              → 地点名实体列表
 *   asr://vocabulary/hotwords                     → 当前 ASR 活跃热词列表
 *   asr://vocabulary/stats                        → 词表与热词统计信息
 *
 * 设计目的：
 * 通过标准的 MCP 资源协议暴露 ASR 领域词表，使 LLM Agent 能够：
 * 1. 查询当前 ASR 已学习的领域词汇
 * 2. 理解 ASR 的个性化词表覆盖范围
 * 3. 在识别到热词时触发记忆检索
 *
 * 集成方式：
 *   由 ServerManager 在启动时注册，与 MemoryResourceProvider 并列。
 *   ServerManager 通过 getResourceDefinitions() / readResource() 合并对外暴露。
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { getMemoryService } from '@akemi-mio/capabilities/tool/deps'
import { memoryEntityExtractor, type EntityCategory, type ExtractedEntity } from '@akemi-mio/audio/MemoryEntityExtractor'
import { asrHotwordManager } from '@akemi-mio/audio/AsrHotwordManager'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

export interface AsrResourceDefinition {
  /** 资源的 MCP URI */
  uri: string
  /** 人类可读的名称 */
  name: string
  /** 资源描述 */
  description: string
  /** MIME 类型，默认 "text/plain" */
  mimeType?: string
}

export interface AsrResourceContent {
  /** 资源的完整 URI */
  uri: string
  /** 资源的 MIME 类型 */
  mimeType: string
  /** 资源内容（纯文本） */
  text: string
}

// ══════════════════════════════════════════
//  URI 解析工具
// ══════════════════════════════════════════

interface ParsedAsrUri {
  type: 'entity-list' | 'domain-entities' | 'hotwords' | 'stats'
  category?: EntityCategory
}

function parseAsrUri(uri: string): ParsedAsrUri | null {
  try {
    const url = new URL(uri)
    if (url.protocol !== 'asr:') return null

    const segments = url.hostname + url.pathname.replace(/\/+$/, '')

    // asr://vocabulary/entities
    if (segments === 'vocabulary/entities') return { type: 'entity-list' }

    // asr://vocabulary/domain/{person|project|location}
    const domainMatch = segments.match(/^vocabulary\/domain\/(person|project|location)$/)
    if (domainMatch) return { type: 'domain-entities', category: domainMatch[1] as EntityCategory }

    // asr://vocabulary/hotwords
    if (segments === 'vocabulary/hotwords') return { type: 'hotwords' }

    // asr://vocabulary/stats
    if (segments === 'vocabulary/stats') return { type: 'stats' }

    return null
  } catch {
    return null
  }
}

// ══════════════════════════════════════════
//  AsrVocabularyResource
// ══════════════════════════════════════════

export class AsrVocabularyResource {
  /**
   * 获取所有 ASR 词汇资源定义。
   */
  getResourceDefinitions(): AsrResourceDefinition[] {
    return [
      {
        uri: 'asr://vocabulary/entities',
        name: 'ASR 命名实体词表',
        description: '从 Memory 中提取的所有命名实体列表，按频率降序排列，包含人名、项目名、地点',
      },
      {
        uri: 'asr://vocabulary/domain/person',
        name: 'ASR 人名实体',
        description: '从 Memory 中提取的人名实体列表（如「妈妈」、「张三」等）',
      },
      {
        uri: 'asr://vocabulary/domain/project',
        name: 'ASR 项目名实体',
        description: '从 Memory 中提取的项目名实体列表（如「进化系统」、「Mio」等）',
      },
      {
        uri: 'asr://vocabulary/domain/location',
        name: 'ASR 地点名实体',
        description: '从 Memory 中提取的地点名实体列表（如「北京」、「上海」等）',
      },
      {
        uri: 'asr://vocabulary/hotwords',
        name: 'ASR 活跃热词',
        description: '当前 ASR 识别引擎中活跃的热词列表（短时窗口 + 长时积累词表）',
      },
      {
        uri: 'asr://vocabulary/stats',
        name: 'ASR 词表统计',
        description: 'ASR 领域词表的统计信息，包括实体数量、热词数量、分类分布等',
      },
    ]
  }

  /**
   * 读取指定 URI 的资源内容。
   */
  async readResource(uri: string): Promise<AsrResourceContent> {
    const parsed = parseAsrUri(uri)
    if (!parsed) {
      return {
        uri,
        mimeType: 'text/plain',
        text: `无效的资源 URI: ${uri}\n\n可用 ASR 词汇资源：\n${this.getResourceDefinitions()
          .map((d) => `  ${d.uri} — ${d.description}`)
          .join('\n')}`,
      }
    }

    switch (parsed.type) {
      case 'entity-list':
        return this.readEntityList(uri)
      case 'domain-entities':
        return this.readDomainEntities(uri, parsed.category!)
      case 'hotwords':
        return this.readHotwords(uri)
      case 'stats':
        return this.readStats(uri)
    }
  }

  // ══════════════════════════════════════════
  //  内部读取方法
  // ══════════════════════════════════════════

  /**
   * 读取所有命名实体列表。
   * 从 MemoryEntityExtractor 中获取已提取的实体，按频率降序排列。
   */
  private readEntityList(uri: string): AsrResourceContent {
    const memoryService = getMemoryService()
    if (!memoryService) {
      return { uri, mimeType: 'text/plain', text: 'Memory 服务不可用，无法提取实体。' }
    }

    try {
      // 确保实体提取器已从 Memory 中扫描数据
      memoryEntityExtractor.feedEntries(memoryService.getEntries())
    } catch (err) {
      log('WARN', 'asr_vocab_feed_entries_failed', { error: String(err) })
    }

    const entities = memoryEntityExtractor.getEntities(2) // 至少出现 2 次
    if (entities.length === 0) {
      return { uri, mimeType: 'text/plain', text: '未从 Memory 中提取到命名实体。随对话积累会自动发现。' }
    }

    const parts: string[] = ['ASR 命名实体词表', '================', '']
    parts.push(`共 ${entities.length} 个实体（最低频率 ≥ 2）\n`)

    // 按分类分组显示
    const byCat: Record<string, ExtractedEntity[]> = { person: [], project: [], location: [], other: [] }
    for (const e of entities) {
      if (byCat[e.category]) byCat[e.category].push(e)
      else byCat.other.push(e)
    }

    for (const [cat, items] of Object.entries(byCat)) {
      if (items.length === 0) continue
      const catLabel: Record<string, string> = { person: '👤 人名', project: '📦 项目名', location: '📍 地点' }
      parts.push(`\n${catLabel[cat] || cat} (${items.length}):`)
      for (const item of items.slice(0, 20)) {
        parts.push(`  - ${item.name} (频率: ${item.frequency}, 最后出现: ${new Date(item.lastSeenAt).toLocaleDateString('zh-CN')})`)
      }
      if (items.length > 20) {
        parts.push(`  ... 还有 ${items.length - 20} 个`)
      }
    }

    return { uri, mimeType: 'text/plain', text: parts.join('\n') }
  }

  /**
   * 读取指定分类的实体列表。
   */
  private readDomainEntities(uri: string, category: EntityCategory): AsrResourceContent {
    const memoryService = getMemoryService()
    if (!memoryService) {
      return { uri, mimeType: 'text/plain', text: 'Memory 服务不可用。' }
    }

    try {
      memoryEntityExtractor.feedEntries(memoryService.getEntries())
    } catch (err) {
      log('WARN', 'asr_vocab_feed_entries_failed', { error: String(err) })
    }

    const entities = memoryEntityExtractor.getByCategory(category, 2)

    const catLabel: Record<EntityCategory, string> = {
      person: '人名实体',
      project: '项目名实体',
      location: '地点名实体',
    }

    if (entities.length === 0) {
      return { uri, mimeType: 'text/plain', text: `未从 Memory 中提取到${catLabel[category]}。` }
    }

    const parts: string[] = [`ASR ${catLabel[category]}`, '='.repeat(catLabel[category].length + 5), '']
    parts.push(`共 ${entities.length} 个\n`)

    for (const item of entities) {
      parts.push(`- ${item.name} (频率: ${item.frequency})`)
    }

    return { uri, mimeType: 'text/plain', text: parts.join('\n') }
  }

  /**
   * 读取当前 ASR 活跃热词列表。
   */
  private readHotwords(uri: string): AsrResourceContent {
    const hotwords = asrHotwordManager.getHotwords()
    const allEntries = asrHotwordManager.getEntries()

    if (hotwords.length === 0) {
      return { uri, mimeType: 'text/plain', text: '当前没有活跃 ASR 热词。更多对话后会积累。' }
    }

    const parts: string[] = ['ASR 活跃热词列表', '================', '']
    parts.push(`共 ${hotwords.length} 个热词，窗口条目 ${asrHotwordManager.getState().totalInputs} 条\n`)

    // 展示活跃热词
    parts.push('🔥 当前热词:')
    for (const hw of hotwords) {
      const entry = allEntries.find((e) => e.word === hw)
      const detail = entry ? `(${entry.count}次, ${entry.domain})` : ''
      parts.push(`  - ${hw} ${detail}`)
    }

    // 长时词表统计
    const longTermSize = asrHotwordManager.getLongTermVocabSize()
    const enabled = asrHotwordManager.isEnabled()
    parts.push(`\n长时积累词表: ${longTermSize} 词`)
    parts.push(`热词管理: ${enabled ? '已启用' : '已禁用'}`)

    return { uri, mimeType: 'text/plain', text: parts.join('\n') }
  }

  /**
   * 读取词表统计信息。
   */
  private readStats(uri: string): AsrResourceContent {
    const memoryService = getMemoryService()
    let entityStats = { total: 0, persons: 0, projects: 0, locations: 0, topNames: [] as string[] }

    if (memoryService) {
      try {
        memoryEntityExtractor.feedEntries(memoryService.getEntries())
        entityStats = memoryEntityExtractor.getStats()
      } catch {
        // 静默失败
      }
    }

    const hotwordState = asrHotwordManager.getState()
    const hotwordNames = asrHotwordManager.getHotwords()
    const longTermSize = asrHotwordManager.getLongTermVocabSize()
    const domainStats = asrHotwordManager.getDomainBreakdown()

    const parts: string[] = ['ASR 词表统计信息', '================', '']

    parts.push('📊 命名实体提取:')
    parts.push(`  实体总数: ${entityStats.total}`)
    parts.push(`  人名: ${entityStats.persons}`)
    parts.push(`  项目名: ${entityStats.projects}`)
    parts.push(`  地点: ${entityStats.locations}`)
    if (entityStats.topNames.length > 0) {
      parts.push(`  Top 实体: ${entityStats.topNames.slice(0, 5).join(', ')}`)
    }

    parts.push('')
    parts.push('🔥 热词管理:')
    parts.push(`  已启用: ${hotwordState.enabled}`)
    parts.push(`  活跃热词: ${hotwordNames.length}`)
    parts.push(`  窗口条目: ${hotwordState.totalInputs}`)
    parts.push(`  短时热词条目: ${hotwordState.entries.length}`)
    parts.push(`  长时积累词: ${longTermSize}`)

    if (domainStats.length > 0) {
      parts.push('')
      parts.push('📁 领域分布:')
      for (const ds of domainStats) {
        const bar = '█'.repeat(Math.min(ds.count, 20))
        parts.push(`  ${ds.label}: ${bar} ${ds.count}`)
      }
    }

    return { uri, mimeType: 'text/plain', text: parts.join('\n') }
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

export const asrVocabularyResource = new AsrVocabularyResource()
