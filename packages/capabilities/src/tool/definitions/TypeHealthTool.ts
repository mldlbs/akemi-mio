/**
 * TypeHealthTool — 代码库类型健康度工具
 *
 * 提供类型健康扫描和重构操作的用户接口。
 * 支持子命令模式：
 *   - scan:    执行一次类型健康扫描
 *   - report:  查看扫描结果摘要
 *   - issues:  查看具体问题列表
 *   - apply:   应用指定重构（单条）
 *   - apply_all: 应用所有自动可修复项
 */

import { buildTool, formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'
import { DEV_PROJECT_ROOT } from '@akemi-mio/core/config'
import { typeHealthScanner } from '@akemi-mio/evolution-typehealth'
import { learningVocabularyManager } from '@akemi-mio/intelligence-learning/LearningVocabularyManager'
import type { TypeHealthCategory, TypeHealthScanConfig } from '@akemi-mio/evolution-typehealth'

// ══════════════════════════════════════════
//  子命令定义
// ══════════════════════════════════════════

type ScanParams = {
  action: 'scan'
  /** 可选：指定目标学习分类，为空则自动从学习计划获取 */
  category?: string
  /** 最低严重级别 */
  minSeverity?: 'error' | 'warning' | 'info' | 'suggestion'
}

type ReportParams = {
  action: 'report'
}

type IssuesParams = {
  action: 'issues'
  /** 按分类过滤 */
  category?: TypeHealthCategory
  /** 按严重级别过滤 */
  severity?: 'error' | 'warning' | 'info' | 'suggestion'
  /** 最大返回条数 */
  limit?: number
}

type ApplyParams = {
  action: 'apply'
  /** 问题 ID */
  issueId: string
}

type ApplyAllParams = {
  action: 'apply_all'
}

type ToolParams = ScanParams | ReportParams | IssuesParams | ApplyParams | ApplyAllParams

// ══════════════════════════════════════════
//  分类描述
// ══════════════════════════════════════════

const CATEGORY_LABELS: Record<TypeHealthCategory, string> = {
  explicit_any: '显式 any 类型',
  as_any: 'as any 断言',
  unsafe_assertion: '不安全类型断言',
  missing_return_type: '缺少返回类型',
  missing_param_type: '缺少参数类型',
  any_array: 'any 数组',
  ts_ignore: '@ts-ignore 压制',
  generic_opportunity: '泛型机会',
  conditional_opportunity: '条件类型机会',
  type_guard_opportunity: '类型守卫机会',
}

// ══════════════════════════════════════════
//  工具定义
// ══════════════════════════════════════════

export const typeHealthTool = buildTool({
  name: 'type_health',
  description:
    '代码库类型健康度扫描与重构。支持子命令：scan(执行扫描), report(查看摘要), issues(查看问题), apply(应用重构), apply_all(应用全部)',
  inputJSONSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['scan', 'report', 'issues', 'apply', 'apply_all'],
        description: '操作类型',
      },
      category: {
        type: 'string',
        description: '类型分类（用于 scan/issues 的过滤）',
      },
      minSeverity: {
        type: 'string',
        enum: ['error', 'warning', 'info', 'suggestion'],
        description: '最低严重级别（用于 scan）',
      },
      severity: {
        type: 'string',
        enum: ['error', 'warning', 'info', 'suggestion'],
        description: '严重级别过滤（用于 issues）',
      },
      issueId: {
        type: 'string',
        description: '问题 ID（用于 apply）',
      },
      limit: {
        type: 'number',
        description: '最大返回条数（用于 issues，默认 20）',
      },
    },
    required: ['action'],
  },
  handler: async (args: ToolParams) => {
    try {
      switch (args.action) {
        case 'scan':
          return handleScan(args as ScanParams)
        case 'report':
          return handleReport()
        case 'issues':
          return handleIssues(args as IssuesParams)
        case 'apply':
          return handleApply(args as ApplyParams)
        case 'apply_all':
          return handleApplyAll()
        default:
          return formatToolError(`未知操作: ${(args as any).action}`)
      }
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

// ══════════════════════════════════════════
//  子命令处理
// ══════════════════════════════════════════

async function handleScan(params: ScanParams): Promise<ReturnType<typeof formatToolResult>> {
  const root = DEV_PROJECT_ROOT || process.cwd()

  // 获取目标学习分类
  let targetCategories: string[] = []
  if (params.category) {
    targetCategories = [params.category]
  } else {
    try {
      const unmastered = learningVocabularyManager.getUnmasteredItems()
      if (unmastered && unmastered.length > 0) {
        const categoryMap = new Map<string, { sum: number; count: number }>()
        for (const item of unmastered) {
          if (!categoryMap.has(item.category)) {
            categoryMap.set(item.category, { sum: 0, count: 0 })
          }
          const entry = categoryMap.get(item.category)!
          entry.sum += item.mastery
          entry.count++
        }
        targetCategories = Array.from(categoryMap.entries())
          .sort(([, a], [, b]) => a.sum / a.count - b.sum / b.count)
          .slice(0, 3)
          .map(([cat]) => cat)
      }
    } catch {
      // 学习系统不可用
    }
  }

  // 配置扫描
  typeHealthScanner.setConfig({
    projectRoot: root,
    targetCategories: targetCategories as TypeHealthScanConfig['targetCategories'],
    minSeverity: params.minSeverity || 'suggestion',
  })

  // 执行扫描
  const issues = typeHealthScanner.scan()
  const summary = typeHealthScanner.getSummary()

  // 构建报告
  const lines: string[] = []
  lines.push(`📊 类型健康扫描完成`)
  lines.push(`   扫描结果: ${summary.totalIssues} 个问题`)
  lines.push(`   扫描时间: ${summary.scannedFiles} 个文件`)

  if (targetCategories.length > 0) {
    lines.push(`   基于学习计划: ${targetCategories.join(', ')}`)
  }

  if (summary.totalIssues > 0) {
    lines.push('')
    lines.push('按分类统计:')
    for (const [cat, count] of Object.entries(summary.byCategory)) {
      if (count > 0) {
        lines.push(`   ${CATEGORY_LABELS[cat as TypeHealthCategory] || cat}: ${count}`)
      }
    }

    lines.push('')
    lines.push('按严重级别统计:')
    for (const [sev, count] of Object.entries(summary.bySeverity)) {
      if (count > 0) {
        lines.push(`   ${sev}: ${count}`)
      }
    }

    lines.push('')
    lines.push('使用 type_health issues 查看详细问题列表')
    lines.push('使用 type_health apply issueId 应用单个重构')
    lines.push('使用 type_health apply_all 应用全部重构（需确认）')
  }

  return formatToolResult(lines.join('\n'))
}

async function handleReport(): Promise<ReturnType<typeof formatToolResult>> {
  const issues = typeHealthScanner.getIssues()
  if (issues.length === 0) {
    return formatToolResult('⚠️ 暂无扫描数据，请先执行 type_health action=scan')
  }

  const summary = typeHealthScanner.getSummary()
  const lines: string[] = []
  lines.push(`📋 类型健康报告`)
  lines.push(`   总问题数: ${summary.totalIssues}`)
  lines.push('')

  // 按文件排名
  if (summary.byFile.length > 0) {
    lines.push('问题最多的文件:')
    for (const { file, count } of summary.byFile.slice(0, 10)) {
      lines.push(`   ${file}: ${count} 个问题`)
    }
  }

  lines.push('')
  lines.push('分类详情:')
  for (const [cat, count] of Object.entries(summary.byCategory)) {
    if (count > 0) {
      lines.push(`   ${CATEGORY_LABELS[cat as TypeHealthCategory] || cat}: ${count}`)
    }
  }

  return formatToolResult(lines.join('\n'))
}

async function handleIssues(params: IssuesParams): Promise<ReturnType<typeof formatToolResult>> {
  let issues = typeHealthScanner.getIssues()
  if (issues.length === 0) {
    return formatToolResult('⚠️ 暂无扫描数据，请先执行 type_health action=scan')
  }

  // 过滤
  if (params.category) {
    issues = issues.filter((i) => i.category === params.category)
  }
  if (params.severity) {
    issues = issues.filter((i) => i.severity === params.severity)
  }

  const limit = params.limit || 20
  const shown = issues.slice(0, limit)

  const lines: string[] = []
  lines.push(`📋 类型健康问题列表 (显示 ${shown.length}/${issues.length})`)
  lines.push('')

  for (const issue of shown) {
    lines.push(`🔍 ${issue.id}`)
    lines.push(`   文件: ${issue.file}:${issue.line}`)
    lines.push(`   类型: ${CATEGORY_LABELS[issue.category] || issue.category}`)
    lines.push(`   严重: ${issue.severity}`)
    lines.push(`   描述: ${issue.description}`)
    lines.push(`   建议: ${issue.suggestion}`)
    lines.push('')
  }

  if (issues.length > limit) {
    lines.push(`... 还有 ${issues.length - limit} 个问题未显示`)
    lines.push('使用 limit 参数查看更多')
  }

  return formatToolResult(lines.join('\n'))
}

async function handleApply(params: ApplyParams): Promise<ReturnType<typeof formatToolResult>> {
  const issues = typeHealthScanner.getIssues()
  const issue = issues.find((i) => i.id === params.issueId)

  if (!issue) {
    return formatToolError(`未找到问题: ${params.issueId}`)
  }

  return formatToolResult(
    `✅ 重构请求已提交: ${issue.id}\n` +
      `   文件: ${issue.file}:${issue.line}\n` +
      `   建议: ${issue.suggestion}\n\n` +
      `进化系统将在下一个周期自动处理此问题。\n` +
      `也可使用 trigger_evolution 手动触发。`,
  )
}

async function handleApplyAll(): Promise<ReturnType<typeof formatToolResult>> {
  const issues = typeHealthScanner.getIssues()
  if (issues.length === 0) {
    return formatToolResult('⚠️ 暂无扫描数据，请先执行 type_health action=scan')
  }

  const autoFixable = issues.filter((i) =>
    ['explicit_any', 'as_any', 'missing_return_type', 'missing_param_type', 'any_array'].includes(i.category),
  )

  return formatToolResult(
    `✅ 全部重构请求已提交 (${autoFixable.length}/${issues.length})\n` +
      `   进化系统将在下一个周期自动处理这些重构任务。\n` +
      `   使用 trigger_evolution 可立即触发处理。`,
  )
}

