/**
 * BlogPublish — 一键多平台发布工作流 类型定义
 *
 * 定义发布平台枚举、发布配置、发布会话、发布结果等核心类型。
 * 配合 BlogPublishService 和 BlogPublishTools 使用。
 */

// =============================================================================
// 发布平台枚举
// =============================================================================

/** 支持的发布平台 */
export type PublishPlatform = 'wordpress' | 'csdn' | 'zhihu' | 'juejin' | 'cnblogs' | 'github_pages' | 'wechat_mp' | 'generic_http'

/** 平台友好名称映射 */
export const PLATFORM_LABELS: Record<PublishPlatform, string> = {
  wordpress: 'WordPress',
  csdn: 'CSDN',
  zhihu: '知乎',
  juejin: '掘金',
  cnblogs: '博客园',
  github_pages: 'GitHub Pages',
  wechat_mp: '微信公众号',
  generic_http: '通用 HTTP API',
}

// =============================================================================
// 发布任务 / 配置
// =============================================================================

export interface PublishConfig {
  /** 目标平台列表 */
  platforms: PublishPlatform[]
  /** 文章标题 */
  title: string
  /** 文章正文（Markdown 格式） */
  content: string
  /** 文章摘要（可选，用于 SEO） */
  summary?: string
  /** 标签列表（可选） */
  tags?: string[]
  /** 分类（可选，部分平台支持） */
  category?: string
  /** 封面图片 URL（可选） */
  coverImage?: string
  /** 是否发布为草稿（不公开，默认 false） */
  asDraft?: boolean
  /** 自定义参数（透传到各平台适配器） */
  customFields?: Record<string, string>
  /** 是否需要在发布前经过审批门（默认 true） */
  requireApproval?: boolean
  /** 图片 CDN 上传目标路径前缀 */
  imageCdnPrefix?: string
}

export interface PublishTask {
  /** 任务 ID */
  taskId: string
  /** 发布时间戳 */
  createdAt: number
  /** 发布配置 */
  config: PublishConfig
  /** 各平台发布状态 */
  platformStatuses: Record<PublishPlatform, PlatformPublishStatus>
  /** 总体状态 */
  status: PublishSessionStatus
  /** 审批状态（如果 requireApproval=true） */
  approvalStatus?: 'pending' | 'approved' | 'rejected'
  /** 图片处理结果 */
  imageResult?: ImageProcessResult
  /** 错误信息 */
  error?: string
}

// =============================================================================
// 发布状态
// =============================================================================

export type PublishSessionStatus =
  | 'pending' // 待开始
  | 'preparing' // 预处理中（图片上传等）
  | 'approving' // 等待审批
  | 'publishing' // 发布中
  | 'completed' // 已完成
  | 'partial' // 部分完成（部分平台成功）
  | 'failed' // 失败
  | 'rolling_back' // 回滚中
  | 'rolled_back' // 已回滚

export type PlatformPublishStatusValue = 'pending' | 'publishing' | 'success' | 'failed' | 'rolling_back' | 'rolled_back'

export interface PlatformPublishStatus {
  platform: PublishPlatform
  status: PlatformPublishStatusValue
  /** 发布后的 URL（成功时） */
  postUrl?: string
  /** 发布的文章 ID（部分平台返回） */
  postId?: string
  error?: string
  startedAt?: number
  completedAt?: number
}

// =============================================================================
// 图片处理
// =============================================================================

export interface ImageProcessResult {
  /** 发现的图片总数 */
  totalImages: number
  /** 成功上传数 */
  uploaded: number
  /** 失败数 */
  failed: number
  /** 替换后的 Markdown 内容 */
  updatedContent: string
  /** 图片映射（原始路径 → CDN URL） */
  imageMap: Record<string, string>
  errors: string[]
}

// =============================================================================
// 发布结果
// =============================================================================

export interface PublishResult {
  taskId: string
  title: string
  status: PublishSessionStatus
  platformResults: PlatformPublishStatus[]
  imageResult?: ImageProcessResult
  /** 回滚信息（如果执行了回滚） */
  rollbackInfo?: {
    rolledBackPlatforms: PublishPlatform[]
    failedPlatforms: PublishPlatform[]
    error?: string
  }
  completedAt?: number
}

// =============================================================================
// 进度事件（用于 EventBus / WebSocket）
// =============================================================================

export interface PublishProgressEvent {
  taskId: string
  stage: 'prepare' | 'approve' | 'publish' | 'rollback' | 'complete'
  platform?: PublishPlatform
  status: 'started' | 'progress' | 'success' | 'failed'
  message: string
  progress?: number // 0-100
  timestamp: number
}

// =============================================================================
// 平台发布适配器接口
// =============================================================================

export interface PlatformPublisherAdapter {
  /** 平台标识 */
  platform: PublishPlatform
  /** 初始化（检查凭证等） */
  initialize(): Promise<void>
  /** 发布文章 */
  publish(config: PublishConfig): Promise<{ postUrl?: string; postId?: string }>
  /** 删除/回滚文章 */
  delete(postId: string): Promise<void>
  /** 检查平台凭证是否已配置 */
  isConfigured(): boolean
}

// =============================================================================
// 常量
// =============================================================================

/** 预设发布工作流模板 ID */
export const PRESET_PUBLISH_WORKFLOW_ID = 'preset_blog_publish_workflow'

/** 事件总线事件名 */
export const PUBLISH_EVENTS = {
  PROGRESS: 'blog:publish:progress',
  COMPLETED: 'blog:publish:completed',
  FAILED: 'blog:publish:failed',
  ROLLED_BACK: 'blog:publish:rolled_back',
} as const
