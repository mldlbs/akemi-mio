/**
 * GoalEngineAdapter — 将 GoalEngine 适配为 ReadableStore + WritableStore
 *
 * 映射关系：
 * - search  ←  getActiveGoals（按类别/状态过滤）
 * - getContext  ←  getFormattedContext
 * - store  ←  create
 * - delete  ←  setStatus('abandoned')
 */
import type { GoalEngine, GoalInput } from '../../cognitive/GoalEngine'
import type { ReadableStore, WritableStore, StoreType, SearchOptions, SearchResult, WriteInput, WriteResult } from '../types'

export class GoalEngineAdapter implements WritableStore {
  readonly name = 'goal_engine'
  readonly type: StoreType = 'cognitive'

  constructor(private engine: GoalEngine) {}

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const queryLower = query.toLowerCase()
    const category = options?.filter?.category as string | undefined

    const goals = this.engine.getActiveGoals(category as any)
    const results: SearchResult[] = goals
      .filter((g) => {
        if (!queryLower) return true
        return (
          g.title.toLowerCase().includes(queryLower) ||
          g.description.toLowerCase().includes(queryLower)
        )
      })
      .map((g) => ({
        id: g.id,
        content: `[${g.category}] ${g.title}: ${g.description} (${g.progress}%, 优先级 ${g.priority})`,
        score: g.priority / 10,
        source: this.name,
        sourceType: this.type,
        metadata: {
          title: g.title,
          description: g.description,
          priority: g.priority,
          status: g.status,
          category: g.category,
          progress: g.progress,
          parentGoalId: g.parentGoalId,
        },
        timestamp: g.updatedAt,
      }))

    if (options?.topK) {
      return results.slice(0, options.topK)
    }

    return results
  }

  async getContext(_keywords?: string[]): Promise<string> {
    return this.engine.getFormattedContext()
  }

  async store(input: WriteInput): Promise<WriteResult> {
    const metadata = input.metadata || {}
    const goal = this.engine.create({
      title: input.content.slice(0, 100),
      description: input.content,
      priority: (metadata.priority as number) || 5,
      status: 'active',
      category: (metadata.category as GoalInput['category']) || 'short_term',
      parentGoalId: (metadata.parentGoalId as string) || null,
    })

    return { success: true, id: goal.id }
  }

  async delete(id: string): Promise<boolean> {
    const goal = this.engine.getGoal(id)
    if (!goal) return false
    this.engine.setStatus(id, 'abandoned')
    return true
  }

  getStats(): Record<string, unknown> {
    const all = this.engine.getActiveGoals()
    return {
      totalActive: all.length,
      byCategory: all.reduce(
        (acc, g) => {
          acc[g.category] = (acc[g.category] || 0) + 1
          return acc
        },
        {} as Record<string, number>,
      ),
    }
  }
}
