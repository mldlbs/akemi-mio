import { type Task, type TaskHandler } from '../types'

export const creativityDreamHandler: TaskHandler = async (task, context) => {
  const svc = context.services.creativityService as any
  if (!svc) throw new Error('creativityDreamHandler: creativityService not injected')

  await svc.dreamCycle()
  return { dreamed: true }
}
