import { rt, type RuntimeEventBus } from './runtime'
import type { ResourceBudget } from './ResourceBudget'

/**
 * BudgetRebalancer — 预算再平衡器。
 *
 * 监听 budget.exhausted 事件，在 pool 之间动态调配预算。
 * 当某个 pool 耗尽时，从其他有富余的 pool 借调配额。
 * 带防抖机制避免频繁调整。
 */
export class BudgetRebalancer {
  private resourceBudget: ResourceBudget
  private lastRebalance = 0
  private readonly DEBOUNCE_MS = 60_000
  private readonly STEAL_AMOUNT = 5
  private unsubscribers: (() => void)[] = []

  private readonly originalMaxChat: number
  private readonly originalMaxEvolution: number

  constructor(resourceBudget: ResourceBudget, bus?: RuntimeEventBus) {
    this.resourceBudget = resourceBudget
    const config = resourceBudget.getConfig()
    this.originalMaxChat = config.maxChatLlmCalls
    this.originalMaxEvolution = config.maxEvolutionLlmCalls
    this.start(bus)
  }

  private start(bus?: RuntimeEventBus): void {
    const eb = bus || rt.bus
    this.unsubscribers.push(
      eb.on('budget.exhausted', (p) => {
        this.handleExhausted((p as { resource: string }).resource)
      }),
    )
    rt.logger('INFO', 'budget_rebalancer_started', {
      originalMaxChat: this.originalMaxChat,
      originalMaxEvolution: this.originalMaxEvolution,
    })
  }

  stop(): void {
    for (const unsub of this.unsubscribers) {
      try {
        unsub()
      } catch {}
    }
    this.unsubscribers = []
  }

  private handleExhausted(resource: string): void {
    const now = Date.now()

    // Process budget exhaustion: log only (no cross-pool rebalancing)
    if (resource.startsWith('process.')) {
      rt.logger('WARN', 'budget_rebalance_process', { resource })
      return
    }

    if (now - this.lastRebalance < this.DEBOUNCE_MS) return
    this.lastRebalance = now

    const config = this.resourceBudget.getConfig()

    if (resource === 'llm.evolution') {
      const newChat = Math.max(config.maxChatLlmCalls - this.STEAL_AMOUNT, this.originalMaxChat * 0.3)
      const newEvo = Math.min(config.maxEvolutionLlmCalls + this.STEAL_AMOUNT, this.originalMaxEvolution + 30)
      this.resourceBudget.updateConfig({
        maxChatLlmCalls: newChat,
        maxEvolutionLlmCalls: newEvo,
      })
      rt.logger('INFO', 'budget_rebalanced', {
        reason: 'evolution_exhausted',
        chat_adjust: `${config.maxChatLlmCalls} → ${newChat}`,
        evolution_adjust: `${config.maxEvolutionLlmCalls} → ${newEvo}`,
      })
    } else if (resource === 'llm.chat') {
      const newEvo = Math.max(config.maxEvolutionLlmCalls - this.STEAL_AMOUNT, this.originalMaxEvolution * 0.3)
      const newChat = Math.min(config.maxChatLlmCalls + this.STEAL_AMOUNT, this.originalMaxChat + 50)
      this.resourceBudget.updateConfig({
        maxEvolutionLlmCalls: newEvo,
        maxChatLlmCalls: newChat,
      })
      rt.logger('INFO', 'budget_rebalanced', {
        reason: 'chat_exhausted',
        evolution_adjust: `${config.maxEvolutionLlmCalls} → ${newEvo}`,
        chat_adjust: `${config.maxChatLlmCalls} → ${newChat}`,
      })
    }
  }
}
