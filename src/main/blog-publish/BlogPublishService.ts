/**
 * BlogPublishService — 一键多平台发布编排服务
 *
 * 职责：
 * 1. 管理发布任务会话（创建、查询、状态跟踪）
 * 2. 协调图片上传 → 审批 → 发布 → 回滚全流程
 * 3. 通过 EventBus 发射进度事件（支持 WebSocket 订阅）
 * 4. 维护发布历史记录（内存中，重启后通过 workflow store 恢复）
 *
 * 配合 BlogPublishTools（MCP 工具层）使用。
 * 与 WorkflowScheduler 集成：可作为 workflow 的一个 gate 步骤被调用。
 */

import { imageService } from './ImageService'
import { platformPublisherRegistry } from './PlatformPublisher'
import { eventBus } from '../core/EventBus'
import { log } from '../logger/Logger'
import { getCredentialsManager } from '../tool/deps'
import type {
  PublishConfig,
  PublishTask,
  PublishPlatform,
  PublishSessionStatus,
  PlatformPublishStatus,
  PublishProgressEvent,
  ImageProcessResult,
  PublishResult,
} from './types'
import { PUBLISH_EVENTS } from './types'

// =============================================================================
// 发布服务
// =============================================================================

export class BlogPublishService {
  /** 活跃的发布任务（taskId → PublishTask） */
  private tasks = new Map<string, PublishTask>()
  /** 已完成/归档的任务（保留最近 50 条） */
  private history: PublishTask[] = []
  private readonly MAX_HISTORY = 50

  // ── 任务生命周期 ──

