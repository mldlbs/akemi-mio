import { type Task, type TaskHandler } from '../types'

export const evolutionTickHandler: TaskHandler = async (task, context) => {
  const svc = context.services.evolutionService as any
  if (!svc) throw new Error('evolutionTickHandler: evolutionService not injected')

  await svc.schedulerTick()
  return { state: svc.getSchedulerState() }
}
