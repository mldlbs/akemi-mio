/**
 * 自进化文件整理引擎 — 类型定义
 *
 * 基因池规则（Gene Pool）为 JSON 条件-动作对，
 * 通过用户行为反馈（撤销移动、重新归类）调整适应度，
 * 优胜劣汰实现规则自动迭代。
 */

// =============================================================================
// 文件特征 — 扫描提取的输入
// =============================================================================

export interface FileFeatures {
  /** 完整路径（相对 workspace） */
  path: string
  /** 文件名（含扩展名） */
  name: string
  /** 不带扩展名的文件名 */
  stem: string
  /** 扩展名（小写） */
  extension: string
  /** 文件大小（字节） */
  sizeBytes: number
  /** 最后修改时间戳 */
  mtimeMs: number
  /** 创建时间戳 */
  birthtimeMs: number
  /** 当前目录深度（根=0） */
  depth: number
  /** 当前所在目录 */
  directory: string
  /** 是否是测试文件（*.test.*, *.spec.*, __tests__/） */
  isTest: boolean
  /** 是否是配置文件（env, config, settings） */
  isConfig: boolean
}

// =============================================================================
// 规则条件 — 决定何时匹配
// =============================================================================

export type ConditionType = 'extension' | 'namePattern' | 'sizeRange' | 'depthRange' | 'isTest' | 'isConfig'
export type ConditionOperator = 'equals' | 'matches' | 'in' | 'gt' | 'lt' | 'between'

export interface RuleCondition {
  type: ConditionType
  operator: ConditionOperator
  /** 条件值（统一用 string，解析时转型） */
  value: string | string[]
}

// =============================================================================
// 规则动作 — 匹配后执行什么
// =============================================================================

export type ActionType = 'move' | 'rename'

export interface RuleAction {
  type: ActionType
  /**
   * 目标目录或名称模板。
   * 支持 {ext} {stem} {date} 占位符。
   * 例如: 'docs/'、'src/{stem}.ts'、'archives/{date}/'
   */
  target: string
}

// =============================================================================
// 组织规则 — 基因池中的一条规则
// =============================================================================

export interface OrganizerRule {
  /** 规则唯一标识 */
  id: string
  /** 匹配条件列表（AND 语义） */
  conditions: RuleCondition[]
  /** 执行动作 */
  action: RuleAction
  /** 适应度 0-100 */
  fitness: number
  /** 总反馈次数 */
  feedbackCount: number
  /** 正向反馈次数 */
  positiveCount: number
  /** 负向反馈次数 */
  negativeCount: number
  /** 进化代数（0=初始规则） */
  generation: number
  /** 该规则应用的次数 */
  applyCount: number
  /** 创建时间戳 */
  createdAt: number
  /** 最后更新时间戳 */
  updatedAt: number
  /** 人类可读标签 */
  label?: string
}

// =============================================================================
// 基因池 — 规则集合
// =============================================================================

export interface GenePoolData {
  /** 规则列表 */
  rules: OrganizerRule[]
  /** 当前进化代数 */
  generation: number
  /** 上次进化时间戳 */
  lastEvolvedAt: number
  /** 冷启动标记 */
  isColdStart: boolean
  /** 版本号 */
  version: number
}

// =============================================================================
// 文件移动记录 — 用于反馈追踪
// =============================================================================

export interface FileMoveRecord {
  /** 规则 ID */
  ruleId: string
  /** 文件原始路径 */
  originalPath: string
  /** 文件移动后的路径 */
  organizedPath: string
  /** 移动时间戳 */
  movedAt: number
  /** 当前文件位置（反馈验证时更新） */
  currentPath: string
  /** 反馈确认时间戳 */
  feedbackCheckedAt?: number
  /** 反馈结果：true=正向(留在原地), false=负向(被移回) */
  feedback?: boolean
}

// =============================================================================
// 基因池进化配置
// =============================================================================

export interface EvolutionConfig {
  /** 种群大小（规则数量上限） */
  populationSize: number
  /** 每代精英比例（保留的最优规则比例） */
  eliteRatio: number
  /** 变异率 0-1 */
  mutationRate: number
  /** 交叉率 0-1 */
  crossoverRate: number
  /** 进化间隔（进化周期数） */
  evolutionInterval: number
  /** 冷启动初始规则数量 */
  initialRuleCount: number
  /** 稳定阈值：连续 N 次正反馈后锁定规则 */
  stabilizeThreshold: number
}

// =============================================================================
// 默认进化配置
// =============================================================================

