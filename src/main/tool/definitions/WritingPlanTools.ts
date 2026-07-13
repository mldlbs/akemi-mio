/**
 * WritingPlanTools — 写作计划智能编排 Agent 工具定义
 *
 * 提供工具：
 * - writing_plan_analyze_design — 解析设计文档，提取齿轮三角要素
 * - writing_plan_compare_chapters — 对比章节与设计文档差异
 * - writing_plan_start — 启动写作计划（分析+对比+分解全流程）
 * - writing_plan_status — 查询写作计划状态和进度
 * - writing_plan_update_task — 更新任务状态或添加用户约束
 * - writing_plan_quality_check — 质量校验指定章节
 */
import { existsSync, readdirSync, statSync } from 'fs'
import { resolve } from 'path'
import { buildTool, formatToolResult, formatToolError } from '../types'
import { getMemoryService, getWritingPlanAgent } from '../deps'

// ===== 辅助函数 =====

/**
 * 收集指定目录下的章节文件。
 * 匹配模式：文件名包含数字且以 .md 结尾。
 */
function collectChapterFiles(dirPath: string, start: number, end: number): string[] {
  try {
    const fullPath = resolve(process.cwd(), dirPath)
    if (!existsSync(fullPath) || !statSync(fullPath).isDirectory()) return []

    const files = readdirSync(fullPath)
    const chapterFiles: string[] = []

    for (const file of files) {
      if (!file.endsWith('.md')) continue
      const match = file.match(/(\d+)/)
      if (!match) continue
      const num = parseInt(match[1], 10)
      if (num >= start && num <= end) {
        chapterFiles.push(`${dirPath}/${file}`)
      }
    }

    return chapterFiles.sort((a, b) => {
      const na = parseInt(a.match(/(\d+)/)?.[1] || '0', 10)
      const nb = parseInt(b.match(/(\d+)/)?.[1] || '0', 10)
      return na - nb
    })
  } catch {
    return []
  }
}

// ===== 工具定义 =====

/**
 * writing_plan_analyze_design — 解析设计文档
 *
 * 读取并分析小说设计文档，提取齿轮三角关键要素（核心主题、角色定位、冲突体系、
 * 工业美学、叙事风格、时代背景）以及各章节写作指南。
 */
