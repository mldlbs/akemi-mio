/**
 * ActionContext — 进化动作的运行时上下文
 *
 * 每个 Action.run() 在执行时会收到这个上下文，从而可以访问
 * SubAgentPool、VerificationRunner、GitOps、ExecutionTracer 等基础设施。
 *
 * 这是从"配置修正动作"到"真实改代码动作"的关键桥梁。
 */

import type { AgentService } from '../agent/AgentService'
import type { SubAgentPool } from '../agent/SubAgentPool'
import type { EvolutionGitOps } from './EvolutionGitOps'
import type { PlanManagerLike } from './types'
import type { VerificationRunner } from './VerificationRunner'
import type { EventBus } from '../core/EventBus'
import type { ExecutionTracer } from './ExecutionTracer'

export interface ActionContext {
  agentService: AgentService
  subAgentPool?: SubAgentPool
  gitOps?: EvolutionGitOps
  planManager?: PlanManagerLike
  verificationRunner?: VerificationRunner
  eventBus: EventBus
  projectRoot: string
  tracer?: ExecutionTracer
}
