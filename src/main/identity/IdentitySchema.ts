/**
 * IdentityModule 类型定义
 *
 * CoreIdentity — 从 CONSTITUTION.md 冷启动解析的不可变核心自我认知
 * EvolvedTrait — 运行时观测到的可进化特质（随交互积累更新）
 * GrowthMetrics — 运行统计数据，用于驱动 trait 演化
 */

// ───── CoreIdentity ─────

export interface CoreIdentity {
  constitutionHash: string
  name: string
  role: string
  personality: string[]
  capabilities: string[]
  constraints: string[]
  createdAt: number
  updatedAt: number
}

// ───── EvolvedTrait ─────

export type TraitTrend = 'growing' | 'stable' | 'declining'

export interface EvolvedTrait {
  name: string
  value: number // 0-1
  trend: TraitTrend
  sampleCount: number
  updatedAt: number
}

export const DEFAULT_TRAITS: EvolvedTrait[] = [
  { name: 'goal_alignment', value: 0.7, trend: 'stable', sampleCount: 0, updatedAt: Date.now() },
  { name: 'tool_efficiency', value: 0.6, trend: 'stable', sampleCount: 0, updatedAt: Date.now() },
  { name: 'response_quality', value: 0.7, trend: 'stable', sampleCount: 0, updatedAt: Date.now() },
]

// ───── GrowthMetrics ─────

export interface GrowthMetrics {
  sessionsCompleted: number
  toolsUsed: number
  goalsCompleted: number
  goalsDrifted: number
  avgScore: number
  constitutionChecksum: string
  lastUpdated: number
}

// ───── SessionType ─────

export type SessionType = 'chat' | 'development' | 'evolution' | 'maintenance'

// ───── TraitUpdateInput ─────

export interface TraitUpdateInput {
  /** 本次成功/失败的绝对值（0-1） */
  score: number
  /** 更新原因标签 */
  reason: string
  /** 工具名或目标类别（可选） */
  context?: string
}

// ───── Row mapping helpers ─────

export function rowToCoreIdentity(row: Record<string, any>): CoreIdentity {
  return {
    constitutionHash: row.constitution_hash,
    name: row.name,
    role: row.role,
    personality: safeJsonParse(row.personality, []),
    capabilities: safeJsonParse(row.capabilities, []),
    constraints: safeJsonParse(row.constraints, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function rowToEvolvedTrait(row: Record<string, any>): EvolvedTrait {
  return {
    name: row.name,
    value: row.value,
    trend: row.trend,
    sampleCount: row.sample_count,
    updatedAt: row.updated_at,
  }
}

export function rowToGrowthMetrics(row: Record<string, any>): GrowthMetrics {
  return {
    sessionsCompleted: row.sessions_completed,
    toolsUsed: row.tools_used,
    goalsCompleted: row.goals_completed,
    goalsDrifted: row.goals_drifted,
    avgScore: row.avg_score,
    constitutionChecksum: row.constitution_checksum,
    lastUpdated: row.last_updated,
  }
}

function safeJsonParse(val: string, fallback: any): any {
  try {
    return JSON.parse(val)
  } catch {
    return fallback
  }
}
