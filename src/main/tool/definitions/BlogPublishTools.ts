/**
 * BlogPublishTools — 一键多平台发布工作流 MCP 工具集
 *
 * 提供以下工具：
 * 1. blog_prepare_publish — 发布预处理（图片上传 + 内容检查）
 * 2. blog_publish — 执行多平台发布（含审批门支持）
 * 3. blog_publish_status — 查看发布任务状态和进度
 * 4. blog_publish_rollback — 回滚已发布的文章
 * 5. blog_publish_credential_check — 检查各平台凭证配置状态
 * 6. blog_publish_workflow — 创建并启动预设发布工作流
 *
 * 设计原则（与 BlogToolboxTools / WorkflowTools 一致）：
 * - 每个工具独立、自描述
 * - 工具名统一前缀 blog_publish_
 * - 通过 BlogPublishService 统一编排
 * - 返回标准化 markdown 文本
 */

import { buildTool, formatToolResult, formatToolError } from '../types'
import { blogPublishService } from '../../blog-publish/BlogPublishService'
import { workflowStore } from '../../workflow/WorkflowStoreV2'
import { getWorkflowScheduler } from '../../workflow/WorkflowScheduler'
import { validateWorkflow } from '../../workflow/WorkflowValidator'
import type { WorkflowDef, WorkflowStepDef } from '../../workflow/types'
import type { PublishConfig, PublishPlatform } from '../../blog-publish/types'
import { PLATFORM_LABELS } from '../../blog-publish/types'

// =============================================================================
// 工具 1: blog_prepare_publish — 发布预处理
// =============================================================================

export const blogPreparePublishTool = buildTool({
  name: 'blog_prepare_publish',
  description:
    '【BlogPublish】发布预处理：扫描 Markdown 正文中的本地图片，上传到 CDN 并替换引用，进行内容检查。' +
    '返回处理报告和预览内容。此步骤不会实际发布，需后续调用 blog_publish 执行发布。' +
    '图片上传 CDN 需先配置凭证（image_cdn_base_url, image_cdn_upload_cmd）',
  inputJSONSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: '博客正文（Markdown 格式）',
      },
      title: {
        type: 'string',
        description: '文章标题（可选，用于报告显示）',
      },
      cdnPrefix: {
        type: 'string',
        description: 'CDN 上传路径前缀（可选，默认 blog-images）',
      },
    },
    required: ['content'],
  },
  handler: async (args: { content: string; title?: string; cdnPrefix?: string }) => {
    try {
      const content = String(args.content)
      if (!content.trim()) return formatToolError('内容不能为空')

      const prefix = args.cdnPrefix || 'blog-images'
      const title = args.title || '(未命名)'

      // 通过 service 创建临时任务执行预处理
      const tempConfig: PublishConfig = {
        platforms: [],
        title,
        content,
        requireApproval: false,
        imageCdnPrefix: prefix,
      }

      const task = blogPublishService.createTask(tempConfig)
      await blogPublishService.prepare(task.taskId, prefix)

      const updatedTask = blogPublishService.getTask(task.taskId)
      const imageResult = updatedTask?.imageResult

      if (!imageResult) {
        return formatToolResult(`📝 预处理完成（无图片需要处理）

文章标题: ${title}
内容长度: ${content.length} 字符
CDN 前缀: ${prefix}

未检测到需要处理的图片，可直接执行发布。`)
      }

      const lines: string[] = [
        '🖼 图片预处理报告',
        `文章: ${title}`,
        `总图片数: ${imageResult.totalImages}`,
        `上传成功: ${imageResult.uploaded}`,
        `上传失败: ${imageResult.failed}`,
        '',
      ]

      if (Object.keys(imageResult.imageMap).length > 0) {
        lines.push('📋 CDN 映射:')
        for (const [original, cdnUrl] of Object.entries(imageResult.imageMap)) {
          lines.push(`  ${original} → ${cdnUrl}`)
        }
        lines.push('')
      }

      if (imageResult.errors.length > 0) {
        lines.push('⚠️ 错误:')
        for (const err of imageResult.errors) {
          lines.push(`  • ${err}`)
        }
        lines.push('')
      }

      if (imageResult.uploaded > 0) {
        lines.push('✅ 图片已上传到 CDN，引用已替换。可直接调用 blog_publish 执行发布。')
      } else if (imageResult.failed > 0) {
        lines.push('⚠️ 部分图片上传失败，请检查凭证配置后重试。')
      }

      // 显示内容预览（替换后的前 300 字符）
      const preview = imageResult.updatedContent.substring(0, 300)
      const previewLines = preview.split('\n').slice(0, 8).join('\n')
      lines.push('', '📄 内容预览（替换后，前 300 字符）:', '---', previewLines, '---')

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(`预处理失败: ${err.message}`)
    }
  },
  isReadOnly: false,
})

