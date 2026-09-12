/**
 * LearningToolsStore — 学习工具的内存存储
 *
 * 存储挑战题数据，使 type_challenge_submit 和 type_challenge_solution
 * 工具可以根据 challengeId 查找到对应的挑战信息。
 *
 * 为什么需要这个文件：
 * - 挑战题一次性生成后，可能在多轮对话后才提交答案
 * - 需要在工具调用之间保持挑战数据的访问
 * - 使用内存 Map 简化实现（不持久化）
 */

interface StoredChallenge {
  challengeId: string
  conceptName: string
  starterCode: string
  verifierCode: string
  solution: string
  explanation: string
  hint: string
  label: string
  createdAt: number
}

class ChallengeStore {
  private store = new Map<string, StoredChallenge>()

  /** 默认保留时间：30 分钟 */
  private maxAgeMs = 30 * 60 * 1000

  /** 最多保留最近 100 个挑战 */
  private maxItems = 100

  set(challenge: StoredChallenge): void {
    // 清理过期项
    this.prune()

    // 如果超过上限，删除最早的
    if (this.store.size >= this.maxItems) {
      const oldest = [...this.store.entries()].sort(([, a], [, b]) => a.createdAt - b.createdAt)[0]
      if (oldest) this.store.delete(oldest[0])
    }

    this.store.set(challenge.challengeId, challenge)
  }

  get(challengeId: string): StoredChallenge | undefined {
    const entry = this.store.get(challengeId)
    if (!entry) return undefined

    // 检查是否过期
    if (Date.now() - entry.createdAt > this.maxAgeMs) {
      this.store.delete(challengeId)
      return undefined
    }

    return entry
  }

  delete(challengeId: string): boolean {
    return this.store.delete(challengeId)
  }

  size(): number {
    return this.store.size
  }

  private prune(): void {
    const now = Date.now()
    for (const [id, entry] of this.store) {
      if (now - entry.createdAt > this.maxAgeMs) {
        this.store.delete(id)
      }
    }
  }
}

export const challengeStore = new ChallengeStore()