export const writingPlanAnalyzeDesignTool = buildTool({
  name: 'writing_plan_analyze_design',
  description:
    '解析小说设计文档，提取齿轮三角核心要素（主题、角色、冲突、工业美学、叙事风格、背景）及各章节写作指南。' +
    '首次执行写作计划时应先调用此工具。返回结构化分析结果，作为后续对比和任务分解的基础。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      designDocPath: {
        type: 'string',
        description:
          '设计文档路径（相对于项目根目录），如 "docs/工业颂歌_完整设计体系.md"。支持 docs/ 目录或项目根目录下的文件。',
      },
    },
    required: ['designDocPath'],
  },
  handler: async (args: { designDocPath: string }) => {
    try {
      const agent = getWritingPlanAgent()
      if (!agent) return formatToolError('WritingPlanAgent 尚未初始化')

      const result = await agent.analyzeDesignDocument(args.designDocPath)
      if (result.error) return formatToolError(result.error)

      const analysis = result.data
      const lines: string[] = [
        `📖 故事: ${analysis.storyName}`,
        `📊 分析置信度: ${Math.round(analysis.confidence * 100)}%`,
        '',
        '🎯 【齿轮三角核心要素】',
        `  主题: ${analysis.gearTriangle.theme}`,
        `  角色(${analysis.gearTriangle.characters.length}):`,
        ...analysis.gearTriangle.characters.map((c: any) => `    - ${c.name} (${c.role}): ${c.arc}`),
        `  冲突: ${analysis.gearTriangle.conflicts.join('、')}`,
        `  工业美学: ${analysis.gearTriangle.industrialAesthetics.join('、')}`,
        `  叙事风格: ${analysis.gearTriangle.narrativeStyle}`,
        `  背景设定: ${analysis.gearTriangle.setting}`,
      ]

      if (analysis.chapterGuidelines.length > 0) {
        lines.push('', '📑 【章节指南】')
        for (const g of analysis.chapterGuidelines) {
          lines.push(`  第${g.chapterNumber}章 "${g.title}":`)
          lines.push(`    关键点: ${g.keyPoints.join(', ')}`)
          lines.push(`    必需要素: ${g.requiredElements.join(', ')}`)
        }
      }

      if (analysis.styleRequirements.length > 0) {
        lines.push('', '🎨 【风格要求】')
        for (const s of analysis.styleRequirements) {
          lines.push(`  - ${s}`)
        }
      }

      lines.push('', '💡 建议下一步: 使用 writing_plan_compare_chapters 对比现有章节')
      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

/**
 * writing_plan_compare_chapters — 章节对比
 *
 * 将现有章节内容与设计文档要求逐条对比，找出角色偏差、情节不一致、
 * 风格不匹配、要素缺失、结构问题等差异，生成问题清单。
 */
export const writingPlanCompareChaptersTool = buildTool({
  name: 'writing_plan_compare_chapters',
  description:
    '对比现有章节与设计文档要求的差异，生成问题清单。' +
    '需先调用 writing_plan_analyze_design 获得设计分析结果。' +
    '返回包含逐章差异、偏差评分、汇总统计的详细报告。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      designAnalysisJson: {
        type: 'string',
        description:
          'writing_plan_analyze_design 返回的完整结构化 JSON（包含 gearTriangle、chapterGuidelines 等）。' +
          '从 analyze_design 的结果中复制此 JSON。',
      },
      chapterDir: {
        type: 'string',
        description: '章节文件所在目录，如 "docs/chapters"。',
      },
      chapterStart: {
        type: 'number',
        description: '起始章节号（默认 19）',
      },
      chapterEnd: {
        type: 'number',
        description: '结束章节号（默认 27）',
      },
    },
    required: ['designAnalysisJson', 'chapterDir'],
  },
  handler: async (args: { designAnalysisJson: string; chapterDir: string; chapterStart?: number; chapterEnd?: number }) => {
    try {
      const agent = getWritingPlanAgent()
      if (!agent) return formatToolError('WritingPlanAgent 尚未初始化')

      let designAnalysis: any
      try {
        designAnalysis = JSON.parse(args.designAnalysisJson)
      } catch {
        return formatToolError('designAnalysisJson 不是有效的 JSON 字符串。请从 writing_plan_analyze_design 的结果中复制完整的 JSON。')
      }

      const start = args.chapterStart ?? 19
      const end = args.chapterEnd ?? 27
      const chapterPaths = collectChapterFiles(args.chapterDir, start, end)

      if (chapterPaths.length === 0) {
        return formatToolError(`在 ${args.chapterDir} 中未找到第${start}-${end}章的 .md 文件`)
      }

      const result = await agent.compareChapters(designAnalysis, chapterPaths)
      if (result.error) return formatToolError(result.error)

      const cr = result.data
      const lines: string[] = [
        `📊 对比结果: ${cr.storyName}`,
        `📚 分析章节: 第${cr.chapterRange.start}-${cr.chapterRange.end}章 (共 ${cr.chapterDiffs.length} 章)`,
        '',
        `⚠️ 问题汇总: ${cr.summary.totalIssues} 个问题`,
        `  🔴 严重: ${cr.summary.criticalCount}`,
        `  🟠 重要: ${cr.summary.majorCount}`,
        `  🟢 轻微: ${cr.summary.minorCount}`,
      ]

      if (cr.summary.topIssues.length > 0) {
        lines.push('', '🏆 最需关注的问题:')
        for (const issue of cr.summary.topIssues) {
          lines.push(`  - ${issue}`)
        }
      }

      // 逐章摘要
      lines.push('', '📑 【逐章偏差】')
      for (const d of cr.chapterDiffs) {
        const critCount = d.issues.filter((i: any) => i.severity === 'critical').length
        const majCount = d.issues.filter((i: any) => i.severity === 'major').length
        const sev = critCount > 0 ? '🔴' : majCount > 0 ? '🟠' : '🟢'
        lines.push(`  ${sev} 第${d.chapterNumber}章 "${d.chapterTitle}" (偏差: ${d.deviationScore}%)`)
        for (const issue of d.issues.slice(0, 3)) {
          const icon = issue.severity === 'critical' ? '🔴' : issue.severity === 'major' ? '🟠' : '🟢'
          lines.push(`    ${icon} [${issue.category}] ${issue.description.slice(0, 120)}`)
        }
        if (d.issues.length > 3) {
          lines.push(`    …及另外 ${d.issues.length - 3} 个问题`)
        }
      }

      lines.push('', '💡 建议下一步: 使用 writing_plan_start 自动创建重写计划')
      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

/**
 * writing_plan_start — 启动写作计划
 *
 * 一键全流程：分析设计文档 → 对比章节 → 分解重写任务 → 创建开发计划。
 * 返回完整的重写计划，包含分层子任务和依赖关系。
 */
export const writingPlanStartTool = buildTool({
  name: 'writing_plan_start',
  description:
    '启动写作计划全流程：先分析设计文档提取齿轮三角要素，再对比现有章节差异，' +
    '然后将重写工作自动分解为分层子任务（调整大纲→重写章节→质量校验），' +
    '最后在计划管理器中创建开发计划。无需预先调用其他工具。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      designDocPath: {
        type: 'string',
        description: '设计文档路径，如 "docs/工业颂歌_完整设计体系.md"',
      },
      chapterDir: {
        type: 'string',
        description: '章节文件所在目录，如 "docs/chapters"',
      },
      chapterStart: {
        type: 'number',
        description: '起始章节号（默认 19）',
      },
      chapterEnd: {
        type: 'number',
        description: '结束章节号（默认 27）',
      },
      createPlanManagerPlan: {
        type: 'boolean',
        description: '是否同时在 Plan Manager 中创建开发计划步骤（默认 true）',
      },
    },
    required: ['designDocPath', 'chapterDir'],
  },
  handler: async (args: {
    designDocPath: string
    chapterDir: string
    chapterStart?: number
    chapterEnd?: number
    createPlanManagerPlan?: boolean
  }) => {
    try {
      const agent = getWritingPlanAgent()
      if (!agent) return formatToolError('WritingPlanAgent 尚未初始化')

      // Step 1: 分析设计文档
      const designResult = await agent.analyzeDesignDocument(args.designDocPath)
      if (designResult.error) return formatToolError(`设计文档分析失败: ${designResult.error}`)
      const designAnalysis = designResult.data

      // Step 2: 收集章节文件并对比
      const start = args.chapterStart ?? 19
      const end = args.chapterEnd ?? 27
      const chapterPaths = collectChapterFiles(args.chapterDir, start, end)

      if (chapterPaths.length === 0) {
        return formatToolError(`在 ${args.chapterDir} 中未找到第${start}-${end}章的 .md 文件`)
      }

      const compareResult = await agent.compareChapters(designAnalysis, chapterPaths)
      if (compareResult.error) return formatToolError(`章节对比失败: ${compareResult.error}`)

      // Step 3: 分解重写任务
      const decomposeResult = await agent.decomposeRewrite(compareResult.data, designAnalysis)
      if (decomposeResult.error) return formatToolError(`任务分解失败: ${decomposeResult.error}`)

      const plan = decomposeResult.data

      // Step 4: 可选 — 在 Plan Manager 中创建步骤
      let managerPlanId: string | null = null
      if (args.createPlanManagerPlan !== false) {
        managerPlanId = agent.createPlanSteps(plan)
      }

      // 构建结果输出
      const lines: string[] = [
        `✅ 写作计划已启动!`,
        `📖 ${plan.storyName}`,
        `🆔 计划 ID: ${plan.planId}`,
        `📊 共 ${plan.tasks.length} 个子任务`,
        `📚 涉及章节: 第${compareResult.data.chapterRange.start}-${compareResult.data.chapterRange.end}章`,
        '',
        '📋 【计划概览】',
      ]

      const phaseLabels: Record<string, string> = {
        outline: '📐 调整大纲',
        rewrite: '✍️ 重写章节',
        quality_check: '✅ 质量校验',
      }

      const phases = ['outline', 'rewrite', 'quality_check']
      for (const phase of phases) {
        const phaseTasks = plan.tasks.filter((t: any) => t.phase === phase)
        if (phaseTasks.length > 0) {
          lines.push(`  ${phaseLabels[phase] || phase}:`)
          for (const task of phaseTasks) {
            const deps = task.dependencies.length > 0 ? ` (依赖: ${task.dependencies.join(', ')})` : ''
            lines.push(`    - ${task.title} [${task.id}]${deps}`)
          }
        }
      }

      if (managerPlanId) {
        lines.push('', `📋 已在 Plan Manager 中创建计划 (ID: ${managerPlanId})`)
      }

      lines.push('', '💡 提示:')
      lines.push('  - 使用 writing_plan_status 查看计划状态')
      lines.push('  - 使用 writing_plan_update_task 更新任务进度')
      lines.push('  - 使用 writing_plan_quality_check 进行质量校验')
      lines.push('  - 进度自动记录到 Memory 并自动触发下一阶段')

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

/**
 * writing_plan_status — 查询计划状态
 */
export const writingPlanStatusTool = buildTool({
  name: 'writing_plan_status',
  description:
    '查询写作计划的当前状态、各任务进度、当前执行阶段。' +
    '如果未提供 planId 则列出所有已保存的计划。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      planId: {
        type: 'string',
        description: '计划 ID（从 writing_plan_start 返回的 ID）。不提供则列出所有计划。',
      },
    },
    required: [],
  },
  handler: async (args: { planId?: string }) => {
    try {
      const agent = getWritingPlanAgent()
      if (!agent) return formatToolError('WritingPlanAgent 尚未初始化')

      if (args.planId) {
        // 查询特定计划
        const plan = agent.loadPlanFromMemory(args.planId)
        if (!plan) return formatToolError(`未找到计划: ${args.planId}`)

        const completed = plan.tasks.filter((t: any) => t.status === 'completed').length
        const inProgress = plan.tasks.filter((t: any) => t.status === 'in_progress').length
        const pending = plan.tasks.filter((t: any) => t.status === 'pending').length

        const statusLabels: Record<string, string> = {
          active: '🟢 进行中',
          paused: '🟡 已暂停',
          completed: '✅ 已完成',
        }

        const phaseLabels: Record<string, string> = {
          outline: '📐 调整大纲',
          rewrite: '✍️ 重写章节',
          quality_check: '✅ 质量校验',
        }

        const lines: string[] = [
          `📖 ${plan.storyName}`,
          `状态: ${statusLabels[plan.status] || plan.status}`,
          `当前阶段: ${phaseLabels[plan.currentPhase] || plan.currentPhase}`,
          `进度: ${plan.overallProgress}% (${completed}/${plan.tasks.length})`,
          '',
          '📋 【任务状态】',
        ]

        for (const task of plan.tasks) {
          const taskStatusIcon = task.status === 'completed' ? '✅' : task.status === 'in_progress' ? '🔄' : '⏳'
          const phase = phaseLabels[task.phase] || task.phase
          lines.push(`  ${taskStatusIcon} [${phase}] ${task.title} (第${task.chapterNumbers.join(', ')}章)`)
        }

        // 查询进度记录
        const records = agent.getProgressRecords(args.planId)
        if (records.length > 0) {
          lines.push('', '📝 【最近进度】')
          for (const r of records.slice(0, 5)) {
            const date = new Date(r.timestamp).toLocaleString('zh-CN')
            lines.push(`  [${date}] ${r.summary}`)
          }
        }

        // 查询用户约束
        const constraints = agent.getConstraints(args.planId)
        if (constraints.length > 0) {
          lines.push('', '📌 【用户约束】')
          for (const c of constraints) {
            lines.push(`  - ${c.description}: ${c.value}`)
          }
        }

        // 获取下一步任务
        if (plan.status === 'active') {
          const nextTask = agent.getNextPendingTask(plan)
          if (nextTask) {
            lines.push('', `👉 下一步: ${nextTask.title} (第${nextTask.chapterNumbers.join('、')}章)`)
          }
        }

        return formatToolResult(lines.join('\n'))
      }

      // 列出所有计划 — 从 Memory 搜索
      const ms = getMemoryService()
      if (!ms) return formatToolError('记忆服务暂不可用')

      const entries = ms.getEntries()
      const planIds = new Set<string>()

      for (const entry of entries) {
        if (entry.type !== 'writing_feedback') continue
        const match = entry.content.match(/writing_plan_state:(wp_[^:\s]+):/)
        if (match) planIds.add(match[1])
      }

      if (planIds.size === 0) {
        return formatToolResult('暂无写作计划。使用 writing_plan_start 创建新计划。')
      }

      const lines: string[] = ['📋 【写作计划列表】']
      for (const pid of planIds) {
        const plan = agent.loadPlanFromMemory(pid)
        if (plan) {
          const completed = plan.tasks.filter((t: any) => t.status === 'completed').length
          lines.push(`  🆔 ${pid}: ${plan.storyName} (${completed}/${plan.tasks.length} 完成, ${plan.status})`)
        }
      }
      lines.push('', '使用 writing_plan_status planId=<ID> 查看详情')

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

/**
 * writing_plan_update_task — 更新任务状态或添加用户约束
 */
export const writingPlanUpdateTaskTool = buildTool({
  name: 'writing_plan_update_task',
  description:
    '更新写作计划中的任务状态（pending/in_progress/completed/failed），' +
    '或为计划添加用户约束（优先级调整、跳过章节、重点关注等）。' +
    '任务完成后自动触发下一阶段、记录进度到 Memory 并更新总体进度。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      planId: {
        type: 'string',
        description: '计划 ID（从 writing_plan_start 或 writing_plan_status 获取）',
      },
      taskId: {
        type: 'string',
        description: '要更新的任务 ID。如果提供了 constraintType 则不需要此参数。',
      },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed', 'failed'] as any,
        description: '任务新状态',
      },
      constraintType: {
        type: 'string',
        enum: ['priority', 'skip_chapter', 'focus_aspect', 'custom'] as any,
        description: '添加用户约束的类型（不更新任务时使用）',
      },
      constraintDescription: {
        type: 'string',
        description: '约束描述（如 "优先修改第20章""跳过第25章""重点关注角色A"）',
      },
      constraintValue: {
        type: 'string',
        description: '约束的具体值',
      },
    },
    required: ['planId'],
  },
  handler: async (args: {
    planId: string
    taskId?: string
    status?: string
    constraintType?: string
    constraintDescription?: string
    constraintValue?: string
  }) => {
    try {
      const agent = getWritingPlanAgent()
      if (!agent) return formatToolError('WritingPlanAgent 尚未初始化')

      // 添加约束
      if (args.constraintType && args.constraintDescription) {
        agent.saveConstraint(args.planId, {
          type: args.constraintType as any,
          description: args.constraintDescription,
          value: args.constraintValue || args.constraintDescription,
          createdAt: Date.now(),
        })
        return formatToolResult(
          `✅ 已添加约束: ${args.constraintDescription}` +
          '\n\n此约束将在后续任务分解时自动参考。' +
          '\n使用 writing_plan_status 查看当前约束列表。',
        )
      }

      // 更新任务状态
      if (!args.taskId || !args.status) {
        return formatToolError('更新任务状态需要 taskId 和 status 参数，或提供 constraintType 添加约束')
      }

      if (!['pending', 'in_progress', 'completed', 'failed'].includes(args.status)) {
        return formatToolError('status 必须是 pending、in_progress、completed 或 failed')
      }

      const plan = agent.updateTaskStatus(args.planId, args.taskId, args.status)
      if (!plan) return formatToolError(`未找到计划: ${args.planId} 或任务: ${args.taskId}`)

      const task = plan.tasks.find((t: any) => t.id === args.taskId)
      const statusEmoji: Record<string, string> = {
        pending: '⏳', in_progress: '🔄', completed: '✅', failed: '❌',
      }

      const message: string[] = [
        `${statusEmoji[args.status] || ''} 任务 "${task?.title || args.taskId}" 已标记为 ${args.status}`,
        `总体进度: ${plan.overallProgress}%`,
        `当前阶段: ${plan.currentPhase}`,
      ]

      // 如果任务完成，显示下一步
      if (args.status === 'completed') {
        const nextTask = agent.getNextPendingTask(plan)
        if (nextTask) {
          message.push('', `👉 自动触发下一任务: ${nextTask.title}`)
          message.push(`   涉及章节: 第${nextTask.chapterNumbers.join('、')}章`)
        } else if (plan.status === 'completed') {
          message.push('', '🎉 所有任务已完成! 写作计划执行完毕。')
        }
      }

      return formatToolResult(message.join('\n'))
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

/**
 * writing_plan_quality_check — 质量校验
 */
export const writingPlanQualityCheckTool = buildTool({
  name: 'writing_plan_quality_check',
  description:
    '对指定章节进行质量校验，从风格一致性、角色完整性、情节连贯性、' +
    '氛围营造、对话质量五个维度评分（0-100），并生成问题清单和改进建议。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      designAnalysisJson: {
        type: 'string',
        description: '设计文档分析结果 JSON（从 writing_plan_analyze_design 或 writing_plan_start 获取）',
      },
      chapterPath: {
        type: 'string',
        description: '章节文件路径（相对于项目根目录），如 "docs/chapters/19.md"',
      },
      chapterNumber: {
        type: 'number',
        description: '章节号',
      },
      threshold: {
        type: 'number',
        description: '通过阈值（0-100，默认 70）。低于此分值的维度会被标记为问题。',
      },
    },
    required: ['designAnalysisJson', 'chapterPath', 'chapterNumber'],
  },
  handler: async (args: {
    designAnalysisJson: string
    chapterPath: string
    chapterNumber: number
    threshold?: number
  }) => {
    try {
      const agent = getWritingPlanAgent()
      if (!agent) return formatToolError('WritingPlanAgent 尚未初始化')

      let designAnalysis: any
      try {
        designAnalysis = JSON.parse(args.designAnalysisJson)
      } catch {
        return formatToolError('designAnalysisJson 不是有效的 JSON')
      }

      const result = await agent.qualityCheck(args.chapterPath, args.chapterNumber, designAnalysis, args.threshold ?? 70)
      if (result.error) return formatToolError(result.error)

      const report = result.data
      const statusIcon = report.passed ? '✅' : '❌'
      const lines: string[] = [
        `${statusIcon} 第${report.chapterNumber}章 "${report.chapterTitle}" 质量校验`,
        `总体评分: ${report.overallScore}/100${report.passed ? ' (通过)' : ` (未通过, 阈值${report.threshold})`}`,
        '',
        '📊 【维度评分】',
      ]

      for (const s of report.scores) {
        const dimLabels: Record<string, string> = {
          style_consistency: '风格一致性',
          character_completeness: '角色完整性',
          plot_coherence: '情节连贯性',
          atmosphere: '氛围营造',
          dialogue: '对话质量',
        }
        const label = dimLabels[s.dimension] || s.dimension
        const bar = '█'.repeat(Math.floor(s.score / 10)) + '░'.repeat(10 - Math.floor(s.score / 10))
        lines.push(`  ${label}: ${s.score}/100 ${bar}`)
        if (s.issues.length > 0) {
          for (const issue of s.issues.slice(0, 2)) {
            lines.push(`    ⚠️ ${issue}`)
          }
        }
        if (s.suggestions.length > 0 && s.score < (args.threshold ?? 70)) {
          for (const sug of s.suggestions.slice(0, 1)) {
            lines.push(`    💡 ${sug}`)
          }
        }
      }

      if (report.criticalIssues.length > 0) {
        lines.push('', '🔴 【关键问题】')
        for (const issue of report.criticalIssues) {
          lines.push(`  - ${issue}`)
        }
      }

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

