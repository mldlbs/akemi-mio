import { exec } from 'child_process'
import { promisify } from 'util'
import { buildTool, formatToolResult, formatToolError } from '../types'
import { PROJECT_ROOT } from '../utils/workspace'

const asyncExec = promisify(exec)

async function safeExec(cmd: string, timeout: number, fallback: string): Promise<string> {
  try {
    const { stdout } = await asyncExec(cmd, { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout })
    return stdout.trim()
  } catch {
    return fallback
  }
}

export const analyzeCodebaseTool = buildTool({
  name: 'analyze_codebase',
  description: '分析项目状态：测试结果、lint 错误、TODO 数量',
  inputJSONSchema: {
    type: 'object',
    properties: {
      quick: { type: 'boolean', description: '快速检查（不执行完整测试）' },
    },
    required: [],
  },
  handler: async (args: { quick?: boolean }) => {
    try {
      let report = ''
      const isQuick = args.quick !== false

      report += '【项目状态分析】\n'

      const todos = await safeExec('git grep -n "TODO\\|FIXME\\|HACK" -- "*.ts" "*.tsx" "*.js" "*.jsx" 2>nul || echo 0', 10000, '0')
      const todoCount = todos === '0' || todos === '' ? 0 : todos.split('\n').length
      report += `- TODO/FIXME: ${todoCount} 处\n`

      if (!isQuick) {
        const testOut = await safeExec('npx vitest run --reporter=verbose 2>&1', 60000, '')
        if (testOut) {
          const lines = testOut.split('\n')
          const passLine = lines.find((l) => l.includes('Tests') && l.includes('passed'))
          report += `- 测试结果: ${passLine || testOut.slice(-200)}\n`
        } else {
          report += '- 测试结果: 无输出\n'
        }
      }

      const gitStatus = await safeExec('git status --short 2>&1', 5000, '')
      const modifiedCount = gitStatus ? gitStatus.split('\n').filter(Boolean).length : 0
      report += `- 未提交修改: ${modifiedCount} 个文件\n`

      return formatToolResult(report.trim())
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})
