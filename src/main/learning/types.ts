/**
 * learning/types.ts — 学习系统通用类型定义
 *
 * 从 ASR 子系统（AsrHotwordManager / AsrLogStore / AsrEvolutionManager）中
 * 抽象出的核心数据类型的通用化版本，用于 Plan:TypeScript 学习计划执行链路。
 *
 * 对应关系：
 * - HotwordEntry → LearningItem（已学/已见的知识点）
 * - AsrErrorPattern → LearningDifficulty（学习难点分类）
 * - AsrEvalSnapshot → LearningEvalSnapshot（进度评估快照）
 * - VoiceEmotionLabel → 暂不映射（情感是 ASR 特有概念）
 * - AsrConversationContext → LearningFocusContext（上下文关注焦点）
 */

// ══════════════════════════════════════════
//  难度与掌握度
// ══════════════════════════════════════════

/** 知识点难度等级 */
export type ConceptDifficulty = 'easy' | 'medium' | 'hard'

/** 掌握度 0–1，0=完全未掌握，1=完全掌握 */
export type MasteryLevel = number

// ══════════════════════════════════════════
//  学习项（知识点）
// ══════════════════════════════════════════

/**
 * LearningItem — 一个学习项（知识点/概念）
 *
 * 对应 AsrHotwordManager 中的 HotwordEntry，但以「学习」语义重新建模。
 * 记录一个知识点被复习/遇到的次数、掌握度、分类等信息。
 */
export interface LearningItem {
  /** 知识点唯一标识（如条件类型的规范化名称） */
  id: string
  /** 知识点名称（如 "Conditional Types", "Mapped Types"） */
  name: string
  /** 所属分类（如 "泛型", "条件类型", "工具类型"） */
  category: LearningCategory
  /** 难度等级 */
  difficulty: ConceptDifficulty
  /** 当前掌握度 0–1 */
  mastery: MasteryLevel
  /** 遇到的次数（复习次数） */
  encounterCount: number
  /** 练习/测验正确次数 */
  correctCount: number
  /** 练习/测验总次数 */
  totalAttempts: number
  /** 首次遇到时间 */
  firstSeenAt: number
  /** 最近一次遇到时间 */
  lastSeenAt: number
  /** 上次练习结果 (true=正确) */
  lastAttemptCorrect?: boolean
  /** 自定义标签 */
  tags: string[]
}

/** 学习分类标签（对应 AsrHotwordManager 的 DomainLabel） */
export type LearningCategory =
  | '基础类型'
  | '泛型'
  | '条件类型'
  | '映射类型'
  | '模板字面量类型'
  | '工具类型'
  | '类型守卫'
  | '类型推断'
  | '声明文件'
  | '模块'
  | '其他'

// ══════════════════════════════════════════
//  学习进度
// ══════════════════════════════════════════

/** 整体学习进度摘要 */
export interface LearningProgress {
  /** 总知识点数 */
  totalItems: number
  /** 已掌握（mastery >= 0.8）的知识点数 */
  masteredCount: number
  /** 学习中（0.2 <= mastery < 0.8）的知识点数 */
  learningCount: number
  /** 未开始（mastery < 0.2）的知识点数 */
  notStartedCount: number
  /** 总体掌握率 */
  overallMastery: number
  /** 总练习次数 */
  totalAttempts: number
  /** 总正确次数 */
  totalCorrect: number
  /** 总体正确率 */
  overallAccuracy: number
  /** 各分类的掌握度摘要 */
  categorySummary: Array<{
    category: LearningCategory
    count: number
    avgMastery: number
  }>
}

// ══════════════════════════════════════════
//  学习难点（对应 AsrErrorPattern）
// ══════════════════════════════════════════

/** 学习难点分类（对应 AsrErrorPattern.category） */
export type DifficultyCategory =
  | 'concept_misunderstanding' // 概念理解错误
  | 'syntax_error'             // 语法错误
  | 'type_mismatch'            // 类型不匹配
  | 'generic_bound'            // 泛型约束问题
  | 'conditional_logic'        // 条件类型逻辑错误
  | 'mapped_transform'         // 映射类型转换错误
  | 'inference_failure'        // 类型推断失败
  | 'unknown'

