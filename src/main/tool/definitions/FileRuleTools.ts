/**
 * FileRuleTools — 对话记忆驱动的文件归档规则 MCP 工具
 *
 * 这些工具供 Agent 在对话中调用：
 * - remember_file_rule: 用户提及文件归类意图时，提取并存储规则
 * - list_file_rules: 列出所有已存储的归档规则
 * - delete_file_rule: 删除/禁用一条归档规则
 *
 * Agent 调用时机示例：
 * 用户："把 reports 目录下所有 PDF 放到 documents/reports"
 * → Agent 调用 remember_file_rule({ filePattern: "reports/**\/*.pdf", targetPath: "documents/reports/" })
 */
import { buildTool, formatToolResult, formatToolError } from '../types'
import { fileRuleMemoryAdapter } from '../../evolution/file-organizer/FileRuleMemoryAdapter'

// ===== remember_file_rule — 记住一条文件归档规则 =====

export const rememberFileRuleTool = buildTool({
  name: 'remember_file_rule',
  description:
    '当用户明确表达文件归类意图时调用。将用户指定的（文件模式, 目标目录）规则存入记忆系统，' +
    '后续进化周期会自动识别并移动匹配的文件。' +
    '示例：用户说"把 PDF 文件放到 documents/reports" → 调用此工具保存规则。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      filePattern: {
        type: 'string',
        description:
          'glob 文件匹配模式，如 "*.pdf"、"reports/**\/*.ts"、"**\/*.{jpg,png}"。"*" 匹配单层，"**" 匹配任意层',
      },
      targetPath: {
        type: 'string',
        description: '目标目录路径（相对于项目根目录），如 "documents/reports/"、"src/utils/"',
      },
      description: {
        type: 'string',
        description:
          '人类可读的规则描述，如 "将所有 PDF 文件整理到 reports 目录"。会自动添加前缀',
      },
      sourceText: {
        type: 'string',
        description: '用户的原始指令文本，用于追溯来源。可选',
      },
    },
    required: ['filePattern', 'targetPath', 'description'],
  },
  handler: async (args: {
    filePattern: string
    targetPath: string
    description: string
    sourceText?: string
  }) => {
    try {
      const memoryId = fileRuleMemoryAdapter.saveRule(
        args.filePattern,
        args.targetPath,
        args.description,
        args.sourceText,
      )

      if (!memoryId) {
        return formatToolError('记忆服务不可用，无法保存规则')
      }

      const stats = fileRuleMemoryAdapter.getStats()

      return formatToolResult(
        `✅ 已记住文件归档规则\n` +
          `- 模式: ${args.filePattern}\n` +
          `- 目标: ${args.targetPath}\n` +
          `- 描述: ${args.description}\n` +
          `- 记忆 ID: ${memoryId}\n` +
          `\n当前共有 ${stats.active} 条活跃规则，` +
          `累计成功 ${stats.totalSuccess} 次，失败 ${stats.totalFail} 次。`,
      )
    } catch (err: any) {
      return formatToolError(`保存归档规则失败: ${err.message}`)
    }
  },
  isReadOnly: false,
})

// ===== list_file_rules — 列出所有归档规则 =====

export const listFileRulesTool = buildTool({
  name: 'list_file_rules',
  description: '列出所有已保存的文件归档规则，包含匹配模式、目标目录和执行统计。',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const rules = fileRuleMemoryAdapter.getAllRules()

      if (rules.length === 0) {
        return formatToolResult('当前没有已保存的文件归档规则。\n\n提示：当你说"把 XXX 文件放到 YYY 目录"时，我会记住这条规则并在后续自动整理。')
      }

      const active = rules.filter((r) => !r.rule.disabled)
      const disabled = rules.filter((r) => r.rule.disabled)

      const lines: string[] = [
        `📁 文件归档规则（共 ${rules.length} 条）`,
        `活跃: ${active.length} | 已禁用: ${disabled.length}`,
        '',
      ]

      if (active.length > 0) {
        lines.push('── 活跃规则 ──')
        for (const entry of active) {
          const r = entry.rule
          const since = new Date(entry.createdAt).toLocaleDateString('zh-CN')
          const lastRun = r.lastAppliedAt
            ? new Date(r.lastAppliedAt).toLocaleString('zh-CN')
            : '尚未执行'
          lines.push(
            `  [${entry.memoryId.slice(-8)}] ${r.description}` +
              `\n    模式: ${r.filePattern} → ${r.targetPath}` +
              `\n    执行: ✅${r.successCount}次 ❌${r.failCount}次 | 最近: ${lastRun}` +
              `\n    来源: "${r.sourceText.slice(0, 60)}" | 创建于 ${since}`,
          )
        }
      }

      if (disabled.length > 0) {
        lines.push('')
        lines.push('── 已禁用规则 ──')
        for (const entry of disabled) {
          lines.push(`  [${entry.memoryId.slice(-8)}] ${entry.rule.description}`)
        }
      }

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(`查询归档规则失败: ${err.message}`)
    }
  },
  isReadOnly: true,
})

// ===== delete_file_rule — 删除/禁用一条归档规则 =====

export const deleteFileRuleTool = buildTool({
  name: 'delete_file_rule',
  description: '禁用一条已保存的文件归档规则。规则被禁用后，进化周期将不再应用它。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      ruleId: {
        type: 'string',
        description: '规则的记忆 ID（来自 list_file_rules 的输出）',
      },
    },
    required: ['ruleId'],
  },
  handler: async (args: { ruleId: string }) => {
    try {
      const success = fileRuleMemoryAdapter.deleteRule(args.ruleId)
      if (!success) {
        return formatToolError(`未找到规则: ${args.ruleId}，或该规则已被删除`)
      }
      return formatToolResult(`已禁用归档规则: ${args.ruleId}`)
    } catch (err: any) {
      return formatToolError(`删除归档规则失败: ${err.message}`)
    }
  },
  isReadOnly: false,
})
