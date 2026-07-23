/**
 * Anti-Memory 模块 — Memory ↔ Plan 关系反转分析 & 原型
 *
 * 【背景】
 * 当前 Memory（src/main/memory/）和 Plan（src/main/pipeline/stages/PlanParallelAdvancementStage.ts）
 * 之间默认存在以下假设前提：
 *
 *   A1 [主从关系] Memory 是主（上下文来源），Plan 是从（执行者）
 *   A2 [执行顺序] Memory 先加载上下文 → Plan 后执行
 *   A3 [决策权] Memory 决定重要性 → Plan 遵循此优先级
 *   A4 [范围控制] Memory 存储全部 → Plan 从中过滤
 *   A5 [生命周期] Memory 长期累积 → Plan 短期任务
 *
 * 【反转方向】
 *   本模块实现了 A1+A3 的反转原型：Plan 主动指令 → Memory 按计划优先级重新排序。
 *   详细分析见 getAntiMemoryAssumptions()。
 *
 * 【与 anti-mcp 模块的关系】
 *   anti-mcp 反转的是 MCP↔Plan 关系（工具调度层面）
 *   anti-memory 反转的是 Memory↔Plan 关系（信息优先级层面）
 *   两者构成互补：Plan 在工具调用层面获得主导权（anti-mcp），
 *   在信息输入层面也获得主导权（anti-memory）。
 *
 * 【使用示例】
 *   import { planMemoryDirector, getAntiMemoryAssumptions } from './anti-memory'
 *
 *   // 查看所有假设反转分析
 *   const inversions = getAntiMemoryAssumptions()
 *
 *   // Plan 同步执行范围到 Memory
 *   planMemoryDirector.syncPlanScope({
 *     activeDomains: ['radar_merge', 'songge_backup', 'blog_analysis'],
 *     domainTopics: { ... },
 *     highValueKeywords: ['startup', 'AI'],
 *     lastPlanRunAt: Date.now(),
 *     directives: [],
 *   })
 *
 *   // 获取受 Plan 驱动的上下文（替代 MemoryService.getFormattedContext）
 *   const planCtx = planMemoryDirector.getFormattedPlanDrivenContext()
 */

export { PlanMemoryDirector, planMemoryDirector } from './PlanMemoryDirector'
export { getAntiMemoryAssumptions } from './PlanMemoryDirector'

export type {
  AssumptionInversion,
  PlanDomain,
  MemoryDirective,
  MemoryDirectiveAction,
  PlanScopeSnapshot,
  PlanDrivenMemoryContext,
  PlanMemoryDirectorConfig,
} from './types'
export { DEFAULT_DIRECTOR_CONFIG } from './types'
