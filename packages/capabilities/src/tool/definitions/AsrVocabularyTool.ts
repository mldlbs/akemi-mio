/**
 * AsrVocabularyTool — 记忆唤醒语音热词的 MCP 工具定义
 *
 * 提供两个 MCP 工具：
 * 1. inject_asr_vocabulary — 将记忆中的命名实体注入 ASR 热词系统
 * 2. query_asr_vocabulary — 查询当前 ASR 热词和记忆实体状态
 *
 * 这些工具可以通过 MCP 接口被外部系统调用，
 * 实现在 ASR 启动时注入领域词表的功能。
 */

import { buildTool, formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'
import { asrHotwordManager } from '@akemi-mio/audio/AsrHotwordManager'
import { memoryEntityExtractor } from '@akemi-mio/audio/MemoryEntityExtractor'

// ══════════════════════════════════════════
//  工具：注入 ASR 领域词汇
// ══════════════════════════════════════════

export const injectAsrVocabularyTool = buildTool({
  name: 'inject_asr_vocabulary',
  description:
    '将一组领域词汇注入 ASR 语音识别的热词系统，提升对这些词汇的识别准确率。用于在 ASR 启动时或检测到新对话话题时调用，使 ASR 更准确地识别专有名词、人名、项目名和地名。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      words: {
        type: 'array',
        items: { type: 'string' },
        description: '要注入的词汇列表（如 ["TypeScript", "Akemi Mio", "进化系统"]）',
        maxItems: 50,
      },
      domain: {
        type: 'string',
        enum: ['编程开发', '系统运维', '音乐娱乐', '图像创作', '社交沟通', '生活日常', '专业术语', '其他'],
        description: '词汇所属领域标签（可选，默认自动分类）',
      },
      persist: {
        type: 'boolean',
        description: '是否持久化保存（默认 true），持久化的词会跨会话保留',
        default: true,
      },
    },
    required: ['words'],
  },
  handler: async (args: Record<string, any>) => {
    const words: string[] = args.words
    if (!words || words.length === 0) {
      return formatToolError('词汇列表为空')
    }

    // 限制最大注入数
    const MAX_INJECT = 50
    const toInject = words.slice(0, MAX_INJECT)
    const domain = args.domain as string | undefined
    const persist = args.persist !== false

    // 统计注入前热词数量
    const hotwordsBefore = asrHotwordManager.getHotwords().length

    // 注入到热词管理器
    if (persist) {
      // 持久化：作为种子词表长期保留
      const seedEntries = toInject.map((w) => {
        if (domain && domain !== '其他') {
          return { word: w, domain: domain as any }
        }
        return w
      })
      asrHotwordManager.seedVocabulary(seedEntries)
    } else {
      // 临时：通过 feedUserText 加入短期窗口
      for (const word of toInject) {
        asrHotwordManager.feedUserText(word)
        // 重复两次提高权重
        asrHotwordManager.feedUserText(word)
      }
    }

    const hotwordsAfter = asrHotwordManager.getHotwords().length

    return formatToolResult(
      JSON.stringify(
        {
          success: true,
          injected: toInject.length,
          domain: domain || 'auto',
          persisted: persist,
          hotwordCountBefore: hotwordsBefore,
          hotwordCountAfter: hotwordsAfter,
          sample: toInject.slice(0, 5),
        },
        null,
        2,
      ),
    )
  },
})

// ══════════════════════════════════════════
//  工具：查询 ASR 词表状态
// ══════════════════════════════════════════

export const queryAsrVocabularyTool = buildTool({
  name: 'query_asr_vocabulary',
  description: '查询当前 ASR 热词系统和记忆实体提取器的状态，包括活跃热词、记忆实体统计和长时词表信息。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      detail: {
        type: 'string',
        enum: ['summary', 'hotwords', 'entities', 'all'],
        description: '查询详细程度（默认 summary）',
        default: 'summary',
      },
    },
    required: [],
  },
  handler: async (args: Record<string, any>) => {
    const detail = (args.detail as string) || 'summary'

    // 基础信息
    const hotwordState = asrHotwordManager.getState()

    const result: Record<string, any> = {
      hotwordManager: {
        enabled: hotwordState.enabled,
        totalInputs: hotwordState.totalInputs,
        entryCount: hotwordState.entries.length,
        longTermVocabSize: asrHotwordManager.getLongTermVocabSize(),
      },
    }

    // 热词详情
    if (detail === 'hotwords' || detail === 'all') {
      result.hotwords = asrHotwordManager.getHotwords()
      result.vocabulary = asrHotwordManager.exportVocabulary().slice(0, 30)
      result.domainStats = asrHotwordManager.getDomainBreakdown()
    }

    // 实体详情
    if (detail === 'entities' || detail === 'all') {
      const entityStats = memoryEntityExtractor.getStats()
      result.entityExtractor = entityStats
      result.entities = {
        persons: memoryEntityExtractor.getTopByCategory('person', 10).map((e) => ({ name: e.name, freq: e.frequency })),
        projects: memoryEntityExtractor.getTopByCategory('project', 10).map((e) => ({ name: e.name, freq: e.frequency })),
        locations: memoryEntityExtractor.getTopByCategory('location', 10).map((e) => ({ name: e.name, freq: e.frequency })),
      }
    }

    return formatToolResult(JSON.stringify(result, null, 2))
  },
})

// ══════════════════════════════════════════
//  工具：清除 ASR 词表
// ══════════════════════════════════════════

export const clearAsrVocabularyTool = buildTool({
  name: 'clear_asr_vocabulary',
  description: '清除 ASR 热词系统或记忆实体提取器的所有数据。用于调试或重置个性化词表。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        enum: ['hotwords', 'entities', 'all'],
        description: '清除目标（默认 all）',
        default: 'all',
      },
    },
    required: [],
  },
  handler: async (args: Record<string, any>) => {
    const target = (args.target as string) || 'all'
    const cleared: string[] = []

    if (target === 'hotwords' || target === 'all') {
      asrHotwordManager.clearAllVocabulary()
      cleared.push('hotwords')
    }

    if (target === 'entities' || target === 'all') {
      memoryEntityExtractor.clear()
      cleared.push('entities')
    }

    return formatToolResult(
      JSON.stringify(
        {
          success: true,
          cleared,
        },
        null,
        2,
      ),
    )
  },
})

