/**
 * BrowserAgentTools — 浏览器会话管理 + CDP 身份接入
 *
 * 两个独立命令：
 * - connect — 通过 CDP 连接用户已有的 Chrome（Identity Bridge）
 * - observe — 观察 CDP 连接的 Chrome 当前页面状态
 * - act — 操控 CDP 连接的 Chrome 页面
 *
 * 使用方式：
 * 1. browser_agent_execute command=connect port=9220
 * 2. browser_agent_execute command=observe
 * 3. 用户配合：在已登录的 Chrome 中导航到目标页面
 * 4. browser_agent_execute command=act action={type:"click", target:"创建新书"}
 */

import { buildTool, formatToolResult, formatToolError } from '../types'
import { getBrowserAgentRuntime } from '../../browser-agent/BrowserAgentRuntime'

export const browserAgentExecuteTool = buildTool({
  name: 'browser_agent_execute',
  description:
    '【Browser Agent】浏览器会话管理 + 操作执行。支持：\n' +
    '1. `connect port=9220` — 通过 CDP 连接用户已有的 Chrome（已登录），并获取完整操作能力\n' +
    '2. `observe` — 观察当前连接的页面状态\n' +
    '3. `act` — 在连接的 Chrome 中执行操作：\n' +
    '   - act type=navigate value=https://... 导航\n' +
    '   - act type=click target="按钮文本" 点击（支持文本/role/选择器多策略匹配）\n' +
    '   - act type=fill target="书名" value="工业颂歌" 填写输入框（支持placeholder/aria-label匹配）\n' +
    '   - act type=observe 观察页面完整内容',
  inputJSONSchema: {
    type: 'object' as const,
    properties: {
      command: {
        type: 'string',
        enum: ['connect', 'observe', 'act'],
        description: 'connect(连接Chrome) / observe(观察) / act(执行操作)',
      },
      port: {
        type: 'number',
        description: 'connect 的端口（默认 9220）',
      },
      action: {
        type: 'object',
        description: 'act 命令的动作。type=navigate/click/fill/observe',
        properties: {
          type: {
            type: 'string',
            enum: ['navigate', 'click', 'fill', 'observe'],
            description: '动作类型',
          },
          target: {
            type: 'string',
            description: '目标元素（文本或选择器）',
          },
          value: {
            type: 'string',
            description: 'fill 时的文本，或 navigate 时的 URL',
          },
        },
      },
    },
    required: ['command'],
  },
  handler: async (args: Record<string, any>) => {
    try {
      const runtime = getBrowserAgentRuntime()
      const { command, port, action } = args

      switch (command) {
        case 'connect': {
          const result = await runtime.connect({ port: port || 9220 })
          if (!result.connected) {
            return formatToolError(result.error || 'CDP 连接失败')
          }
          return formatToolResult(
            `## ✅ 已连接用户 Chrome（端口 ${port || 9220}）\n\n` +
            `当前页面 (${result.pages.length} 个):\n` +
            result.pages.map((p, i) =>
              `${i + 1}. ${p.title || '无标题'}\n   ${p.url || '无 URL'}`
            ).join('\n') +
            `\n\n💡 下一步: 用 \`browser_agent_execute command="observe"\` 确认当前页面状态`
          )
        }

        case 'observe': {
          const obs = await runtime.observe()
          const stateMap: Record<string, string> = {
            unknown: '❓ 未知',
            logged_in: '✅ 已登录',
            logged_out: '❌ 未登录',
            login_page: '🔑 登录页面',
          }
          return formatToolResult(
            `## 🔍 页面观察\n\n` +
            `📍 ${obs.url || '未知'}\n` +
            `📌 ${obs.title || '无标题'}\n` +
            `🔐 登录状态: ${stateMap[obs.loginState] || obs.loginState}\n` +
            `📄 标签页: ${obs.keyElements.length} 个`
          )
        }

        case 'act': {
          if (!action || !action.type) {
            return formatToolError('act 命令需要 action 参数')
          }
          const session = runtime.getSession()
          if (!session || session.source !== 'cdp' || !session.cdpPort) {
            return formatToolError('请先调用 connect 连接用户 Chrome')
          }

          const result = await runtime.act(action as any)
          if (!result.success) {
            return formatToolError(`操作失败: ${result.error}`)
          }

          let msg = `✅ **${action.type} 成功**\n`
          if (result.observation?.url) {
            msg += `📍 ${result.observation.url}\n`
          }
          if (action.type === 'observe' && result.observation?.keyElements?.length) {
            msg += `\n页面内容 (前10项):\n`
            result.observation.keyElements.slice(0, 10).forEach((el, i) => {
              msg += `${i + 1}. ${el.description}\n`
            })
          }
          return formatToolResult(msg)
        }
          return formatToolError(`未知命令: ${command}`)
      }
    } catch (err: any) {
      return formatToolError(`Browser Agent 失败: ${err.message}`)
    }
  },
})