// =============================================================================
// 工具 2: blog_publish — 执行多平台发布
// =============================================================================

export const blogPublishTool = buildTool({
  name: 'blog_publish',
  description:
    '【BlogPublish】执行多平台发布。支持多种目标平台：wordpress、github_pages、generic_http 等。' +
    '发布前会先执行图片预处理（CDN 上传 + 引用替换）。' +
    '默认需要审批确认（通过 blog_approve_publish 批准），也可设置 requireApproval=false 直接发布。' +
    '发布进度通过 blog_publish_status 查看。' +
    '各平台需提前配置 API 凭证（见 blog_publish_credential_check）',
  inputJSONSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: '文章标题',
      },
      content: {
        type: 'string',
        description: '文章正文（Markdown 格式）',
      },
      platforms: {
        type: 'array',
        items: { type: 'string' },
        description: '目标平台列表。可选值: wordpress, github_pages, generic_http。留空自动发布到所有已配置的平台',
      },
      summary: {
        type: 'string',
        description: '文章摘要（可选，用于 SEO 描述）',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: '标签列表（可选）',
      },
      category: {
        type: 'string',
        description: '分类（可选，部分平台支持）',
      },
      coverImage: {
        type: 'string',
        description: '封面图片 URL（可选）',
      },
      asDraft: {
        type: 'boolean',
        description: '是否作为草稿发布（不公开显示），默认 false',
      },
      requireApproval: {
        type: 'boolean',
        description: '是否需要审批门确认后再发布，默认 true。设为 false 则预处理后直接发布',
      },
      cdnPrefix: {
        type: 'string',
        description: 'CDN 上传路径前缀（可选，默认 blog-images）',
      },
    },
    required: ['title', 'content'],
  },
  handler: async (args: {
    title: string
    content: string
    platforms?: string[]
    summary?: string
    tags?: string[]
    category?: string
    coverImage?: string
    asDraft?: boolean
    requireApproval?: boolean
    cdnPrefix?: string
  }) => {
    try {
      const title = String(args.title)
      const content = String(args.content)
      if (!title.trim()) return formatToolError('标题不能为空')
      if (!content.trim()) return formatToolError('内容不能为空')

      // 确定目标平台
      let platforms: PublishPlatform[]
      if (args.platforms && args.platforms.length > 0) {
        platforms = args.platforms as PublishPlatform[]
        // 过滤无效平台
        platforms = platforms.filter((p) => Object.keys(PLATFORM_LABELS).includes(p))
        if (platforms.length === 0) {
          return formatToolError(`未找到有效的目标平台。可用平台: ${Object.keys(PLATFORM_LABELS).join('、')}`)
        }
      } else {
        // 自动检测已配置的平台
        const credentialStatus = blogPublishService.checkCredentialStatus()
        platforms = credentialStatus.filter((c) => c.configured).map((c) => c.platform)
        if (platforms.length === 0) {
          return formatToolError(
            '未检测到任何已配置的发布平台。请先用 set_credential 配置平台凭证，或手动指定 platforms 参数。\n' +
            '可用 `blog_publish_credential_check` 查看各平台凭证配置状态。',
          )
        }
      }

      const config: PublishConfig = {
        platforms,
        title,
        content,
        summary: args.summary,
        tags: args.tags,
        category: args.category,
        coverImage: args.coverImage,
        asDraft: args.asDraft ?? false,
        requireApproval: args.requireApproval ?? true,
        imageCdnPrefix: args.cdnPrefix,
      }

      // 创建发布任务
      const task = blogPublishService.createTask(config)

      // 执行预处理（图片上传）
      const prefix = args.cdnPrefix || 'blog-images'
      await blogPublishService.prepare(task.taskId, prefix)

      const updatedTask = blogPublishService.getTask(task.taskId)
      if (!updatedTask) {
        return formatToolError('任务创建后异常消失')
      }

      // 如果在 prepare 中完成了整个流程（无需审批且发布完成）
      if (updatedTask.status === 'completed' || updatedTask.status === 'partial' || updatedTask.status === 'failed') {
        return formatToolResult(blogPublishService.getStatusText(task.taskId))
      }

      // 等待审批
      if (updatedTask.status === 'approving') {
        return formatToolResult(
          `⏳ 发布任务已创建 (ID: ${task.taskId})

📌 ${title}
🎯 目标: ${platforms.join(', ')}
📊 状态: 等待审批

图片预处理已完成。请用以下工具审批：
- blog_approve_publish taskId="${task.taskId}" — 批准发布
- blog_reject_publish taskId="${task.taskId}" — 驳回发布

或查看状态: blog_publish_status taskId="${task.taskId}"`,
        )
      }

      return formatToolResult(blogPublishService.getStatusText(task.taskId))
    } catch (err: any) {
      return formatToolError(`发布失败: ${err.message}`)
    }
  },
  isReadOnly: false,
})

