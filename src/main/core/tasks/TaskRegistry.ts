import type { TaskHandler } from './types'

interface HandlerRegistration {
  handler: TaskHandler
  label: string
}

export class TaskRegistry {
  private handlers = new Map<string, HandlerRegistration>()

  register(type: string, handler: TaskHandler, label: string): void {
    if (this.handlers.has(type)) {
      throw new Error(`Handler already registered for task type "${type}"`)
    }
    this.handlers.set(type, { handler, label })
  }

  getHandler(type: string): TaskHandler | undefined {
    return this.handlers.get(type)?.handler
  }

  hasHandler(type: string): boolean {
    return this.handlers.has(type)
  }

  listTypes(): { type: string; label: string }[] {
    return Array.from(this.handlers.entries()).map(([type, reg]) => ({ type, label: reg.label }))
  }

  unregister(type: string): boolean {
    return this.handlers.delete(type)
  }

  clear(): void {
    this.handlers.clear()
  }

  get size(): number {
    return this.handlers.size
  }
}
