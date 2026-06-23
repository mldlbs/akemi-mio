import { log } from '../logger/Logger'
import { SummaryMemory } from './SummaryMemory'
import { VectorMemory } from './VectorMemory'
import { KnowledgeGraph } from './KnowledgeGraph'
import { EngineeringMemory } from './EngineeringMemory'
import { DecisionStore } from './DecisionStore'
import { MetaController } from './MetaController'
import { UnifiedMemoryQuery } from './UnifiedMemoryQuery'
import type { MemoryEntry } from './types'
import { getRawDb, markDirty } from '../db/connection'

// ===== 层级容量 =====
const MAX_PERMANENT = 10
const MAX_SEMI = 30
const MAX_EPHEMERAL = 50

// ===== 层级衰减率 =====
const DECAY_PERMANENT = 1.0 // 永不衰减
const DECAY_SEMI = 0.998 // 慢衰减（~346天减半）
const DECAY_EPHEMERAL = 0.99 // 正常衰减（~69天减半）

// ===== 晋升阈值 =====
const PROMOTE_SEMI_CONFIDENCE = 0.85 // 临时→半永久
const PROMOTE_PERMANENT_REINFORCE = 5 // 强化≥5次→永久
const PROMOTE_PERMANENT_CONFIDENCE = 0.97 // 置信度≥0.97→永久

const MIN_CONFIDENCE = 0.5
const INTERACTION_RECORD_INTERVAL = 5

let idCounter = 0
function nextId(): string {
  return `mem_${Date.now()}_${++idCounter}`
}

export class MemoryService {
  private entries: MemoryEntry[] = []
  private messageCount: number = 0
  private lastUserText: string = ''
  private removedIds = new Set<string>()

  readonly summary: SummaryMemory
  readonly vector: VectorMemory
  readonly knowledgeGraph: KnowledgeGraph
  readonly engineering: EngineeringMemory
  readonly decisionStore: DecisionStore
  readonly metaController: MetaController
  readonly unifiedQuery: UnifiedMemoryQuery

  constructor() {
    this.summary = new SummaryMemory()
    this.vector = new VectorMemory()
    this.knowledgeGraph = new KnowledgeGraph()
    this.engineering = new EngineeringMemory()
    this.decisionStore = new DecisionStore()
    this.metaController = new MetaController()
    this.metaController.setDeps({
      summary: this.summary,
      decisions: this.decisionStore,
      memory: this,
    })
    this.unifiedQuery = new UnifiedMemoryQuery()
    this.unifiedQuery.register('memory', this)
    this.unifiedQuery.register('vector', this.vector)
    this.unifiedQuery.register('summary', this.summary)
    this.unifiedQuery.register('kg', this.knowledgeGraph)
    this.unifiedQuery.register('engineering', this.engineering)
    this.load()
    log('INFO', 'memory_loaded', {
      entries: this.entries.length,
      permanent: this.entries.filter((e) => e.tier === 'permanent').length,
      semi: this.entries.filter((e) => e.tier === 'semi').length,
      ephemeral: this.entries.filter((e) => e.tier === 'ephemeral').length,
    })
  }

  private load(): void {
    try {
      const db = getRawDb()
      const result = db.exec('SELECT * FROM memories ORDER BY updated_at ASC')
      if (result && result.length > 0) {
        const columns = result[0].columns
        this.entries = result[0].values.map((v: any[]) => {
          const obj: any = {}
          for (let i = 0; i < columns.length; i++) obj[columns[i]] = v[i]
          return {
            id: obj.id,
            type: obj.type,
            content: obj.content,
            confidence: obj.confidence,
            tier: obj.tier || 'ephemeral',
            reinforceCount: obj.reinforce_count || 0,
            createdAt: obj.created_at,
            updatedAt: obj.updated_at,
          } as MemoryEntry
        })
      }
    } catch (err) {
      log('WARN', 'memory_load_failed', { error: String(err) })
    }
  }

