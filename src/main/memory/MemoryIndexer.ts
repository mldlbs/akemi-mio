import { log } from '../logger/Logger'
import type { MemoryService } from './MemoryService'
import type { EngineeringMemory, EngineeringEntry } from './EngineeringMemory'
import type { KnowledgeGraph } from './KnowledgeGraph'
import type { WorkerPool } from '../core/WorkerPool'

// 正则模式：匹配常见的工程知识模式
const PATTERNS: Array<{ type: EngineeringEntry['type']; regex: RegExp }> = [
  { type: 'architecture_pattern', regex: /(?:架构|体系|分层|模块|服务|architecture|system|layer|module|service)[：:]\s*(.+?)[。\n.!?]/ },
  { type: 'design_decision', regex: /(?:决定|选择|采用|改为|弃用|decided|chose|switched|adopted|migrated)[：:]\s*(.+?)[。\n.!?]/ },
  {
    type: 'failure_pattern',
    regex: /(?:错误|失败|异常|崩溃|超时|挂起|卡死|error|failed|exception|crash|timeout|hang)[：:]\s*(.+?)[。\n.!?]/,
  },
  { type: 'test_pattern', regex: /(?:测试|测试用例|集成测试|单元测试|test|spec|integration|unit test)[：:]\s*(.+?)[。\n.!?]/ },
  { type: 'coding_convention', regex: /(?:约定|规范|命名|风格|格式|convention|standard|naming|style|pattern)[：:]\s*(.+?)[。\n.!?]/ },
]

export class MemoryIndexer {
  private memoryService: MemoryService | null = null
  private engineering: EngineeringMemory | null = null
  private knowledgeGraph: KnowledgeGraph | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private intervalMs: number
  private lastIndexed: number = 0
  private lastEntryCount: number = 0
  private workerPool: WorkerPool | null = null

  constructor(intervalMinutes: number = 30) {
    this.intervalMs = intervalMinutes * 60 * 1000
  }

  setWorkerPool(wp: WorkerPool | null): void {
    this.workerPool = wp
  }

  setMemoryService(ms: MemoryService): void {
    this.memoryService = ms
  }
  setEngineering(eng: EngineeringMemory): void {
    this.engineering = eng
  }
  setKnowledgeGraph(kg: KnowledgeGraph): void {
    this.knowledgeGraph = kg
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), this.intervalMs)
    log('INFO', 'memory_indexer_started', { intervalMs: this.intervalMs })
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async tick(): Promise<void> {
    log('INFO', 'memory_indexer_tick', { lastIndexed: this.lastIndexed })
    if (!this.memoryService) return

    const entries = this.memoryService.getEntries()
    const lastIndexed = this.lastIndexed
    const lastCount = this.lastEntryCount
    this.lastEntryCount = entries.length
    this.lastIndexed = Date.now()

    // Try worker path first
    const workerAvailable = this.workerPool?.isActive('memory-indexer') && !this.workerPool.isBusy('memory-indexer')

    let result: { knowledgeEntries: Array<{ content: string; confidence: number }>; engineeringEntries: EngineeringEntry[] } | null = null

    if (workerAvailable && this.workerPool) {
      try {
        result = await this.workerPool.sendTaskAndWait('memory-indexer', 'index', { entries, lastIndexed }, 10_000)
      } catch {
        log('WARN', 'memory_indexer_worker_failed_falling_back')
      }
    }

    // Fall back to inline execution
    if (!result) {
      result = this.runIndex(entries, lastIndexed)
    }

    // Apply results on main thread (DB calls need main-process modules)
    if (this.knowledgeGraph) {
      for (const ke of result.knowledgeEntries) {
        this.knowledgeGraph.ingest(ke.content, ke.confidence)
      }
    }
    if (this.engineering) {
      for (const ee of result.engineeringEntries) {
        this.engineering.store(ee)
      }
    }

    if (result.engineeringEntries.length > 0) {
      log('INFO', 'memory_indexer_stored', {
        knowledge: result.knowledgeEntries.length,
        engineering: result.engineeringEntries.length,
        worker: !!result,
      })
    }
  }

  /** 纯函数：对条目执行匹配逻辑（供 worker 和 inline fallback 共享） */
  runIndex(
    entries: Array<{ id?: string; type: string; content: string; confidence: number; updatedAt: number }>,
    lastIndexed: number,
  ): { knowledgeEntries: Array<{ content: string; confidence: number }>; engineeringEntries: EngineeringEntry[] } {
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
            tags: this.inferTags(p.type, match[1]),
          })
        }
      }
    }

    return { knowledgeEntries, engineeringEntries }
  }

  /** 根据类型和内容推断标签 */
  private inferTags(type: EngineeringEntry['type'], content: string): string[] {
    const tags: string[] = [type.replace('_', ':')]
    // 提取关键词（3+ 英文单词）
    const keywords = content.match(/[a-zA-Z]{3,}/g) || []
    for (const kw of keywords.slice(0, 3)) {
      tags.push(kw.toLowerCase())
    }
    return tags
  }
}
