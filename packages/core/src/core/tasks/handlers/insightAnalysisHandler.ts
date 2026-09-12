import { type Task, type TaskHandler } from '../types'

/**
 * InsightService 定时分析 handler。
 * 在 handler 内调用服务的 tick() 方法驱动检查循环。
 */
export const insightAnalysisHandler: TaskHandler = async (task, context) => {
  const svc = context.services.insightService as any
  if (!svc) {
    throw new Error('insightAnalysisHandler: insightService not injected')
  }

  svc.tick()
  return { ticked: true }
}
