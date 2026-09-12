/**
 * BlogAgent — 类型定义和常量
 *
 * BlogAgent 管理博客写作的交互式工作流，
 * 支持推理链步骤、用户决策节点、自然语言指令覆盖。
 */

// =============================================================================
// 博客写作工作流阶段
// =============================================================================

export enum BlogStage {
  /** 主题分析：理解用户意图、目标平台、受众 */
  IntentAnalysis = 'intent_analysis',
  /** 素材收集：搜索资料、代码分析、数据收集 */
  MaterialCollection = 'material_collection',
  /** 大纲生成：生成文章结构供用户审核 */
  Outline = 'outline',
  /** 初稿生成：基于大纲写完整初稿 */
  DraftWriting = 'draft_writing',
  /** 质量审核：用户审核初稿，提出修改意见 */
  QualityReview = 'quality_review',
  /** 终稿润色：根据反馈完成终版 */
  FinalPolish = 'final_polish',
  /** 发布规划：规划发布平台、时间、标签 */
  PublishingPlan = 'publishing_plan',
}

export const BLOG_STAGE_LABELS: Record<BlogStage, string> = {
  [BlogStage.IntentAnalysis]: '主题与意图分析',
  [BlogStage.MaterialCollection]: '素材收集',
  [BlogStage.Outline]: '文章大纲',
  [BlogStage.DraftWriting]: '初稿生成',
  [BlogStage.QualityReview]: '质量审核',
  [BlogStage.FinalPolish]: '终稿润色',
  [BlogStage.PublishingPlan]: '发布规划',
}

export const BLOG_STAGE_ORDER: BlogStage[] = [
  BlogStage.IntentAnalysis,
  BlogStage.MaterialCollection,
  BlogStage.Outline,
  BlogStage.DraftWriting,
  BlogStage.QualityReview,
  BlogStage.FinalPolish,
  BlogStage.PublishingPlan,
]

// =============================================================================
// 会话状态
// =============================================================================

export interface BlogSessionState {
  /** 唯一会话ID */
  sessionId: string
  /** 当前阶段 */
  currentStage: BlogStage
  /** 上一阶段（用于回退） */
  previousStage: BlogStage | null
  /** 被跳过的阶段列表 */
  skippedStages: BlogStage[]
  /** 阶段运行状态 */
  stageStatuses: Record<BlogStage, 'pending' | 'running' | 'completed' | 'skipped' | 'failed'>
  /** 用户主题/标题 */
  topic: string
  /** 目标平台 */
  targetPlatform: string
  /** 目标受众描述 */
  targetAudience: string
  /** 文章风格 */
  style: string
  /** 每个阶段的输出 */
  stageOutputs: Partial<Record<BlogStage, string>>
  /** 用户反馈/修改意见 */
  userFeedback: string[]
  /** 创建时间 */
  createdAt: number
  /** 最后活动时间 */
  lastActivityAt: number
  /** 是否已完成 */
  completed: boolean
  /** 工作流运行ID（如果通过 WorkflowScheduler 执行） */
  workflowRunId?: string
  /** 启动时自动检索的相似历史经验参考 */
  experienceReferences?: Array<{
    content: string
    category: string
    score: number
    stepDescription?: string
  }>
}

// =============================================================================
// 自然语言指令解析
// =============================================================================

export type BlogCommandType =
  | 'skip' // 跳过当前步骤
  | 'override' // 覆盖决策/方向
  | 'modify' // 修改某一步的输出
  | 'restart' // 从某一步重新开始
  | 'add' // 增加额外步骤
  | 'approve' // 批准当前步骤
  | 'feedback' // 提供反馈
  | 'status' // 查询状态
  | 'unknown'

export interface ParsedBlogCommand {
  type: BlogCommandType
  /** 目标阶段（如果有） */
  targetStage?: BlogStage | string
  /** 指令内容 */
  content?: string
  /** 原始用户输入 */
  raw: string
}

// =============================================================================
// 写作习惯画像
// =============================================================================