// =============================================================================
// 工具 3: blog_approve_publish — 批准发布
// =============================================================================

export const blogApprovePublishTool = buildTool({
  name: 'blog_approve_publish',
  description:
    '【BlogPublish】批准一个等待审批的发布任务。调用后立即执行多平台发布。发布进度通过 blog_publish_status 查看',
  inputJSONSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: '发布任务 ID（从 blog_publish 返回获取）',
      },
    },
    required: ['taskId'],
  },
  handler: async (args: { taskId: string }) => {
    try {
      await blogPublishService.approve(args.taskId)
      return formatToolResult(blogPublishService.getStatusText(args.taskId))
    } catch (err: any) {
      return formatToolError(`审批失败: ${err.message}`)
    }
  },
  isReadOnly: false,
})

// =============================================================================
// 工具 4: blog_reject_publish — 驳回发布
// =============================================================================

export const blogRejectPublishTool = buildTool({
  name: 'blog_reject_publish',
  description:
    '【BlogPublish】驳回一个等待审批的发布任务。任务将被标记为失败，不会执行发布',
  inputJSONSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: '发布任务 ID',
      },
      reason: {
        type: 'string',
        description: '驳回原因（可选）',
      },
    },
    required: ['taskId'],
  },
  handler: async (args: { taskId: string; reason?: string }) => {
    try {
      blogPublishService.reject(args.taskId, args.reason)
      return formatToolResult(`❌ 发布已驳回${args.reason ? `: ${args.reason}` : ''}`)
    } catch (err: any) {
      return formatToolError(`驳回失败: ${err.message}`)
    }
  },
  isReadOnly: false,
})

// =============================================================================
// 工具 5: blog_publish_status — 查看发布状态
// =============================================================================

export const blogPublishStatusTool = buildTool({
  name: 'blog_publish_status',
  description:
    '【BlogPublish】查看发布任务的状态和详细进度。不传 taskId 时列出所有活跃的发布任务',
  inputJSONSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: '发布任务 ID（可选）。不传则列出所有活跃任务',
      },
      all: {
        type: 'boolean',
        description: '是否同时显示已归档的历史任务（默认 false）',
      },
    },
    required: [],
  },
  handler: async (args: { taskId?: string; all?: boolean }) => {
    try {
      if (args.taskId) {
        return formatToolResult(blogPublishService.getStatusText(args.taskId))
      }

      const tasks = args.all
        ? blogPublishService.getAllTasks(20)
        : blogPublishService.listActiveTasks()

      if (tasks.length === 0) {
        return formatToolResult('📭 当前没有活跃的发布任务。使用 blog_publish 创建新的发布。')
      }

      const statusLabels: Record<string, string> = {
        pending: '⏳ 待开始',
        preparing: '🔄 预处理中',
        approving: '⏸️ 待审批',
        publishing: '📤 发布中',
        completed: '✅ 已完成',
        partial: '⚠️ 部分完成',
        failed: '❌ 失败',
        rolling_back: '↩️ 回滚中',
        rolled_back: '↩️ 已回滚',
      }

      const lines: string[] = ['📋 发布任务列表', '']
      for (const t of tasks) {
        const successCount = Object.values(t.platformStatuses).filter((s) => s.status === 'success').length
        const failCount = Object.values(t.platformStatuses).filter((s) => s.status === 'failed').length
        const statusIcon = statusLabels[t.status] || t.status
        lines.push(
          `  ${statusIcon} ${t.config.title}`,
          `    ID: ${t.taskId} | 平台: ${t.config.platforms.join(', ')} | ${successCount}✓ ${failCount > 0 ? `${failCount}✗` : ''}`,
          `    创建: ${new Date(t.createdAt).toLocaleString('zh-CN')}`,
          '',
        )
      }

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(`查询状态失败: ${err.message}`)
    }
  },
  isReadOnly: true,
})

