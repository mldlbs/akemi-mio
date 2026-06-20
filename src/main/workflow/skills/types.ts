export interface SkillPhase {
  name: string
  description: string
  /** 该阶段的 prompt 注入，为空时走 promptModule */
  promptModule?: string
  /** 是否需要子 agent 执行 */
  requiresSubagent?: boolean
}

export interface SkillRationalization {
  excuse: string
  reality: string
}

export interface SkillChecklistItem {
  label: string
  description: string
  required: boolean
}

export interface SkillCrossReference {
  name: string
  type: 'required' | 'recommended' | 'optional'
  description: string
}

export interface SkillDef {
  /** 唯一标识 */
  name: string
  /** 触发条件描述 — agent 看到它就知道什么时候用 */
  description: string
  /** 所属复杂度 tiers，null = standalone 技能 */
  tiers: ('simple' | 'medium' | 'large')[] | null
  /** true = pipeline 阶段角色，false = standalone 技能 */
  isStage: boolean
  /** 注入 system prompt 的约束文本 */
  promptModule: string
  /** 禁止行为 */
  antiPatterns: string[]

  // ✨ 增强字段
  /** 铁律 — 不可违反的核心规则 */
  ironLaw?: string
  /** 红线标志 — 看到这些信号立即 STOP */
  redFlags?: string[]
  /** 用户/agent 常见借口 → 现实对照表 */
  rationalizations?: SkillRationalization[]
  /** 执行 checklist */
  checklist?: SkillChecklistItem[]
  /** 依赖/引用的其他 skill */
  requires?: SkillCrossReference[]
  recommends?: SkillCrossReference[]
  /** 执行阶段（pipeline skill 的时序阶段定义） */
  phases?: SkillPhase[]
}

export const STAGE_ORDER: string[] = ['architect', 'planner', 'developer', 'tester', 'reviewer']

export const TIER_STAGES: Record<string, string[]> = {
  simple: ['developer', 'tester'],
  medium: ['planner', 'developer', 'tester', 'reviewer'],
  large: ['architect', 'planner', 'developer', 'tester', 'reviewer'],
}
