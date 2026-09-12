/**
 * TypeHealthIssue — 类型健康度问题类型定义
 *
 * 描述代码库中检测到的类型相关问题，支持按学习分类归类，
 * 用于连接学习系统（当前学习计划）与进化系统的自动重构。
 */

import type { LearningCategory } from '@akemi-mio/intelligence-learning/types'

// ══════════════════════════════════════════
//  问题分类
// ══════════════════════════════════════════

/** 类型健康问题分类 */
export type TypeHealthCategory =
  | 'explicit_any' // 显式 any 类型
  | 'as_any' // as any 断言
  | 'unsafe_assertion' // 不安全类型断言 (as T)
  | 'missing_return_type' // 函数缺少返回类型
  | 'missing_param_type' // 参数缺少类型
  | 'any_array' // any[] / Array<any>
  | 'ts_ignore' // @ts-ignore 压制
  | 'generic_opportunity' // 可用泛型替代 any
  | 'conditional_opportunity' // 可用条件类型简化重载
  | 'type_guard_opportunity' // 可用类型守卫替代 as

/** 问题严重程度 */
export type TypeHealthSeverity = 'error' | 'warning' | 'info' | 'suggestion'

// ══════════════════════════════════════════
//  扫描结果
// ══════════════════════════════════════════

/** 单个类型健康问题 */
export interface TypeHealthIssue {
  /** 唯一标识 */
  id: string
  /** 问题分类 */
  category: TypeHealthCategory
  /** 所属学习分类（用于匹配当前学习计划） */
  learningCategory: LearningCategory | null
  /** 严重程度 */
  severity: TypeHealthSeverity
  /** 文件路径（相对项目根） */
  file: string
  /** 行号 */
  line: number
  /** 列号 */
  column?: number
  /** 问题简述 */
  title: string
  /** 详细描述 */
  description: string
  /** 源代码片段（上下文行） */
  snippet: string
  /** 重构建议 */
  suggestion: string
  /** 预估修改字符数（用于排期） */
  estimatedChars: number
  /** 检测时间戳 */
  detectedAt: number
}

/** 类型扫描配置 */
export interface TypeHealthScanConfig {
  /** 项目根目录 */
  projectRoot: string
  /** 包含模式（glob） */
  includePatterns: string[]
  /** 排除模式（glob） */
  excludePatterns: string[]
  /** 是否包含 node_modules */
  includeNodeModules: boolean
  /** 匹配的学习分类（为空则扫描全部） */
  targetCategories: LearningCategory[]
  /** 最低严重级别 */
  minSeverity: TypeHealthSeverity
}

/** 扫描统计摘要 */
export interface TypeHealthSummary {
  totalIssues: number
  byCategory: Record<TypeHealthCategory, number>
  bySeverity: Record<TypeHealthSeverity, number>
  byFile: Array<{ file: string; count: number }>
  scanDurationMs: number
  scannedFiles: number
  scannedAt: number
}

// ══════════════════════════════════════════
//  默认配置
// ══════════════════════════════════════════

export const DEFAULT_SCAN_CONFIG: TypeHealthScanConfig = {
  projectRoot: '',
  includePatterns: ['src/**/*.ts', 'src/**/*.tsx'],
  excludePatterns: ['**/node_modules/**', '**/dist/**', '**/out/**', '**/*.d.ts'],
  includeNodeModules: false,
  targetCategories: [],
  minSeverity: 'suggestion',
}

// ══════════════════════════════════════════
//  LearningCategory ↔ TypeHealthCategory 映射
// ══════════════════════════════════════════

/**
 * 学习分类 → 类型健康问题分类的映射。
 * 不同学习阶段关注不同类型的问题。
 */
export const LEARNING_TO_HEALTH_MAP: Partial<Record<LearningCategory, TypeHealthCategory[]>> = {
  泛型: ['explicit_any', 'as_any', 'generic_opportunity', 'any_array'],
  条件类型: ['conditional_opportunity', 'unsafe_assertion'],
  类型守卫: ['type_guard_opportunity', 'unsafe_assertion', 'as_any'],
  映射类型: ['missing_return_type', 'missing_param_type'],
  基础类型: ['explicit_any', 'missing_param_type', 'missing_return_type'],
  工具类型: ['explicit_any', 'any_array'],
  类型推断: ['explicit_any', 'as_any'],
}

/**
 * 获取给定学习分类关注的类型健康问题分类列表。
 */
export function getTargetCategories(learningCategories: LearningCategory[]): TypeHealthCategory[] {
  const target = new Set<TypeHealthCategory>()
  for (const lc of learningCategories) {
    const mapped = LEARNING_TO_HEALTH_MAP[lc]
    if (mapped) {
      for (const c of mapped) target.add(c)
    }
  }
  return Array.from(target)
}
