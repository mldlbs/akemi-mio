import { type Task, type TaskHandler } from '../types'

export const creativityCycleHandler: TaskHandler = async (task, context) => {
  const svc = context.services.creativityService as any
  if (!svc) throw new Error('creativityCycleHandler: creativityService not injected')

  await svc.cycle()
  return { cycled: true }
}