  addEntry(type: MemoryEntry['type'], content: string, confidence: number, options?: { tier?: MemoryEntry['tier'] }): void {
    if (confidence < MIN_CONFIDENCE) return

    // 1. 精确去重 → 强化计数 + 置信度提升
    const exactExisting = this.entries.find((e) => e.type === type && e.content === content)
    if (exactExisting) {
      exactExisting.updatedAt = Date.now()
      exactExisting.confidence = Math.max(exactExisting.confidence, confidence)
      exactExisting.reinforceCount++
      // 检查是否该晋升
      this.tryPromote(exactExisting)
      this.upsertInDb(exactExisting)
      return
    }

    // 2. 前缀模糊去重（近似内容合并）
    if (type === 'user_fact') {
      const similarIdx = this.entries.findIndex(
        (e) =>
          e.type === 'user_fact' &&
          content.length > 10 &&
          e.content.length > 10 &&
          (content.startsWith(e.content) || e.content.startsWith(content)),
      )
      if (similarIdx >= 0) {
        const existing = this.entries[similarIdx]
        existing.updatedAt = Date.now()
        existing.confidence = Math.max(existing.confidence, confidence)
        existing.reinforceCount++
        if (content.length > existing.content.length) existing.content = content
        this.tryPromote(existing)
        this.upsertInDb(existing)
        return
      }
    }

    // 3. 新建条目（初始入临时层）
    const initialTier = options?.tier ?? 'ephemeral'
    const entry: MemoryEntry = {
      id: nextId(),
      type,
      content,
      confidence,
      tier: initialTier,
      reinforceCount: initialTier === 'permanent' ? 999 : 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.entries.push(entry)
    this.upsertInDb(entry)

    // 永久层不参与 pruning
    if (initialTier !== 'permanent') this.prune()
    else if (this.entries.filter((e) => e.tier === 'permanent').length > MAX_PERMANENT) {
      this.prunePermanent()
    }

    if (type === 'user_fact') {
      this.vector.store(content, confidence, 'user_fact')
      this.knowledgeGraph.ingest(content, confidence)
    }
  }

  /** 自动晋升逻辑 */
  private tryPromote(entry: MemoryEntry): void {
    if (entry.tier === 'permanent') return // 已经是最高层

    // 临时→半永久
    if (entry.tier === 'ephemeral' && entry.confidence >= PROMOTE_SEMI_CONFIDENCE) {
      entry.tier = 'semi'
      entry.updatedAt = Date.now()
      log('INFO', 'memory_promoted_semi', { content: entry.content.slice(0, 50) })
    }

    // 半永久→永久
    if (
      entry.tier === 'semi' &&
      (entry.reinforceCount >= PROMOTE_PERMANENT_REINFORCE || entry.confidence >= PROMOTE_PERMANENT_CONFIDENCE)
    ) {
      entry.tier = 'permanent'
      entry.updatedAt = Date.now()
      this.prunePermanent()
      log('INFO', 'memory_promoted_permanent', { content: entry.content.slice(0, 50), reinforceCount: entry.reinforceCount })
    }
  }

  addFact(content: string, confidence: number = 0.6, options?: { tier?: MemoryEntry['tier'] }): void {
    this.addEntry('user_fact', content, confidence, options)
  }

  recordInteraction(): void {
    this.messageCount++
    if (this.messageCount % INTERACTION_RECORD_INTERVAL === 0) {
      this.addEntry('interaction', `进行了 ${this.messageCount} 次对话交互`, 0.6)
    }
  }

  getInteractionCount(): number {
    return this.messageCount
  }

  /** 设置最近的用户消息文本，用于 getFormattedContext 中的语义召回 */
  setLastUserText(text: string): void {
    this.lastUserText = text
  }

  getFormattedContext(): string {
    const parts: string[] = []

    // 永久层：始终显示
    const permanent = this.entries.filter((e) => e.tier === 'permanent' && e.type === 'user_fact').slice(0, MAX_PERMANENT)
    if (permanent.length > 0) {
      parts.push('【重要的记忆】')
      permanent.forEach((f) => parts.push(`- ${f.content}`))
    }

    // 半永久 + 临时层：按分数取 top 5
    const topFacts = [...this.getScoredEntries('semi'), ...this.getScoredEntries('ephemeral')]
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5)
    if (topFacts.length > 0) {
      parts.push('')
      parts.push('你记得以下关于主人的事：')
      topFacts.forEach((f) => parts.push(`- ${f.content}`))
    }

    // 语义召回：从 VectorMemory 中取与最近用户消息相关的记忆
    if (this.lastUserText) {
      const relevant = this.vector.querySync(this.lastUserText, 3)
      if (relevant.length > 0) {
        parts.push('')
        parts.push('相关的历史记忆：')
        relevant.forEach((c) => parts.push(`- ${c}`))
      }
    }

    // 对话摘要
    const summaries = this.summary.getRecent(3)
    if (summaries.length > 0) {
      parts.push('')
      parts.push('之前的对话总结：')
      summaries.forEach((s) => parts.push(`- ${s}`))
    }

    // 最近的 interaction
    const interactions = this.entries.filter((e) => e.type === 'interaction').slice(-3)
    if (interactions.length > 0) {
      parts.push('')
      parts.push('你们之前聊过：')
      interactions.forEach((i) => parts.push(`- ${i.content}`))
    }

    // 知识图谱
    const kgCtx = this.knowledgeGraph.getFormattedContext()
    if (kgCtx) {
      parts.push('')
      parts.push(kgCtx)
    }

    return parts.length > 0 ? parts.join('\n') : ''
  }

