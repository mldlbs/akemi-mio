/**
 * BrowserAgentTools — 浏览器智能操作工具
 *
 * MIO 通过此工具发出语义级别的浏览器指令，Stagehand 负责解析和执行。
 * MIO 只需描述"做什么"（如"点击登录按钮"），不需要写 selector。
 */

import { buildTool, formatToolResult, formatToolError } from '../types'
import { getBrowserAgentRuntime } from '../../browser-agent/BrowserAgentRuntime'

export const browserAgentExecuteTool = buildTool({
  name: 'browser_agent_execute',
  description:
    '【浏览器智能操作】执行语义级别的浏览器操作。' +
    '你不需要写 CSS selector 或坐标，只需要描述目标（如"点击登录按钮"），系统自动理解页面、定位元素、执行动作。' +
    '\n\n' +
    '命令: ' +
    'observe — 观察当前页面，返回 URL、登录状态、可操作元素列表。' +
    ' | ' +
    'act — 执行语义动作。参数: type(click/fill/navigate/scroll), target(描述目标), value(填入值)。' +
    ' | ' +
    'extract — 提取页面信息。参数: instruction(提取说明), schema(JSON Schema 定义提取结构)。',
  inputJSONSchema: {
    type: 'object' as const,
    properties: {
      command: {
        type: 'string',
        enum: ['observe', 'act', 'extract'],
        description: 'observe(观察页面) / act(执行动作) / extract(提取信息)',
      },
      action: {
        type: 'object',
        description: 'act 命令的语义动作',
        properties: {
          type: {
            type: 'string',
            enum: ['navigate', 'click', 'fill', 'type', 'scroll', 'wait'],
            description: '动作类型',
          },
          target: {
            type: 'string',
            description: '语义目标，如"登录按钮"、"密码输入框"',
          },
          value: {
            type: 'string',
            description: '要填入的文本或导航 URL',
          },
        },
      },
      instruction: {
        type: 'string',
        description: 'extract 命令的提取说明，如"提取当前页面的登录状态"',
      },
      schema: {
        type: 'object',
        description: 'extract 命令的 JSON Schema，定义提取结果的结构',
      },
    },
    required: ['command'],
  },
  handler: async (args: Record<string, any>) => {
    try {
      const runtime = getBrowserAgentRuntime()
      const { command, action, instruction, schema } = args

      switch (command) {
        case 'observe': {
          const obs = await runtime.observe(instruction || '列出页面上所有可操作的按钮、链接和输入框')
          const stateMap: Record<string, string> = {
            unknown: '❓ 未知',
            logged_in: '✅ 已登录',
            logged_out: '❌ 未登录',
            login_page: '🔑 登录页面',
          }
          return formatToolResult(
            `## 🔍 页面观察\n\n` +
            `📍 ${obs.url}\n` +
            `📌 ${obs.title}\n` +
            `🔐 登录状态: ${stateMap[obs.loginState] || obs.loginState}\n\n` +
            `### 可操作元素 (${obs.keyElements.length})\n\n` +
            obs.keyElements.map((el, i) =>
              `${i + 1}. ${el.description}${el.selector ? ` (\`${el.selector}\`)` : ''}`
            ).join('\n') +
            `\n\n💡 下一步: 用 \`browser_agent_execute command="act"\` 执行语义动作`
          )
        }

        case 'act': {
          if (!action || !action.type) {
            return formatToolError('act 命令需要 action 参数（包含 type）')
          }
          const result = await runtime.act(action)
          if (!result.success) {
            return formatToolError(`动作失败: ${result.error}`)
          }
          const obs = result.observation
          let msg = `✅ **动作执行成功**\n\n`
          if (obs) {
            msg += `📍 ${obs.url}\n`
            msg += `🔐 ${obs.loginState === 'logged_in' ? '✅ 已登录' : obs.loginState === 'login_page' ? '🔑 登录页' : '❓'}\n`
            if (obs.keyElements.length > 0) {
              msg += `\n当前页面可用元素:\n`
              msg += obs.keyElements.slice(0, 8).map(el => `- ${el.description}`).join('\n')
            }
          }
          return formatToolResult(msg)
        }

        case 'extract': {
          if (!instruction) {
            return formatToolError('extract 命令需要 instruction 参数')
          }
          const result = await runtime.extract(instruction, schema || {
            type: 'object',
            properties: {
              result: { type: 'string' },
            },
          })
          return formatToolResult(
            `## 📊 提取结果\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``
          )
        }

        default:
          return formatToolError(`未知命令: ${command}`)
      }
    } catch (err: any) {
      const stack = err.stack ? err.stack.split('\n').slice(0,3).join('\n') : ''
      return formatToolError(`浏览器操作失败: ${err.message}\n${stack}`)
    }
  },
})
