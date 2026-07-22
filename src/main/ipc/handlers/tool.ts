import { ipcMain } from 'electron'
import { log } from '../../logger/Logger'
import type { HandlerContext } from './context'

export function registerToolHandlers({ agentService }: HandlerContext): void {
  ipcMain.handle('tool:getParamDefaults', async (_event, toolName: string, limit?: number) => {
    try {
      const { toolCallCombinationIndex } = await import('../../tool/ToolCallCombinationIndex')
      return { success: true, combinations: toolCallCombinationIndex.getTopCombinations(toolName, limit) }
    } catch (err: any) { log('WARN', 'tool_get_param_defaults_failed', { toolName, error: String(err) }); return { success: false, combinations: [], error: String(err) } }
  })

  ipcMain.handle('tool:recordParamFeedback', async (_event, toolName: string, args: Record<string, any>, rating: number) => {
    try {
      const memoryService = agentService.getMemoryService()
      if (memoryService) {
        const feedbackText = rating > 0 ? '【参数反馈】用户确认了 ' + toolName + ' 的参数组合评分=' + rating : '【参数反馈】用户拒绝了 ' + toolName + ' 的参数组合评分=' + rating
        memoryService.addFact(feedbackText, Math.abs(rating))
        memoryService.saveUserPreference({ key: 'tool_param_combo:' + toolName, value: JSON.stringify(args), confidence: Math.abs(rating), category: 'preference', source: 'tool_param_feedback', updatedAt: Date.now() })
      }
      if (rating > 0) {
        const { toolCallLogStore } = await import('../../tool/ToolCallLogStore')
        toolCallLogStore.record(toolName, args, '(user adopted default)', null, 0, true)
      }
      log('INFO', 'tool_param_feedback_recorded', { toolName, rating })
      return { success: true }
    } catch (err: any) { log('WARN', 'tool_record_param_feedback_failed', { toolName, error: String(err) }); return { success: false, error: String(err) } }
  })
}