export interface WritingHabitProfile {
  /** 常用写作时段（小时, 0-23） */
  preferredHour: number | null
  /** 常用主题/标签 */
  commonTopics: string[]
  /** 常用平台 */
  commonPlatforms: string[]
  /** 文章风格偏好 */
  stylePreferences: string[]
  /** 平均修订轮次 */
  avgRevisionRounds: number
  /** 是否喜欢先出大纲 */
  prefersOutline: boolean
  /** 偏好的文章长度范围 */
  preferredLengthRange: { min: number; max: number }
  /** 是否按时发布 */
  hasFixedSchedule: boolean
  /** 固定发布日（1=周一, 7=周日） */
  preferredPublishDay: number | null
  /** 总写作次数 */
  totalSessions: number
  /** 最近更新时间 */
  lastUpdated: number
}

export const DEFAULT_HABIT_PROFILE: WritingHabitProfile = {
  preferredHour: null,
  commonTopics: [],
  commonPlatforms: [],
  stylePreferences: [],
  avgRevisionRounds: 1,
  prefersOutline: true,
  preferredLengthRange: { min: 800, max: 3000 },
  hasFixedSchedule: false,
  preferredPublishDay: null,
  totalSessions: 0,
  lastUpdated: 0,
}

// =============================================================================
// 指令关键词和匹配模式
// =============================================================================

/**
 * 自然语言指令 → BlogCommandType 映射模式
 */
export const COMMAND_PATTERNS: Array<{
  type: BlogCommandType
  patterns: RegExp[]
}> = [
  {
    type: 'skip',
    patterns: [/跳过|不要|不需要|取消|不用.*了|跳过.*步|省略|略过/i, /skip|不需要|不用(做|写|分析)/i],
  },
  {
    type: 'override',
    patterns: [/改成|改为|换(一)?个|不要.*要|我觉得|我认为|按我的|听我说/i, /change.*to|instead|override|改用/i],
  },
  {
    type: 'modify',
    patterns: [/修改|调整|改一下|优化|补充|完善|增加.*内容|删掉|减少/i, /modify|adjust|update|improve/i],
  },
  {
    type: 'restart',
    patterns: [/重来|重新(开始|来)|从头|回到|从.*开始|回退到/i, /restart|redo|go back|rollback/i],
  },
  {
    type: 'approve',
    patterns: [
      /好|可以|不错|通过|批准|同意|就这么办|就这样|继续|就这样吧|没问题|ok|好的/i,
      /approve|good|great|proceed|continue|looks? good/i,
    ],
  },
  {
    type: 'feedback',
    patterns: [/觉得|感觉|意见|反馈|建议|问题|不足|改进|加(一)?个|补充(一)?下/i, /feedback|suggestion|opinion|think|feel/i],
  },
  {
    type: 'status',
    patterns: [/进度|状态|到哪(了|里)|进行得|怎么样了|当前(步骤|阶段)/i, /status|progress|where|current/i],
  },
]

// =============================================================================
// 工作流相关常量
// =============================================================================

export const BLOG_WORKFLOW_ID = 'preset_blog_workflow'

export const BLOG_WORKFLOW_NAME = '博客智能协作工作流'

export const BLOG_WORKFLOW_DESC = '与 BlogAgent 协作完成博客写作，支持推理链步骤、用户决策节点和习惯自适应优化'

// =============================================================================
// 安全审查相关类型
// =============================================================================

/** 安全审查风险等级 */
export type SecurityRiskLevel = 'critical' | 'high' | 'medium' | 'low' | 'info'

/** 安全审查发现 */
export interface SecurityFinding {
  /** 发现 ID */
  id: string
  /** 风险等级 */
  riskLevel: SecurityRiskLevel
  /** 问题类别 */
  category:
    | 'xss' // 跨站脚本
    | 'injection' // 注入攻击（SQL/命令/模板）
    | 'sensitive_data' // 敏感信息泄露（API Key / Token / 密码）
    | 'external_link' // 外部链接风险（可疑/恶意链接）
    | 'phishing' // 钓鱼内容
    | 'malicious_code' // 恶意代码/脚本
    | 'information_disclosure' // 信息泄露（内网IP/路径/配置）
    | 'copyright' // 版权问题
    | 'other'
  /** 问题描述 */
  description: string
  /** 影响的文本范围 */
  location: {
    /** 行号（如果可定位） */
    line?: number
    /** 片段预览 */
    snippet: string
  }
  /** 修复建议 */
  suggestion: string
  /** 是否可自动修复 */
  autoFixable: boolean
  /** 置信度 (0-1) */
  confidence: number
}