// =============================================================================
// 工具 6: blog_publish_rollback — 回滚发布
// =============================================================================

export const blogPublishRollbackTool = buildTool({
  name: 'blog_publish_rollback',
  description:
    '【BlogPublish】回滚已发布的文章（删除/隐藏发布的文章）。支持选择性回滚特定平台。' +
    '只对已成功发布的平台有效。需要先确认平台支持删除操作',
  inputJSONSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: '发布任务 ID',
      },
      platforms: {
        type: 'array',
        items: { type: 'string' },
        description: '可选，指定要回滚的平台列表。留空则回滚所有已发布的平台',
      },
      confirm: {
        type: 'boolean',
        description: '确认执行回滚（必须设为 true 才能执行）',
      },
    },
    required: ['taskId', 'confirm'],
  },
  handler: async (args: { taskId: string; platforms?: string[]; confirm: boolean }) => {
    try {
      if (!args.confirm) {
        return formatToolError('请设置 confirm=true 以确认回滚操作')
      }

      const specificPlatforms = args.platforms as PublishPlatform[] | undefined
      const result = await blogPublishService.rollback(args.taskId, specificPlatforms)

      const lines: string[] = [
        result.rollbackInfo?.rolledBackPlatforms?.length
          ? `✅ 已回滚 ${result.rollbackInfo.rolledBackPlatforms.length} 个平台`
          : '⚠️ 无可回滚平台',
        '',
        '📋 回滚详情:',
      ]

      for (const pr of result.platformResults) {
        const icon = pr.status === 'rolled_back' ? '✅' : pr.status === 'failed' ? '❌' : '⬜'
        lines.push(`  ${icon} ${pr.platform}: ${pr.status}${pr.error ? ` - ${pr.error}` : ''}`)
      }

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(`回滚失败: ${err.message}`)
    }
  },
  isReadOnly: false,
})

// =============================================================================
// 工具 7: blog_publish_credential_check — 凭证检查
// =============================================================================

export const blogPublishCredentialCheckTool = buildTool({
  name: 'blog_publish_credential_check',
  description:
    '【BlogPublish】检查各发布平台的 API 凭证配置状态。列出已配置和缺失的凭证，' +
    '帮助用户了解哪些平台可以立即发布，哪些需要先配置凭证',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const statuses = blogPublishService.checkCredentialStatus()

      const lines: string[] = [
        '🔑 发布平台凭证检查',
        '',
      ]

      for (const s of statuses) {
        const icon = s.configured ? '✅' : '❌'
        lines.push(`  ${icon} ${s.label} (${s.platform})`)
        if (s.configured) {
          lines.push('     凭证已配置 ✓')
        } else {
          lines.push(`     缺失凭证: ${s.missingCredentials.join(', ')}`)
          lines.push(`     请使用 set_credential 设置以上凭证`)
        }
        lines.push('')
      }

      const configured = statuses.filter((s) => s.configured).length
      lines.push(`📊 总计: ${configured}/${statuses.length} 平台已就绪`)

      if (configured > 0) {
        lines.push('', '💡 可用 blog_publish 直接发布到已就绪的平台')
      }

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(`凭证检查失败: ${err.message}`)
    }
  },
  isReadOnly: true,
})

// =============================================================================
// 工具 8: blog_publish_workflow — 启动预设发布工作流
// =============================================================================

