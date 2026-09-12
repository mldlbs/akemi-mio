/** 执行级目标状态。与 cognitive.GoalEngine 的 mission 级 status 相互独立。 */
export type ExecutionGoalStatus = 'planning' | 'executing' | 'blocked' | 'completed' | 'abandoned'

/** 单条执行证据：由工具执行结果结构化而来，供 GoalEvaluator 判定完成。 */
export interface Evidence {
  /** 证据类型：test_result | file_changed | command_success | artifact_created | ... */
  type: string
  /** 证据值，如 test_result 的 'passed' */
  value: string
  /** 产生证据的工具名 */
  tool: string
  /** toolLoop 轮次 */
  step: number
  /** 工具调用是否成功 */
  success: boolean
  /** 可选补充说明 */
  detail?: string
  createdAt: number
}

/** 执行级目标：一次用户请求的 objective + successCriteria + plan 绑定 + evidence。 */
export interface ExecutionGoal {
  id: string
  sessionId: string | null
  objective: string
  /** 什么算完成（供 GoalEvaluator 判定） */
  successCriteria: string[]
  status: ExecutionGoalStatus
  /** 关联 evolution plans.id（可选，复用现有 DevPlan 作为任务步骤） */
  planId: string | null
  /** M6.2 选中的方法论 id；null 表示未绑定 */
  methodology: string | null
  /** 当前推进到的 plan step（0-based） */
  currentStep: number
  /** 已收集的结构化证据（append-only） */
  evidence: Evidence[]
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

/** 执行目标完成率统计（供 Evolution / 仪表盘分析真实完成率） */
export interface ExecutionGoalStats {
  total: number
  /** planning + executing */
  active: number
  blocked: number
  completed: number
  abandoned: number
  /** completed / (completed + blocked + abandoned)，无已终结目标时为 0 */
  completionRate: number
}

/** 按 methodology 分组的完成率统计（供 Evolution 分析哪种方法论更有效） */
export interface ExecutionGoalMethodologyStat {
  methodology: string | null
  total: number
  completed: number
  blocked: number
  abandoned: number
  completionRate: number
}

/** 创建 ExecutionGoal 所需字段；id/status/currentStep/evidence/时间戳由 store 生成。 */
export interface ExecutionGoalInput {
  sessionId: string | null
  objective: string
  successCriteria: string[]
  planId?: string | null
  methodology?: string | null
}
