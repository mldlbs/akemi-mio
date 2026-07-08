/**
 * DesktopTools — 桌面任务控制浮层工具定义
 *
 * 提供三个快捷工具供桌面 Overlay 工具栏调用:
 *   - desktop_quick_note : 保存快速笔记到工作区
 *   - desktop_todo_add   : 添加待办事项
 *   - desktop_app_launch : 启动 Windows 应用
 *
 * 数据流:
 *   DesktopToolbar (renderer) → IPC invoke → handler → tool.handler()
 */

import { exec } from 'child_process'
import { writeFile, readFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import { buildTool, formatToolResult, formatToolError } from '../types'
import { WORKSPACE } from '../../config'
import { log } from '../../logger/Logger'

// =============================================================================
// 辅助函数
// =============================================================================

const DESKTOP_DIR = join(WORKSPACE.cache, 'desktop_tasks')

async function ensureDir(): Promise<void> {
  if (!existsSync(DESKTOP_DIR)) {
    await mkdir(DESKTOP_DIR, { recursive: true })
  }
}

// =============================================================================
// desktop_quick_note — 快速笔记
// =============================================================================

export const desktopQuickNoteTool = buildTool({
  name: 'desktop_quick_note',
  description: '快速保存一条笔记到桌面工作区。内容支持 Markdown 格式。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: '笔记内容，支持 Markdown' },
      title: { type: 'string', description: '笔记标题（可选，默认取时间戳）' },
    },
    required: ['content'],
  },
  handler: async (args: { content: string; title?: string }) => {
    try {
      await ensureDir()
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const title = args.title || `笔记_${timestamp}`
      const safeName = title.replace(/[<>:"/\\|?*]/g, '_').slice(0, 60)
      const filePath = join(DESKTOP_DIR, `${safeName}_${timestamp}.md`)
      const header = `# ${title}\n> 创建于 ${new Date().toLocaleString('zh-CN')}\n\n`
      await writeFile(filePath, header + args.content, 'utf-8')
      log('INFO', 'desktop_quick_note_saved', { title: safeName, path: filePath })
      return formatToolResult(`笔记已保存: ${safeName}`)
    } catch (err: any) {
      log('ERROR', 'desktop_quick_note_failed', { error: String(err) })
      return formatToolError(`保存笔记失败: ${err.message}`)
    }
  },
  serverName: '@builtin/desktop',
  isReadOnly: false,
})

// =============================================================================
// desktop_todo_add — 待办添加
// =============================================================================

export interface TodoItem {
  id: string
  title: string
  priority: 'low' | 'normal' | 'high'
  createdAt: number
  done: boolean
}

const TODO_FILE = join(DESKTOP_DIR, 'todos.json')

async function readTodos(): Promise<TodoItem[]> {
  try {
    if (!existsSync(TODO_FILE)) return []
    const raw = await readFile(TODO_FILE, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return []
  }
}

async function writeTodos(todos: TodoItem[]): Promise<void> {
  await ensureDir()
  await writeFile(TODO_FILE, JSON.stringify(todos, null, 2), 'utf-8')
}

export const desktopTodoAddTool = buildTool({
  name: 'desktop_todo_add',
  description: '添加一条待办事项到桌面任务列表。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '待办事项标题' },
      priority: { type: 'string', enum: ['low', 'normal', 'high'], description: '优先级（默认 normal）' },
    },
    required: ['title'],
  },
  handler: async (args: { title: string; priority?: 'low' | 'normal' | 'high' }) => {
    try {
      await ensureDir()
      const todos = await readTodos()
      const item: TodoItem = {
        id: `todo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        title: args.title,
        priority: args.priority || 'normal',
        createdAt: Date.now(),
        done: false,
      }
      todos.push(item)
      await writeTodos(todos)
      const priorityLabel = { low: '低', normal: '中', high: '高' }[item.priority]
      log('INFO', 'desktop_todo_added', { title: args.title, priority: item.priority })
      return formatToolResult(`待办已添加 [${priorityLabel}优先级]: ${args.title}\n当前共 ${todos.length} 项待办，${todos.filter((t) => !t.done).length} 项未完成`)
    } catch (err: any) {
      log('ERROR', 'desktop_todo_add_failed', { error: String(err) })
      return formatToolError(`添加待办失败: ${err.message}`)
    }
  },
  serverName: '@builtin/desktop',
  isReadOnly: false,
})

// =============================================================================
// desktop_app_launch — 应用启动
// =============================================================================

const APP_ALIASES: Record<string, string> = {
  vscode: 'code',
  code: 'code',
  'visual studio code': 'code',
  terminal: 'wt',
  wt: 'wt',
  'windows terminal': 'wt',
  cmd: 'cmd',
  explorer: 'explorer',
  notepad: 'notepad',
  记事本: 'notepad',
  calculator: 'calc',
  计算器: 'calc',
  edge: 'start microsoft-edge:',
  chrome: 'start chrome:',
  firefox: 'start firefox:',
  浏览器: 'start microsoft-edge:',
  wechat: `start "" "${process.env.LOCALAPPDATA || ''}\\Programs\\WeChat\\WeChat.exe"`,
  微信: `start "" "${process.env.LOCALAPPDATA || ''}\\Programs\\WeChat\\WeChat.exe"`,
}

export const desktopAppLaunchTool = buildTool({
  name: 'desktop_app_launch',
  description: '启动 Windows 应用程序。支持常用别名（vscode, terminal, notepad, calc, edge, chrome, wechat 等）。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      appName: { type: 'string', description: '应用名称或别名（如 vscode, terminal, notepad, chrome, wechat）' },
    },
    required: ['appName'],
  },
  handler: async (args: { appName: string }) => {
    const { appName } = args
    const command = APP_ALIASES[appName.toLowerCase()] || `start "" "${appName}"`

    return new Promise((resolve) => {
      exec(command, { windowsHide: true, timeout: 10000 }, (err, stdout, stderr) => {
        if (err) {
          log('WARN', 'desktop_app_launch_failed', { appName, error: String(err) })
          resolve(formatToolError(`启动失败: ${err.message}`))
        } else {
          log('INFO', 'desktop_app_launched', { appName, command })
          resolve(formatToolResult(`已启动: ${appName}`))
        }
      })
    })
  },
  serverName: '@builtin/desktop',
  isReadOnly: false,
})

// =============================================================================
// 批量导出
// =============================================================================

export const desktopTools = [desktopQuickNoteTool, desktopTodoAddTool, desktopAppLaunchTool]
