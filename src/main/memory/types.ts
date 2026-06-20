export interface MemoryEntry {
  id: string
  type: 'user_fact' | 'interaction'
  content: string
  confidence: number
  createdAt: number
  updatedAt: number
  /** 记忆层级：permanent=永不移除 | semi=半永久慢衰减 | ephemeral=临时 */
  tier: 'permanent' | 'semi' | 'ephemeral'
  /** 强化次数（用于自动晋升） */
  reinforceCount: number
}

export interface MemoryStore {
  version: number
  updatedAt: number
  entries: MemoryEntry[]
}

export interface SummaryEntry {
  id: string
  summary: string
  turnStart: number
  turnEnd: number
  createdAt: number
}

export interface VectorEntry {
  id: string
  content: string
  embedding: number[]
  confidence: number
  source: 'user_fact' | 'summary'
  createdAt: number
  updatedAt: number
}