/** 安全审查报告 */
export interface SecurityReviewReport {
  /** 审查时间 */
  timestamp: number
  /** 审查内容摘要（前200字符） */
  contentPreview: string
  /** 发现的累计风险等级 */
  overallRiskLevel: SecurityRiskLevel
  /** 发现列表 */
  findings: SecurityFinding[]
  /** 高风险及以上发现数量 */
  criticalHighCount: number
  /** 总发现数 */
  totalFindings: number
  /** 是否通过审查 */
  passed: boolean
  /** 建议动作 */
  recommendedAction: 'proceed' | 'fix_before_publish' | 'block'
}

// =============================================================================
// 发布后追踪与分析类型
// =============================================================================

/** 发布平台效果记录 */
export interface PostPerformance {
  /** 文章ID */
  postId: string
  /** 文章标题 */
  title: string
  /** 发布平台 */
  platform: string
  /** 发布时间 */
  publishedAt: number
  /** 阅读量 */
  views: number
  /** 点赞数 */
  likes: number
  /** 评论数 */
  comments: number
  /** 收藏/分享数 */
  shares: number
  /** 互动率 (likes+comments+shares)/views */
  engagementRate: number
  /** 发布时间段（用于分析最佳发布时段） */
  publishHour: number
  /** 发布星期几（0=周日） */
  publishDay: number
}

/** 文章类别效果汇总 */
export interface CategoryPerformanceSummary {
  /** 类别/主题标签 */
  category: string
  /** 文章数 */
  postCount: number
  /** 平均阅读量 */
  avgViews: number
  /** 平均互动率 */
  avgEngagementRate: number
  /** 总互动数 */
  totalEngagements: number
  /** 综合表现评分 (0-1) */
  performanceScore: number
}

/** 平台效果对比 */
export interface PlatformPerformance {
  platform: string
  postCount: number
  avgViews: number
  avgEngagementRate: number
  totalViews: number
}

/** 发布时段分析 */
export interface TimeSlotPerformance {
  hour: number
  avgViews: number
  avgEngagementRate: number
  postCount: number
  score: number
}

/** 分析报告 */
export interface AnalyticsReport {
  /** 报告生成时间 */
  generatedAt: number
  /** 数据覆盖的文章数 */
  totalPosts: number
  /** 覆盖的平台 */
  platforms: string[]
  /** 总体平均阅读量 */
  overallAvgViews: number
  /** 总体平均互动率 */
  overallAvgEngagementRate: number
  /** 按类别汇总 */
  categorySummary: CategoryPerformanceSummary[]
  /** 按平台表现 */
  platformPerformance: PlatformPerformance[]
  /** 最佳发布时段（Top 3 小时） */
  bestTimeSlots: TimeSlotPerformance[]
  /** 最佳平台 */
  bestPlatform: string
  /** 表现最好的类别 */
  topCategory: string
  /** 洞察与建议 */
  insights: string[]
  /** 数据是否充足 */
  hasSufficientData: boolean
}

// =============================================================================
// 选题策略调整类型
// =============================================================================

/** 选题策略调整方向 */
export type StrategyDirection = 'double_down' | 'explore' | 'shift' | 'reduce'

/** 策略调整建议 */
export interface StrategyAdjustment {
  /** 涉及的主题/类别 */
  topic: string
  /** 调整方向 */
  direction: StrategyDirection
  /** 调整理由 */
  reason: string
  /** 建议的调整幅度 (0-1) */
  magnitude: number
  /** 期望效果 */
  expectedOutcome: string
}

/** 策略调整输出 */
export interface StrategyOutput {
  /** 调整时间 */
  timestamp: number
  /** 数据驱动标志（基于真实数据还是默认推荐） */
  dataDriven: boolean
  /** 推荐的下一个选题方向 */
  recommendedTopics: string[]
  /** 各选题建议 */
  adjustments: StrategyAdjustment[]
  /** 避免的主题 */
  avoidTopics: string[]
  /** 整体策略说明 */
  summary: string
}
