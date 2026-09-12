/**
 * MemoryIndexer Worker — 在 worker_thread 中执行纯 CPU 匹配工作
 *
 * 从主进程接收 { entries, lastIndexed }，返回匹配结果。
 * 不调用 DB/KnowledgeGraph/EngineeringMemory — 主线程负责持久化。
 */

import './base-worker'

interface MemoryEntry {
  id?: string
  type: string
  content: string
  confidence: number
  updatedAt: number
}

interface EngineeringEntry {
  type: string
  content: string
  source: string
  confidence: number
  relatedFiles: string[]
  tags: string[]
}

interface IndexResult {
  knowledgeEntries: Array<{ content: string; confidence: number }>
  engineeringEntries: EngineeringEntry[]
}

// 正则模式 (copied from MemoryIndexer for worker isolation)
const PATTERNS: Array<{ type: EngineeringEntry['type']; regex: RegExp }> = [
  { type: 'architecture_pattern', regex: /(?:架构|体系|分层|模块|服务)[：:]\s*(.+?)[。\n]/ },
  { type: 'design_decision', regex: /(?:决定|选择|采用|改为|弃用)[：:]\s*(.+?)[。\n]/ },
  { type: 'failure_pattern', regex: /(?:错误|失败|异常|崩溃|超时|挂起|卡死)[：:]\s*(.+?)[。\n]/ },
  { type: 'test_pattern', regex: /(?:测试|测试用例|集成测试|单元测试)[：:]\s*(.+?)[。\n]/ },
  { type: 'coding_convention', regex: /(?:约定|规范|命名|风格|格式)[：:]\s*(.+?)[。\n]/ },
]

function inferTags(type: EngineeringEntry['type'], content: string): string[] {
  const tags: string[] = [type.replace('_', ':')]
  const keywords = content.match(/[a-zA-Z]{3,}/g) || []
  for (const kw of keywords.slice(0, 3)) {
    tags.push(kw.toLowerCase())
  }
  return tags
}

;(globalThis as any).__workerHandler = async (data: { entries: MemoryEntry[]; lastIndexed: number }): Promise<IndexResult> => {
  const { entries, lastIndexed } = data
  const knowledgeEntries: Array<{ content: string; confidence: number }> = []
  const engineeringEntries: EngineeringEntry[] = []

  for (const entry of entries) {
    if (entry.type === 'user_fact' && entry.confidence >= 0.6) {
      knowledgeEntries.push({ content: entry.content, confidence: entry.confidence })
    }

    if (entry.updatedAt <= lastIndexed) continue
    for (const p of PATTERNS) {
      const match = entry.content.match(p.regex)
      if (match) {
        engineeringEntries.push({
          type: p.type,
          content: match[1].trim(),
          source: `memory:${entry.id || 'unknown'}`,
          confidence: entry.confidence * 0.8,
          relatedFiles: [],
          tags: inferTags(p.type, match[1]),
        })
      }
    }
  }

  return { knowledgeEntries, engineeringEntries }
}
