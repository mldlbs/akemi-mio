import { buildTool, formatToolResult, formatToolError } from '../types'
import { execSync } from 'child_process'
import { WORKSPACE } from '../../config'
import { join } from 'path'

const SOCIAL_DIR = join(WORKSPACE.evolution, 'social')
const PIPELINE_SCRIPT = join(SOCIAL_DIR, 'pipeline.mjs')

export const socialPipelineTool = buildTool({
  name: 'social_pipeline',
  description:
    '秋山澪社交媒体发布流水线。管理草稿格式化、配图生成、内容排程。只做机械处理，不写稿。子命令: format <路径> — 格式化单篇草稿; image <批次名> — 为批次生成配图; schedule <批次名> — 扫描批次目录更新排程日历; batch <批次名> — image + schedule 一步完成',
  inputJSONSchema: {
    type: 'object',
    properties: {
      args: {
        type: 'string',
        description: 'pipeline 子命令及参数。例如: "schedule 2026-06-27-xxx --hour 12" 或 "format drafts/2026-06-27-xxx/douyin/xxx.md"',
      },
    },
    required: ['args'],
  },
  handler: async (input: { args: string }) => {
    try {
      const result = execSync(`node "${PIPELINE_SCRIPT}" ${input.args}`, {
        cwd: SOCIAL_DIR,
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf-8',
        windowsHide: true,
      })
      return formatToolResult(result.trim() || '执行完成（无输出）')
    } catch (err: any) {
      return formatToolError(`pipeline 执行失败: ${err.message || String(err)}`)
    }
  },
  isReadOnly: false,
})
