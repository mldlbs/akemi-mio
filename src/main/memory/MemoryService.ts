import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { log } from '../logger/Logger'
import type { MemoryEntry, MemoryStore } from './types'

const MEMORY_VERSION = 1
const MAX_ENTRIES = 20
const MIN_CONFIDENCE = 0.5

let idCounter = 0
function nextId(): string {
  return `mem_${Date.now()}_${++idCounter}`
}

function loadStore(filePath: string): MemoryStore {
  try {
    if (!existsSync(filePath)) return { version: MEMORY_VERSION, updatedAt: Date.now(), entries: [] }
    const raw = readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as MemoryStore
  } catch (err) {
    log('WARN', 'memory_load_failed', { error: String(err) })
    return { version: MEMORY_VERSION, updatedAt: Date.now(), entries: [] }
  }
}

function writeStore(filePath: string, store: MemoryStore): void {
  try {
    const dir = dirname(filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    store.updatedAt = Date.now()
    writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf-8')
    log('INFO', 'memory_saved', { entries: store.entries.length })
  } catch (err) {
    log('ERROR', 'memory_save_failed', { error: String(err) })
  }
}

export class MemoryService {
  private store: MemoryStore
  private filePath: string
  private messageCount: number = 0
  private messagesSinceFlush: number = 0
  private dirty: boolean = false

  static readonly FLUSH_INTERVAL_MS = 10 * 60 * 1000
  private lastFlushTime: number = Date.now()

  constructor(filePath: string) {
    this.filePath = filePath
    this.store = loadStore(filePath)
    log('INFO', 'memory_loaded', { entries: this.store.entries.length })
  }

  addEntry(type: MemoryEntry['type'], content: string, confidence: number): void {
    if (confidence < MIN_CONFIDENCE) return

    const existing = this.store.entries.find(e => e.type === type && e.content === content)
    if (existing) {
      existing.updatedAt = Date.now()
      existing.confidence = Math.max(existing.confidence, confidence)
    } else {
      const entry: MemoryEntry = {
        id: nextId(),
        type,
        content,
        confidence,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      this.store.entries.push(entry)
    }

    this.prune()
    this.dirty = true
    log('INFO', 'memory_added', { type, content })
  }

  addFact(content: string, confidence: number = 0.6): void {
    this.addEntry('user_fact', content, confidence)
  }

  recordInteraction(): void {
    this.messageCount++
    this.messagesSinceFlush++
  }

  getInteractionCount(): number {
    return this.messageCount
  }

  getFormattedContext(): string {
    const facts = this.store.entries.filter(e => e.type === 'user_fact').slice(-5)
    const interactions = this.store.entries.filter(e => e.type === 'interaction').slice(-3)

    const parts: string[] = []
    if (facts.length > 0) {
      parts.push('你记得以下关于主人的事：')
      facts.forEach(f => parts.push(`- ${f.content}`))
    }
    if (interactions.length > 0) {
      parts.push('你们之前聊过：')
      interactions.forEach(i => parts.push(`- ${i.content}`))
    }
    return parts.length > 0 ? parts.join('\n') : ''
  }

  flush(): void {
    if (!this.dirty) return
    writeStore(this.filePath, this.store)
    this.dirty = false
    this.lastFlushTime = Date.now()
    this.messagesSinceFlush = 0
  }

  clear(): void {
    this.store = { version: MEMORY_VERSION, updatedAt: Date.now(), entries: [] }
    this.dirty = true
    this.messageCount = 0
    log('INFO', 'memory_cleared')
  }

  getEntries(): MemoryEntry[] {
    return [...this.store.entries]
  }

  private prune(): void {
    this.store.entries.sort((a, b) => b.confidence - a.confidence || b.updatedAt - a.updatedAt)
    if (this.store.entries.length > MAX_ENTRIES) {
      this.store.entries = this.store.entries.slice(0, MAX_ENTRIES)
    }
  }
}
