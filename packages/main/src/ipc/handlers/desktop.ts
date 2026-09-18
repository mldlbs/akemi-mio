import { ipcMain } from 'electron'
import { log } from '@akemi-mio/core/logger/Logger'
import type { HandlerContext } from './context'

export function registerDesktopHandlers(_ctx: HandlerContext): void {
  const desktopToolMap: Record<string, (args: any) => Promise<any>> = {}

  import('@akemi-mio/capabilities/tool/definitions/DesktopTools')
    .then(({ desktopTools }) => {
      for (const tool of desktopTools) desktopToolMap[tool.name] = tool.handler
      log('INFO', 'desktop_tools_loaded', { count: desktopTools.length })
    })
    .catch((err) => log('WARN', 'desktop_tools_load_failed', { error: String(err) }))

  ipcMain.handle('desktop:invokeTool', async (_event, toolName: string, args: Record<string, any>) => {
    try {
      const handler = desktopToolMap[toolName]
      if (!handler) return { success: false, error: '未知工具: ' + toolName }
      const result = await handler(args)
      if (result && typeof result === 'object' && 'content' in result) {
        const text = result.content?.[0]?.text || ''
        return { success: !result.isError, result: text, error: result.isError ? text : undefined }
      }
      return { success: true, result: String(result) }
    } catch (err: any) {
      log('ERROR', 'desktop_invoke_tool_failed', { toolName, error: String(err) })
      return { success: false, error: err.message || String(err) }
    }
  })
}
