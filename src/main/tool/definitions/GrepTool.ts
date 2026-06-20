import { readFileSync, readdirSync } from 'fs'
import { join, relative } from 'path'
import { buildTool, formatToolResult, formatToolError } from '../types'
import { PROJECT_ROOT } from '../utils/workspace'

const MAX_OUTPUT = 3000
const MAX_FILES = 100

function grepCode(pattern: string, include?: string): string {
  const results: string[] = []
  let fileCount = 0

  const walk = (dir: string): void => {
    if (fileCount >= MAX_FILES) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (fileCount >= MAX_FILES) return
      const p = join(dir, e.name)
      if (!p.startsWith(PROJECT_ROOT)) continue
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      if (e.isDirectory()) {
        walk(p)
        continue
      }
      if (!e.isFile()) continue
      if (include) {
        const globRe = new RegExp('^' + include.replace(/\*/g, '.*') + '$')
        if (!globRe.test(e.name)) continue
      }
      fileCount++
      try {
        const content = readFileSync(p, 'utf-8')
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(pattern)) {
            results.push(`${relative(PROJECT_ROOT, p)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
          }
        }
      } catch {
        /* skip binary */
      }
    }
  }

  walk(PROJECT_ROOT)
  const output = results.join('\n')
  return output.slice(0, MAX_OUTPUT) || '未找到匹配'
}

export const grepTool = buildTool({
  name: 'grep',
  description: '在项目中搜索代码内容',
  inputJSONSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索模式' },
      include: { type: 'string', description: '文件过滤，如 "*.ts"' },
    },
    required: ['pattern'],
  },
  handler: async (args: { pattern: string; include?: string }) => {
    try {
      const result = grepCode(args.pattern, args.include)
      return formatToolResult(result)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})
