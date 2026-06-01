export interface MemoryEntry {
  id: string
  type: 'user_fact' | 'interaction'
  content: string
  confidence: number
  createdAt: number
  updatedAt: number
}

export interface MemoryStore {
  version: number
  updatedAt: number
  entries: MemoryEntry[]
}
