/**
 * WritingPlan — 写作计划智能编排 Agent 类型定义
 *
 * 用于设计文档解析、章节对比、任务分解、质量校验的完整类型体系。
 */

// ===== 设计文档分析 =====

/** 齿轮三角关键要素 */
export interface GearTriangleElements {
  /** 核心主题 */
  theme: string
  /** 主要角色列表及定位 */
  characters: Array<{ name: string; role: string; arc: string }>
  /** 核心冲突（人与机械、传统与现代等） */
  conflicts: string[]
  /** 工业美学要素（蒸汽、齿轮、钢铁、灯火等） */
  industrialAesthetics: string[]
  /** 叙事视角与风格 */
  narrativeStyle: string
  /** 时代背景 */
  setting: string
}

/** 章节写作指南 */
export interface ChapterGuideline {
  chapterNumber: number
  title: string
  /** 本章关键情节点 */
  keyPoints: string[]
  /** 本章必须包含的要素 */
  requiredElements: string[]
  /** 本章在齿轮三角中的定位 */
  trianglePosition?: string
}

/** 设计文档分析结果 */
export interface DesignDocAnalysis {
  storyName: string
  /** 齿轮三角核心要素 */
  gearTriangle: GearTriangleElements
  /** 各章节写作指南（如果设计文档包含章节规划） */
  chapterGuidelines: ChapterGuideline[]
  /** 整体写作风格要求 */
  styleRequirements: string[]
  /** 分析置信度 */
  confidence: number
}

// ===== 章节对比 =====

/** 差异问题严重性 */
export type IssueSeverity = 'critical' | 'major' | 'minor'

/** 差异问题 */
export interface DiffIssue {
  severity: IssueSeverity
  /** 问题分类：character_deviation | plot_inconsistency | style_mismatch | missing_element | structural */
  category: string
  /** 问题描述 */
  description: string
  /** 设计文档对应的要求 */
  guideline: string
  /** 修改建议 */
  suggestion: string
  /** 关联的齿轮三角要素 */
  relatedElement?: string
}

/** 单章差异 */
export interface ChapterDiff {
  chapterNumber: number
  chapterTitle: string
  /** 总体偏差评分 0-100（0=完全符合） */
  deviationScore: number
  /** 问题列表 */
  issues: DiffIssue[]
}

/** 章节对比结果 */
export interface ChapterCompareResult {
  storyName: string
  /** 分析的所有章节范围 */
  chapterRange: { start: number; end: number }
  /** 各章差异 */
  chapterDiffs: ChapterDiff[]
  /** 汇总统计 */
  summary: {
    totalIssues: number
    criticalCount: number
    majorCount: number
    minorCount: number
    topIssues: string[]
  }
}

// ===== 重写任务分解 =====

/** 重写阶段 */
export type RewritePhase = 'outline' | 'rewrite' | 'quality_check'

/** 重写子任务 */
export interface RewriteTask {
  id: string
  phase: RewritePhase
  title: string
  description: string
  /** 涉及章节 */
  chapterNumbers: number[]
  /** 依赖的任务 ID 列表 */
  dependencies: string[]
  /** 任务状态 */
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  /** 关联的设计文档要求 */
  relatedGuidelines: string[]
}

/** 重写计划 */
export interface RewritePlan {
  planId: string
  storyName: string
  tasks: RewriteTask[]
  createdAt: number
  updatedAt: number
  overallProgress: number // 0-100
  currentPhase: RewritePhase
  status: 'active' | 'paused' | 'completed'
}

// ===== 质量校验 =====

/** 校验维度评分 */
export interface QualityScore {
  /** 维度名：style_consistency | character_completeness | plot_coherence | atmosphere | dialogue */
  dimension: string
  score: number // 0-100
  issues: string[]
  suggestions: string[]
}

/** 质量校验报告 */
export interface QualityReport {
  chapterNumber: number
  chapterTitle: string
  scores: QualityScore[]
  /** 总体评分 0-100 */
  overallScore: number
  /** 是否通过 */
  passed: boolean
  /** 关键问题 */
  criticalIssues: string[]
  /** 通过阈值 */
  threshold: number
}

// ===== 进度记录 =====

/** 进度条目 */
export interface ProgressRecord {
  planId: string
  taskId: string
  timestamp: number
  status: string
  summary: string
  details?: string
}

/** 用户约束 */
export interface UserConstraint {
  type: 'priority' | 'skip_chapter' | 'focus_aspect' | 'custom'
  description: string
  value: string
  createdAt: number
}