  /**
   * 创建新的发布任务，返回 taskId。
   * 此时任务处于 'pending' 状态，尚未执行任何操作。
   */
  createTask(config: PublishConfig): PublishTask {
    const taskId = `pub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    const platformStatuses: Record<string, PlatformPublishStatus> = {}
    for (const platform of config.platforms) {
      platformStatuses[platform] = {
        platform,
        status: 'pending',
      }
    }

    const task: PublishTask = {
      taskId,
      createdAt: Date.now(),
      config,
      platformStatuses,
      status: 'pending',
      approvalStatus: config.requireApproval !== false ? 'pending' : undefined,
    }

    this.tasks.set(taskId, task)
    log('INFO', 'blog_publish_task_created', { taskId, platforms: config.platforms.join(',') })
    return task
  }

  /**
   * 获取发布任务。
   */
  getTask(taskId: string): PublishTask | undefined {
    return this.tasks.get(taskId)
  }

  /**
   * 列出所有活跃（未完成/未失败）的发布任务。
   */
  listActiveTasks(): PublishTask[] {
    return Array.from(this.tasks.values()).filter(
      (t) => !['completed', 'failed', 'rolled_back'].includes(t.status),
    )
  }

  /**
   * 获取最近 N 条发布历史。
   */
  getHistory(limit: number = 10): PublishTask[] {
    return this.history.slice(0, limit)
  }

  /**
   * 获取所有活跃 + 历史任务。
   */
  getAllTasks(limit: number = 50): PublishTask[] {
    const active = Array.from(this.tasks.values())
    return [...active, ...this.history].slice(0, limit)
  }

  // ── 预发布流程 ──

  /**
   * 执行发布预处理（图片上传）。
   * 将任务状态从 'pending' 推进到 'preparing'，完成后进入 'approving'（如需审批）或 'publishing'。
   */
  async prepare(taskId: string, cdnPrefix?: string): Promise<PublishTask> {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`发布任务 ${taskId} 不存在`)
    if (task.status !== 'pending') throw new Error(`任务 ${taskId} 状态为 ${task.status}，无法预处理`)

    this.emitProgress(taskId, 'prepare', undefined, 'started', '开始图片预处理...', 0)
    task.status = 'preparing'

    try {
      // 处理图片
      const imageResult = await imageService.processImages(task.config.content, cdnPrefix)
      task.imageResult = imageResult

      // 如果有上传成功的图片，更新内容为 CDN 引用
      if (imageResult.uploaded > 0) {
        task.config = { ...task.config, content: imageResult.updatedContent }
      }

      if (imageResult.uploaded > 0 || imageResult.totalImages === 0) {
        this.emitProgress(taskId, 'prepare', undefined, 'success',
          `图片预处理完成: ${imageResult.uploaded} 上传, ${imageResult.failed} 失败`, 100)
      } else {
        this.emitProgress(taskId, 'prepare', undefined, 'failed',
          `图片预处理失败: ${imageResult.failed} 张图片上传失败`, 100)
      }

      // 进入审批或直接发布
      if (task.config.requireApproval !== false) {
        task.status = 'approving'
        task.approvalStatus = 'pending'
        this.emitProgress(taskId, 'approve', undefined, 'started', '等待发布审批...', 50)
      } else {
        // 无需审批，直接进入发布
        await this.executePublish(task)
      }
    } catch (err: any) {
      task.status = 'failed'
      task.error = err.message
      this.emitProgress(taskId, 'prepare', undefined, 'failed', `预处理失败: ${err.message}`, 0)
      log('ERROR', 'blog_publish_prepare_failed', { taskId, error: err.message })
    }

    return task
  }

  // ── 审批流程 ──

  /**
   * 批准发布。
   */
  async approve(taskId: string): Promise<PublishTask> {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`发布任务 ${taskId} 不存在`)
    if (task.status !== 'approving') throw new Error(`任务 ${taskId} 不在审批状态`)

    task.approvalStatus = 'approved'
    this.emitProgress(taskId, 'approve', undefined, 'success', '发布已批准', 60)

    await this.executePublish(task)
    return task
  }

  /**
   * 驳回发布。
   */
  reject(taskId: string, reason?: string): PublishTask {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`发布任务 ${taskId} 不存在`)

    task.status = 'failed'
    task.approvalStatus = 'rejected'
    task.error = reason || '发布被驳回'
    this.emitProgress(taskId, 'approve', undefined, 'failed', `发布被驳回: ${reason || '用户拒绝'}`, 0)

    this.archiveTask(taskId)
    return task
  }

  // ── 发布执行 ──

  /**
   * 执行发布到所有已配置的目标平台。
   */
  private async executePublish(task: PublishTask): Promise<void> {
    task.status = 'publishing'
    this.emitProgress(task.taskId, 'publish', undefined, 'started', '开始发布...', 60)

    const platforms = task.config.platforms
    let successCount = 0
    let failCount = 0

    for (let i = 0; i < platforms.length; i++) {
      const platform = platforms[i]
      const status = task.platformStatuses[platform]
      if (!status) continue

      status.status = 'publishing'
      status.startedAt = Date.now()

      const progress = 60 + Math.round((i / platforms.length) * 35)
      this.emitProgress(task.taskId, 'publish', platform, 'started',
        `正在发布到 ${platform}...`, progress)

      try {
        const adapter = platformPublisherRegistry.get(platform)
        if (!adapter) {
          throw new Error(`平台 "${platform}" 的发布适配器未注册`)
        }

        if (!adapter.isConfigured()) {
          throw new Error(`平台 "${platform}" 未配置凭证（请先设置对应 API 密钥）`)
        }

        const result = await adapter.publish(task.config)
        status.status = 'success'
        status.postUrl = result.postUrl
        status.postId = result.postId
        status.completedAt = Date.now()
        successCount++

        this.emitProgress(task.taskId, 'publish', platform, 'success',
          `✓ ${platform} 发布成功${result.postUrl ? `: ${result.postUrl}` : ''}`, progress)
      } catch (err: any) {
        status.status = 'failed'
        status.error = err.message
        status.completedAt = Date.now()
        failCount++

        this.emitProgress(task.taskId, 'publish', platform, 'failed',
          `✗ ${platform} 发布失败: ${err.message}`, progress)
        log('ERROR', 'blog_publish_platform_failed', { taskId: task.taskId, platform, error: err.message })
      }
    }

    // 汇总结果
    if (failCount === 0) {
      task.status = 'completed'
      this.emitProgress(task.taskId, 'complete', undefined, 'success',
        `✅ 全平台发布完成（${successCount}/${platforms.length} 成功）`, 100)
    } else if (successCount === 0) {
      task.status = 'failed'
      this.emitProgress(task.taskId, 'complete', undefined, 'failed',
        `❌ 全平台发布失败（${platforms.length} 个平台均失败）`, 100)
    } else {
      task.status = 'partial'
      this.emitProgress(task.taskId, 'complete', undefined, 'success',
        `⚠️ 部分完成: ${successCount} 成功, ${failCount} 失败`, 100)
    }

    this.archiveTask(task.taskId)
  }

  // ── 回滚 ──

  /**
   * 回滚指定的发布任务（删除已发布的文章）。
   */
  async rollback(taskId: string, specificPlatforms?: PublishPlatform[]): Promise<PublishResult> {
    const task = this.tasks.get(taskId)
    if (!task) {
      // 检查历史
      const hist = this.history.find((h) => h.taskId === taskId)
      if (!hist) throw new Error(`发布任务 ${taskId} 不存在`)
      return this.doRollback(hist, specificPlatforms || hist.config.platforms)
    }

    return this.doRollback(task, specificPlatforms || task.config.platforms)
  }

  private async doRollback(
    task: PublishTask,
    platforms: PublishPlatform[],
  ): Promise<PublishResult> {
    task.status = 'rolling_back'
    this.emitProgress(task.taskId, 'rollback', undefined, 'started', '开始回滚...', 0)

    const results: PublishResult['platformResults'] = []
    const rolledBack: PublishPlatform[] = []
    const failedRollback: PublishPlatform[] = []

    for (const platform of platforms) {
      const status = task.platformStatuses[platform]
      if (!status || status.status !== 'success' || !status.postId) {
        results.push({
          platform,
          status: status?.status === 'pending' ? 'pending' as any : 'rolled_back',
          error: status?.status === 'pending' ? '未发布，无需回滚' : undefined,
        })
        continue
      }

      status.status = 'rolling_back'
      this.emitProgress(task.taskId, 'rollback', platform, 'started',
        `回滚 ${platform}...`, 50)

      try {
        const adapter = platformPublisherRegistry.get(platform)
        if (!adapter) throw new Error(`平台 "${platform}" 的适配器未注册`)
        await adapter.delete(status.postId)

        status.status = 'rolled_back'
        rolledBack.push(platform)
        results.push({ platform, status: 'rolled_back', postId: status.postId })

        this.emitProgress(task.taskId, 'rollback', platform, 'success',
          `✓ ${platform} 已回滚`, 80)
      } catch (err: any) {
        status.status = 'failed'
        failedRollback.push(platform)
        results.push({ platform, status: 'failed', postId: status.postId, error: err.message })

        this.emitProgress(task.taskId, 'rollback', platform, 'failed',
          `✗ ${platform} 回滚失败: ${err.message}`, 80)
      }
    }

    task.status = failedRollback.length === 0 ? 'rolled_back' : 'partial'

    this.emitProgress(task.taskId, 'complete', undefined,
      task.status === 'rolled_back' ? 'success' : 'failed',
      task.status === 'rolled_back' ? '✅ 回滚完成' : '⚠️ 部分回滚失败', 100)

    // 根据 platforms 参数中的最新状态更新 platformStatuses
    for (const r of results) {
      if (task.platformStatuses[r.platform]) {
        task.platformStatuses[r.platform].status = r.status as any
        if (r.error) task.platformStatuses[r.platform].error = r.error
      }
    }

    return {
      taskId: task.taskId,
      title: task.config.title,
      status: task.status,
      platformResults: results,
      imageResult: task.imageResult,
      rollbackInfo: {
        rolledBackPlatforms: rolledBack,
        failedPlatforms: failedRollback,
      },
      completedAt: Date.now(),
    }
  }

  // ── 查询 ──

  /**
   * 获取发布任务的格式化状态文本。
   */
  getStatusText(taskId: string): string {
    const task = this.tasks.get(taskId) || this.history.find((h) => h.taskId === taskId)
    if (!task) return `❌ 发布任务 ${taskId} 不存在`

    const statusLabels: Record<PublishSessionStatus, string> = {
      pending: '待开始',
      preparing: '预处理中',
      approving: '等待审批',
      publishing: '发布中',
      completed: '已完成',
      partial: '部分完成',
      failed: '失败',
      rolling_back: '回滚中',
      rolled_back: '已回滚',
    }

    const lines: string[] = [
      `📋 发布任务: ${task.taskId}`,
      `📌 标题: ${task.config.title}`,
      `📊 状态: ${statusLabels[task.status] || task.status}`,
      `🎯 目标平台: ${task.config.platforms.join(', ')}`,
      task.approvalStatus ? `审批: ${task.approvalStatus === 'approved' ? '✅ 已批准' : task.approvalStatus === 'rejected' ? '❌ 已驳回' : '⏳ 待审批'}` : '',
      task.imageResult ? `🖼 图片: ${task.imageResult.uploaded}/${task.imageResult.totalImages} 上传` : '',
      task.error ? `⛔ 错误: ${task.error}` : '',
      '',
      '📄 各平台状态:',
    ]

    for (const ps of Object.values(task.platformStatuses)) {
      const icon = ps.status === 'success' ? '✅' : ps.status === 'failed' ? '❌' : ps.status === 'publishing' ? '⏳' : ps.status === 'rolled_back' ? '↩️' : ps.status === 'rolling_back' ? '🔄' : '⬜'
      lines.push(`  ${icon} ${ps.platform}: ${ps.status}${ps.postUrl ? ` → ${ps.postUrl}` : ''}${ps.error ? ` (${ps.error.slice(0, 100)})` : ''}`)
    }

    return lines.filter(Boolean).join('\n')
  }

  // ── 工具方法 ──

  /**
   * 检查各平台的凭证配置状态。
   */
  checkCredentialStatus(): Array<{ platform: PublishPlatform; label: string; configured: boolean; missingCredentials: string[] }> {
    const cm = getCredentialsManager()
    const LABELS: Record<string, string> = {
      wordpress: 'WordPress',
      github_pages: 'GitHub Pages',
      generic_http: '通用 HTTP API',
    }

    const platforms = [
      { platform: 'wordpress' as PublishPlatform, creds: ['wordpress_api_endpoint', 'wordpress_api_password'] },
      { platform: 'github_pages' as PublishPlatform, creds: ['github_token', 'github_repo'] },
      { platform: 'generic_http' as PublishPlatform, creds: ['generic_http_url', 'generic_http_token'] },
    ]

    return platforms.map((p) => {
      const missing = p.creds.filter((c) => !cm?.get(c))
      return {
        platform: p.platform,
        label: LABELS[p.platform] || p.platform,
        configured: missing.length === 0,
        missingCredentials: missing,
      }
    })
  }

  /**
   * 将任务归档到历史列表。
   */
  private archiveTask(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    this.tasks.delete(taskId)
    this.history.unshift(task)
    if (this.history.length > this.MAX_HISTORY) {
      this.history = this.history.slice(0, this.MAX_HISTORY)
    }
  }

  /**
   * 通过 EventBus 发射进度事件。
   * 前端可通过 WebSocket 订阅这些事件实现实时进度推送。
   */
  private emitProgress(
    taskId: string,
    stage: PublishProgressEvent['stage'],
    platform: PublishPlatform | undefined,
    status: PublishProgressEvent['status'],
    message: string,
    progress?: number,
  ): void {
    const event: PublishProgressEvent = {
      taskId,
      stage,
      platform,
      status,
      message,
      progress,
      timestamp: Date.now(),
    }

    try {
      eventBus.emit(PUBLISH_EVENTS.PROGRESS, event)

      if (status === 'success' && stage === 'complete') {
        eventBus.emit(PUBLISH_EVENTS.COMPLETED, event)
      }
      if (status === 'failed' && stage === 'complete') {
        eventBus.emit(PUBLISH_EVENTS.FAILED, event)
      }
      if (status === 'success' && stage === 'rollback') {
        eventBus.emit(PUBLISH_EVENTS.ROLLED_BACK, event)
      }
    } catch {
      // EventBus 发射失败不应影响发布流程
    }
  }
}

/** 全局单例 */
export const blogPublishService = new BlogPublishService()