/**
 * LearningDifficulty — 学习过程中遇到的困难/错误模式
 *
 * 对应 AsrLogStore 的 AsrErrorPattern，但以学习语境重新建模。
 */
export interface LearningDifficulty {
  /** 关联知识点 ID */
  conceptId: string
  /** 知识点名称 */
  conceptName: string
  /** 错误描述 */
  description: string
  /** 错误分类 */
  category: DifficultyCategory
  /** 出现次数 */
  frequency: number
  /** 最近出现时间 */
  lastSeen: number
}

// ══════════════════════════════════════════
//  评估快照（对应 AsrEvalSnapshot）
// ══════════════════════════════════════════

/**
 * LearningEvalSnapshot — 学习进度评估快照
 *
 * 对应 AsrLogStore 的 AsrEvalSnapshot。
 * 在学习策略变更前拍下基线，变更后评估效果，决定 keep/rollback。
 */
export interface LearningEvalSnapshot {
  id: string
  timestamp: number
  /** 拍快照前的总体掌握率 */
  beforeMastery: number
  /** 拍快照前正确率 */
  beforeAccuracy: number
  /** 拍快照后总体掌握率 */
  afterMastery?: number
  /** 拍快照后正确率 */
  afterAccuracy?: number
  /** 快照时已应用的学习策略变更描述 */
  appliedChanges: string[]
  /** 评估状态 */
  status: 'pending' | 'kept' | 'rolled_back'
}

// ══════════════════════════════════════════
//  学习关注上下文（对应 AsrConversationContext）
// ══════════════════════════════════════════

/**
 * LearningFocusContext — 当前学习关注焦点上下文
 *
 * 对应 AsrConversationContext。
 * 用于动态调整学习计划的关注领域和优先级。
 */
export interface LearningFocusContext {
  /** 近期关注的分类（如 ["条件类型", "映射类型"]） */
  focusCategories: LearningCategory[]
  /** 近期遇到的知识点 */
  recentConcepts: string[]
  /** 最近一次学习交互的文本 */
  recentInteractionText?: string
  /** 当前计划步骤信息 */
  currentStepDescription?: string
}

// ══════════════════════════════════════════
//  TypeScript 知识点预定义清单
// ══════════════════════════════════════════

/**
 * TypeScript 高级类型知识点预定义项，用于初始化学习词表。
 * 对应 ASR_HOTWORDS 静态热词配置的语义等价物。
 */
