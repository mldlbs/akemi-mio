/**
 * Anti-MCP 模块 — Plan 驱动执行器
 *
 * 反转 MCP↔Plan 的默认关系：
 * - 传统：MCP 主 → Plan 从（Plan 是被动数据）
 * - 反转：Plan 主 → MCP 从（Plan 是主动编排器）
 *
 * 模块组成：
 * - types.ts — 反 MCP 类型定义
 * - PlanDrivenOrchestrator.ts — 核心 Plan 驱动执行引擎
 * - WritingPlanAdapter.ts — 写作计划适配器（修正工业颂歌19-27章）
 */

export {
  PlanDrivenOrchestrator,
  planDrivenOrchestrator,
  getPlanDrivenOrchestrator,
  getAssumptionInversions,
} from './PlanDrivenOrchestrator'

export {
  WritingPlanAdapter,
  writingPlanAdapter,
  getWritingPlanAdapter,
} from './WritingPlanAdapter'

export type {
  PlanDrivenStep,
  ExecutionContext,
  ExecutionLogEntry,
  PlanDrivenReport,
  ToolCallBridge,
  AssumptionInversion,
  StepEvaluation,
  StepTransition,
} from './types'