export const blogPublishWorkflowTool = buildTool({
  name: 'blog_publish_workflow',
  description:
    '【BlogPublish】创建并启动一键多平台发布工作流。自动编排：' +
    '① 内容预处理（图片 CDN 上传 + 引用替换）→ ② 审批门（可跳过）→ ③ 多平台发布 → ④ 结果汇总。' +
    '支持通过自然语言触发（如"发布本周博客"）。' +
    '工作流执行进度可用 get_workflow_status 或 blog_publish_status 查看',
  inputJSONSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: '文章标题',
      },
      content: {
        type: 'string',
        description: '文章正文（Markdown 格式）',
      },
      platforms: {
        type: 'array',
        items: { type: 'string' },
        description: '目标平台列表（可选，留空自动检测已配置平台）',
      },
      summary: {
        type: 'string',
        description: '文章摘要（可选）',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: '标签列表（可选）',
      },
      asDraft: {
        type: 'boolean',
        description: '是否发布为草稿，默认 false',
      },
      skipApproval: {
        type: 'boolean',
        description: '是否跳过审批门直接发布，默认 false（需要审批）',
      },
      cdnPrefix: {
        type: 'string',
        description: 'CDN 上传路径前缀（可选）',
      },
    },
    required: ['title', 'content'],
  },
  handler: async (args: {
    title: string
    content: string
    platforms?: string[]
    summary?: string
    tags?: string[]
    asDraft?: boolean
    skipApproval?: boolean
    cdnPrefix?: string
  }) => {
    try {
      const title = String(args.title)
      const content = String(args.content)

      if (!title.trim()) return formatToolError('标题不能为空')
      if (!content.trim()) return formatToolError('内容不能为空')

      // 确定目标平台
      let platformList: string[]
      if (args.platforms && args.platforms.length > 0) {
        platformList = args.platforms
      } else {
        const credStatus = blogPublishService.checkCredentialStatus()
        platformList = credStatus.filter((c) => c.configured).map((c) => c.platform)
        if (platformList.length === 0) {
          return formatToolError('未检测到任何已配置的发布平台。请先用 set_credential 配置凭证')
        }
      }

      // 创建工作流步骤
      const steps: WorkflowStepDef[] = [
        // s1: 内容预处理（图片上传 + CDN 替换）
        {
          id: 's1_prepare',
          name: '内容预处理',
          description: '扫描 Markdown 图片引用，上传到 CDN 并替换',
          handler: 'tool',
          config: {
            tool: 'blog_prepare_publish',
            prompt: JSON.stringify({ content, title, cdnPrefix: args.cdnPrefix || 'blog-images' }),
          },
          dependsOn: [],
        },
      ]

      // s2: 审批门（可选）
      if (!args.skipApproval) {
        steps.push({
          id: 's2_gate',
          name: '发布审批',
          description: `确认发布「${title}」到 ${platformList.join(', ')}`,
          handler: 'gate',
          config: {
            message: `📝 确认发布「${title}」\n\n🎯 目标平台: ${platformList.join(', ')}\n📏 字数: ${content.length}\n🏷 标签: ${(args.tags || []).join(', ') || '(无)'}`,
            preview: content.substring(0, 500),
            options: ['approve', 'reject'],
          },
          dependsOn: ['s1_prepare'],
        })
      }

      // s3: 执行发布
      steps.push({
        id: 's3_publish',
        name: '多平台发布',
        description: `执行发布到 ${platformList.join(', ')}`,
        handler: 'tool',
        config: {
          tool: 'blog_publish',
          prompt: JSON.stringify({
            title,
            content, // 将被预处理后的内容替换
            platforms: platformList,
            summary: args.summary,
            tags: args.tags,
            asDraft: args.asDraft ?? false,
            requireApproval: false, // 工作流中已处理审批
          }),
        },
        dependsOn: args.skipApproval ? ['s1_prepare'] : ['s2_gate'],
      })

      // s4: 结果汇总
      steps.push({
        id: 's4_summary',
        name: '发布结果',
        description: '汇总发布结果',
        handler: 'tool',
        config: {
          tool: 'blog_publish_status',
          prompt: JSON.stringify({}),
        },
        dependsOn: ['s3_publish'],
      })

      // 创建工作流定义
      const def: WorkflowDef = {
        id: `wf_pub_${Date.now()}`,
        name: `一键发布: ${title.substring(0, 30)}`,
        description: `发布「${title}」到 ${platformList.join(', ')}`,
        steps,
        tags: ['publish', 'blog', 'auto'],
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        maxConcurrency: 1,
      }

      // 校验工作流
      const validation = validateWorkflow(def)
      if (!validation.valid) {
        const errors = validation.issues
          .filter((i) => i.severity === 'error')
          .map((i) => `  ⛔ [${i.stepId || '全局'}] ${i.message}`)
          .join('\n')
        return formatToolError(`工作流校验失败:\n${errors}`)
      }

      // 保存并启动
      workflowStore.saveDefinition(def)

      const scheduler = getWorkflowScheduler()
      scheduler.startRun(def, title)

      const platformLabels = platformList.map((p) => PLATFORM_LABELS[p as PublishPlatform] || p).join(', ')

      return formatToolResult(
        `🚀 一键发布工作流已启动！

📌 ${title}
🎯 ${platformLabels}
📊 工作流 ID: ${def.id}
${args.skipApproval ? '✅ 审批已跳过，将直接发布' : '⏸️ 等待审批门确认'}

用以下命令查看进度:
- get_workflow_status workflowId="${def.id}" detailed=true
- blog_publish_status`,
      )
    } catch (err: any) {
      return formatToolError(`启动发布工作流失败: ${err.message}`)
    }
  },
  isReadOnly: false,
})