export const TYPESCRIPT_LEARNING_ITEMS: Array<{
  name: string
  category: LearningCategory
  difficulty: ConceptDifficulty
  tags: string[]
}> = [
  // 基础类型
  { name: 'Union Types', category: '基础类型', difficulty: 'easy', tags: ['union', '|'] },
  { name: 'Intersection Types', category: '基础类型', difficulty: 'easy', tags: ['intersection', '&'] },
  { name: 'Type Aliases', category: '基础类型', difficulty: 'easy', tags: ['type', 'alias'] },
  { name: 'Literal Types', category: '基础类型', difficulty: 'easy', tags: ['literal', 'const'] },
  { name: 'Nullable Types', category: '基础类型', difficulty: 'easy', tags: ['null', 'undefined', 'optional'] },

  // 泛型
  { name: 'Generic Functions', category: '泛型', difficulty: 'medium', tags: ['generic', '<T>', 'type parameter'] },
  { name: 'Generic Constraints', category: '泛型', difficulty: 'medium', tags: ['extends', 'constraint', 'bound'] },
  { name: 'Generic Interfaces', category: '泛型', difficulty: 'medium', tags: ['interface', 'generic'] },
  { name: 'Generic Classes', category: '泛型', difficulty: 'medium', tags: ['class', 'generic'] },
  { name: 'Type Parameter Defaults', category: '泛型', difficulty: 'medium', tags: ['default', '='] },
  { name: 'Multiple Type Parameters', category: '泛型', difficulty: 'medium', tags: ['multiple', '<T, U>'] },

  // 条件类型
  { name: 'Conditional Types', category: '条件类型', difficulty: 'hard', tags: ['extends', '?', ':', 'conditional'] },
  { name: 'Distributive Conditional Types', category: '条件类型', difficulty: 'hard', tags: ['distribute', 'union', 'conditional'] },
  { name: 'Infer Keyword', category: '条件类型', difficulty: 'hard', tags: ['infer', 'pattern match', 'conditional'] },
  { name: 'Nested Conditional Types', category: '条件类型', difficulty: 'hard', tags: ['nested', 'conditional'] },

  // 映射类型
  { name: 'Mapped Types', category: '映射类型', difficulty: 'hard', tags: ['in', 'keyof', 'mapped', 'P in K'] },
  { name: 'Key Remapping', category: '映射类型', difficulty: 'hard', tags: ['as', 'remap', 'key'] },
  { name: 'Property Modifiers', category: '映射类型', difficulty: 'medium', tags: ['readonly', 'optional', '?', '-readonly', '+readonly'] },
  { name: 'Filtering Properties', category: '映射类型', difficulty: 'hard', tags: ['filter', 'as', 'never', 'template'] },

  // 模板字面量类型
  { name: 'Template Literal Types', category: '模板字面量类型', difficulty: 'medium', tags: ['template', '`${}`', 'literal'] },
  { name: 'String Manipulation', category: '模板字面量类型', difficulty: 'hard', tags: ['Uppercase', 'Lowercase', 'Capitalize', 'Uncapitalize'] },
  { name: 'Pattern Matching with Template', category: '模板字面量类型', difficulty: 'hard', tags: ['infer', 'pattern', 'template', 'match'] },

  // 工具类型
  { name: 'Partial<T>', category: '工具类型', difficulty: 'easy', tags: ['partial', 'optional'] },
  { name: 'Required<T>', category: '工具类型', difficulty: 'easy', tags: ['required'] },
  { name: 'Readonly<T>', category: '工具类型', difficulty: 'easy', tags: ['readonly'] },
  { name: 'Pick<T, K>', category: '工具类型', difficulty: 'medium', tags: ['pick', 'subset'] },
  { name: 'Omit<T, K>', category: '工具类型', difficulty: 'medium', tags: ['omit', 'exclude'] },
  { name: 'Record<K, T>', category: '工具类型', difficulty: 'medium', tags: ['record', 'dictionary'] },
  { name: 'Exclude<T, U>', category: '工具类型', difficulty: 'medium', tags: ['exclude', 'union'] },
  { name: 'Extract<T, U>', category: '工具类型', difficulty: 'medium', tags: ['extract', 'filter'] },
  { name: 'NonNullable<T>', category: '工具类型', difficulty: 'medium', tags: ['nonnullable', 'null', 'undefined'] },
  { name: 'ReturnType<T>', category: '工具类型', difficulty: 'medium', tags: ['returntype', 'infer'] },
  { name: 'Parameters<T>', category: '工具类型', difficulty: 'medium', tags: ['parameters', 'tuple'] },
  { name: 'Awaited<T>', category: '工具类型', difficulty: 'medium', tags: ['awaited', 'promise', 'recursive'] },

  // 类型守卫
  { name: 'Type Guards', category: '类型守卫', difficulty: 'medium', tags: ['typeof', 'instanceof', 'guard'] },
  { name: 'User-Defined Type Guards', category: '类型守卫', difficulty: 'medium', tags: ['is', 'type predicate'] },
  { name: 'Assertion Functions', category: '类型守卫', difficulty: 'hard', tags: ['asserts', 'assertion'] },

  // 类型推断
  { name: 'Contextual Typing', category: '类型推断', difficulty: 'medium', tags: ['contextual', 'inference'] },
  { name: 'Best Common Type', category: '类型推断', difficulty: 'medium', tags: ['common type', 'inference'] },
  { name: 'Type Widening', category: '类型推断', difficulty: 'medium', tags: ['widen', 'literal', 'const'] },
  { name: 'Type Narrowing', category: '类型推断', difficulty: 'medium', tags: ['narrow', 'typeof', 'discriminated'] },
]

/** 所有分类列表 */
export const ALL_LEARNING_CATEGORIES: LearningCategory[] = [
  '基础类型', '泛型', '条件类型', '映射类型',
  '模板字面量类型', '工具类型', '类型守卫', '类型推断',
  '声明文件', '模块', '其他',
]