  /** 按衰减后分数排序 */
  private getScoredEntries(tier: MemoryEntry['tier']): MemoryEntry[] {
    const now = Date.now()
    const decay = tier === 'semi' ? DECAY_SEMI : DECAY_EPHEMERAL
    return this.entries
      .filter((e) => e.tier === tier && e.type === 'user_fact')
      .map((e) => ({
        entry: e,
        score: e.confidence * Math.pow(decay, (now - e.updatedAt) / (1000 * 60 * 60 * 24)),
      }))
      .sort((a, b) => b.score - a.score)
      .map((s) => s.entry)
  }

  flush(): void {
    this.flushAllToDb()
    this.summary.flush()
    this.vector.flush()
  }

  shutdown(): void {
    this.flush()
  }

  clear(): void {
    this.entries = []
    this.messageCount = 0
    log('INFO', 'memory_cleared')
  }

  getEntries(): MemoryEntry[] {
    return this.entries
  }

  // ===== Pruning =====

  private prune(): void {
    this.pruneTier('ephemeral', MAX_EPHEMERAL)
    this.pruneTier('semi', MAX_SEMI)
  }

  private pruneTier(tier: 'ephemeral' | 'semi', max: number): void {
    const tierEntries = this.entries.filter((e) => e.tier === tier)
    if (tierEntries.length <= max) return

    const now = Date.now()
    const decay = tier === 'semi' ? DECAY_SEMI : DECAY_EPHEMERAL
    const scored = tierEntries.map((e) => ({
      entry: e,
      score: e.confidence * Math.pow(decay, (now - e.updatedAt) / (1000 * 60 * 60 * 24)),
    }))
    scored.sort((a, b) => b.score - a.score)

    const keep = new Set(scored.slice(0, max).map((s) => s.entry.id))
    const toRemove = scored.slice(max)
    for (const s of toRemove) {
      const idx = this.entries.findIndex((e) => e.id === s.entry.id)
      if (idx >= 0) {
        this.removedIds.add(s.entry.id)
        this.entries.splice(idx, 1)
      }
    }
    if (toRemove.length > 0) {
      log('INFO', 'memory_pruned', { tier, removed: toRemove.length })
    }
  }

  /** 永久层超出上限时移除最弱的 */
  private prunePermanent(): void {
    const perm = this.entries.filter((e) => e.tier === 'permanent')
    if (perm.length <= MAX_PERMANENT) return
    // 按 reinforcedCount 保留
    perm.sort((a, b) => b.reinforceCount - a.reinforceCount || b.confidence - a.confidence)
    const keep = new Set(perm.slice(0, MAX_PERMANENT).map((e) => e.id))
    for (const e of perm) {
      if (!keep.has(e.id)) {
        e.tier = 'semi' // 降级到半永久，不直接删除
      }
    }
    log('INFO', 'memory_demoted_from_permanent', {
      count: perm.length - MAX_PERMANENT,
    })
  }

  // ===== 持久化 =====

  private upsertInDb(entry: MemoryEntry): void {
    try {
      const db = getRawDb()
      db.run(
        'INSERT OR REPLACE INTO memories (id, type, content, confidence, tier, reinforce_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [entry.id, entry.type, entry.content, entry.confidence, entry.tier, entry.reinforceCount, entry.createdAt, entry.updatedAt],
      )
      markDirty()
    } catch (err) {
      log('ERROR', 'memory_save_failed', { error: String(err) })
    }
  }

  private flushAllToDb(): void {
    if (this.removedIds.size === 0) return
    try {
      const db = getRawDb()
      db.run('BEGIN')
      for (const id of this.removedIds) {
        db.run('DELETE FROM memories WHERE id = ?', [id])
      }
      db.run('COMMIT')
      markDirty()
      this.removedIds.clear()
    } catch (err) {
      try {
        getRawDb().run('ROLLBACK')
      } catch {}
      log('ERROR', 'memory_flush_removed_failed', { error: String(err) })
    }
  }
}
