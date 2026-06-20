import { type Task, type TaskHandler } from '../types'

export const memoryIndexHandler: TaskHandler = async (task, context) => {
  const svc = context.services.memoryIndexer as any
  if (!svc) throw new Error('memoryIndexHandler: memoryIndexer not injected')

  await svc.tick()
  return { lastIndexed: Date.now() }
}