export const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  populationSize: 50,
  eliteRatio: 0.2,
  mutationRate: 0.15,
  crossoverRate: 0.6,
  evolutionInterval: 5,
  initialRuleCount: 10,
  stabilizeThreshold: 5,
}

// =============================================================================
// 默认初始规则（冷启动种子）
// =============================================================================

export function createDefaultRules(): OrganizerRule[] {
  const now = Date.now()
  return [
    {
      id: 'builtin:ts-files',
      conditions: [{ type: 'extension', operator: 'in', value: ['.ts', '.tsx', '.js', '.jsx'] }],
      action: { type: 'move', target: 'src/' },
      fitness: 50, generation: 0, feedbackCount: 0, positiveCount: 0, negativeCount: 0, applyCount: 0,
      createdAt: now, updatedAt: now,
      label: 'TypeScript/JavaScript 源代码 → src/',
    },
    {
      id: 'builtin:test-files',
      conditions: [{ type: 'isTest', operator: 'equals', value: 'true' }],
      action: { type: 'move', target: '__tests__/' },
      fitness: 50, generation: 0, feedbackCount: 0, positiveCount: 0, negativeCount: 0, applyCount: 0,
      createdAt: now, updatedAt: now,
      label: '测试文件 → __tests__/',
    },
    {
      id: 'builtin:config-files',
      conditions: [{ type: 'isConfig', operator: 'equals', value: 'true' }],
      action: { type: 'move', target: 'config/' },
      fitness: 50, generation: 0, feedbackCount: 0, positiveCount: 0, negativeCount: 0, applyCount: 0,
      createdAt: now, updatedAt: now,
      label: '配置文件 → config/',
    },
    {
      id: 'builtin:markdown-docs',
      conditions: [{ type: 'extension', operator: 'in', value: ['.md', '.mdx', '.txt'] }],
      action: { type: 'move', target: 'docs/' },
      fitness: 45, generation: 0, feedbackCount: 0, positiveCount: 0, negativeCount: 0, applyCount: 0,
      createdAt: now, updatedAt: now,
      label: '文档文件 → docs/',
    },
    {
      id: 'builtin:json-files',
      conditions: [{ type: 'extension', operator: 'equals', value: '.json' }],
      action: { type: 'move', target: 'config/' },
      fitness: 40, generation: 0, feedbackCount: 0, positiveCount: 0, negativeCount: 0, applyCount: 0,
      createdAt: now, updatedAt: now,
      label: 'JSON 文件 → config/',
    },
    {
      id: 'builtin:image-files',
      conditions: [{ type: 'extension', operator: 'in', value: ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico'] }],
      action: { type: 'move', target: 'assets/images/' },
      fitness: 45, generation: 0, feedbackCount: 0, positiveCount: 0, negativeCount: 0, applyCount: 0,
      createdAt: now, updatedAt: now,
      label: '图片文件 → assets/images/',
    },
    {
      id: 'builtin:audio-files',
      conditions: [{ type: 'extension', operator: 'in', value: ['.wav', '.mp3', '.ogg', '.flac', '.aac'] }],
      action: { type: 'move', target: 'assets/audio/' },
      fitness: 45, generation: 0, feedbackCount: 0, positiveCount: 0, negativeCount: 0, applyCount: 0,
      createdAt: now, updatedAt: now,
      label: '音频文件 → assets/audio/',
    },
    {
      id: 'builtin:css-style-files',
      conditions: [{ type: 'extension', operator: 'in', value: ['.css', '.scss', '.less', '.styl'] }],
      action: { type: 'move', target: 'styles/' },
      fitness: 45, generation: 0, feedbackCount: 0, positiveCount: 0, negativeCount: 0, applyCount: 0,
      createdAt: now, updatedAt: now,
      label: '样式文件 → styles/',
    },
    {
      id: 'builtin:shell-scripts',
      conditions: [{ type: 'extension', operator: 'in', value: ['.sh', '.bat', '.ps1', '.cmd'] }],
      action: { type: 'move', target: 'scripts/' },
      fitness: 40, generation: 0, feedbackCount: 0, positiveCount: 0, negativeCount: 0, applyCount: 0,
      createdAt: now, updatedAt: now,
      label: '脚本文件 → scripts/',
    },
    {
      id: 'builtin:large-root-files',
      conditions: [
        { type: 'depthRange', operator: 'equals', value: '0' },
        { type: 'sizeRange', operator: 'gt', value: '102400' },
      ],
      action: { type: 'move', target: 'archives/' },
      fitness: 30, generation: 0, feedbackCount: 0, positiveCount: 0, negativeCount: 0, applyCount: 0,
      createdAt: now, updatedAt: now,
      label: '根目录大文件 → archives/',
    },
  ]
}
