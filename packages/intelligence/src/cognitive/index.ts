import { log } from '@akemi-mio/core/logger/Logger'
import { getRawDb } from '@akemi-mio/core/db/connection'
import { GoalEngine } from '@akemi-mio/intelligence/cognitive/GoalEngine'
import { StrategyEngine } from '@akemi-mio/intelligence/cognitive/StrategyEngine'
import { TokenAccount, CostEstimator } from '@akemi-mio/intelligence/cognitive/TokenEconomy'
import { Scheduler } from '@akemi-mio/core/core/Scheduler'
import { IdentityModule } from '@akemi-mio/intelligence-identity'
import { MetaCycle } from '@akemi-mio/intelligence/cognitive/MetaCycle'
import type { EngineeringMemory } from '@akemi-mio/intelligence-memory/EngineeringMemory'
import type { ProceduralMemory } from '@akemi-mio/intelligence/agent/ProceduralMemory'
import type { LlmService } from '@akemi-mio/intelligence/llm/LlmService'

export class CognitiveService {
  readonly identity: IdentityModule
  readonly goals: GoalEngine
  readonly strategies: StrategyEngine
  readonly tokenAccount: TokenAccount
  readonly costEstimator: CostEstimator
  readonly metaCycle = new MetaCycle()
  private initialized = false
  private defaultStrategies = false

  constructor() {
    this.identity = new IdentityModule()
    this.goals = new GoalEngine()
    this.strategies = new StrategyEngine()
    this.tokenAccount = new TokenAccount()
    this.costEstimator = new CostEstimator()
  }

  async initialize(
    constitutionPath?: string,
    deps?: {
      engineeringMemory?: EngineeringMemory
      proceduralMemory?: ProceduralMemory
      llmService?: LlmService
    },
  ): Promise<void> {
    if (this.initialized) return
    await this.tokenAccount.initialize()
    await this.seedDefaultGoals()
    await this.seedDefaultStrategies()
    if (constitutionPath) {
      await this.identity.initialize(constitutionPath)
    } else {
      log('INFO', 'identity_module_skipped', { reason: 'no constitution_path' })
    }
    this.initialized = true

    // 定时后台 Token 补充：每 30 分钟检查一次自动收入
    const scheduler = new Scheduler()
    scheduler.interval(30 * 60 * 1000, () => {
      this.tokenAccount.refreshAllowance()
      return ''
    })

    // 元认知循环：每周自评（deps 齐全时才启动）
    if (deps?.engineeringMemory && deps?.proceduralMemory && deps?.llmService && this.identity.getCoreIdentity()) {
      this.metaCycle.initialize({
        identity: this.identity,
        engineeringMemory: deps.engineeringMemory,
        proceduralMemory: deps.proceduralMemory,
        llmService: deps.llmService,
      })
      scheduler.interval(
        7 * 24 * 60 * 60 * 1000,
        async () => {
          await this.metaCycle.run()
          return ''
        },
        '@meta',
      )
      // 首次启动 600s 后跑一次初始评估（避免启动时 LLM 调用阻塞渲染 IPC）
      scheduler.once(
        600 * 1000,
        async () => {
          await this.metaCycle.run()
          return ''
        },
        '@meta',
      )
    } else {
      log('INFO', 'meta_cycle_skipped', {
        hasIdentity: !!this.identity.getCoreIdentity(),
        hasDeps: !!(deps?.engineeringMemory && deps?.proceduralMemory && deps?.llmService),
      })
    }

    log('INFO', 'cognitive_service_initialized', {
      activeGoals: this.goals.getActiveGoals().length,
      defaultStrategies: this.defaultStrategies,
      tokenBalance: this.tokenAccount.getBalance(),
    })
  }
  async adjustByToken(failureLogs: Array<{ task: string; error: string; timestamp: number }>): Promise<void> {
    const balance = this.tokenAccount.getBalance()
    this.goals.adjustPrioritiesByToken(balance)

    const recs = this.strategies.analyzeFailures(failureLogs)
    for (const r of recs) {
      log('WARN', 'cognitive_strategy_recommendation', { recommendation: r })
      if (r.startsWith('consecutive_failures:')) {
        const goalId = this.inferGoalFromError(r)
        if (goalId) {
          this.goals.setStatus(goalId, 'paused')
        }
      }
    }

    const stats = this.tokenAccount.getLifetimeStats()
    log('INFO', 'cognitive_token_cycle', {
      balance,
      lifetimeEarned: stats.earned,
      lifetimeSpent: stats.spent,
      recommendations: recs.length,
    })
  }

  private inferGoalFromError(recommendation: string): string | null {
    const active = this.goals.getActiveGoals().slice(0, 3)
    if (active.length === 0) return null
    const sorted = [...active].sort((a, b) => a.priority - b.priority)
    return sorted[0].id
  }

  /** 构建可注入 prompt 的认知上下文 */
  getFormattedContext(keywords?: string[]): string {
    const goalCtx = this.goals.getFormattedContext()
    const strategyCtx = this.strategies.getFormattedContext(keywords)
    const tokenCtx = this.tokenAccount.getFormattedContext()
    const identityCtx = this.identity.getFormattedContext()
    const metaCtx = this.metaCycle.getFormattedContext()
    const parts: string[] = []
    if (identityCtx) parts.push(identityCtx)
    if (goalCtx) parts.push(goalCtx)
    if (metaCtx) parts.push(metaCtx)
    if (strategyCtx) parts.push(strategyCtx)
    if (tokenCtx) parts.push(tokenCtx)
    return parts.join('\n')
  }

  private async seedDefaultGoals(): Promise<void> {
    const existing = this.goals.getActiveGoals()
    if (existing.length > 0) return

    this.goals.create({
      title: '提高任务完成率',
      description: '持续优化任务执行策略，减少失败和超时',
      priority: 10,
      status: 'active',
      category: 'long_term',
      parentGoalId: null,
    })
    this.goals.create({
      title: '优化记忆系统',
      description: '提升知识图谱和工程记忆的准确性和覆盖度',
      priority: 8,
      status: 'active',
      category: 'initiative',
      parentGoalId: null,
    })
    this.goals.create({
      title: '提升代码质量',
      description: '通过 Evolution 循环自动检测和修复代码问题',
      priority: 6,
      status: 'active',
      category: 'short_term',
      parentGoalId: null,
    })
  }

  private async seedDefaultStrategies(): Promise<void> {
    const db = getRawDb()
    const count = Number(db.exec('SELECT COUNT(*) AS c FROM strategies')[0]?.values[0]?.[0] || 0)
    if (count > 0) return

    this.strategies.create({
      name: '任务优先策略',
      description: '优先选择高收益/低消耗任务',
      promptTemplate: '评估以下任务的预期收益和 token 消耗。优先选择收益/消耗比最高的任务。',
      applicableContext: 'task_selection, token_optimization',
      priority: 10,
    })
    this.strategies.create({
      name: '失败重试策略',
      description: '指数退避重试失败步骤',
      promptTemplate: '步骤执行失败，采用指数退避重试（1s/2s/4s），最多 3 次。',
      applicableContext: 'step_execution, error_recovery',
      priority: 8,
    })
    this.strategies.create({
      name: '记忆召回策略',
      description: '优先召回高置信度、近期更新的记忆',
      promptTemplate: '从知识图谱和工程记忆中召回与当前任务最相关的记录。',
      applicableContext: 'memory_query, context_building',
      priority: 7,
    })

    this.defaultStrategies = true
  }
}
