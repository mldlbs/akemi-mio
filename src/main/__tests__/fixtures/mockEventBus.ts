import { vi } from 'vitest'

/**
 * Creates a mock EventBus with stubbed public interface.
 * Compatible with both core/EventBus and core/EventBusTypes signatures.
 */
export function createMockEventBus() {
  const listeners = new Map<string, Set<Function>>()

  return {
    on: vi.fn((event: string, handler: Function) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(handler)
      return vi.fn()
    }),
    off: vi.fn((event: string, handler: Function) => {
      listeners.get(event)?.delete(handler)
    }),
    emit: vi.fn((event: string, payload?: any) => {
      const handlers = listeners.get(event)
      if (handlers) handlers.forEach((h) => h(payload))
    }),
    once: vi.fn((event: string, handler: Function) => {
      const wrapper = (payload: any) => {
        handler(payload)
        listeners.get(event)?.delete(wrapper)
      }
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(wrapper)
      return vi.fn()
    }),
    removeAllListeners: vi.fn((event?: string) => {
      if (event) listeners.delete(event)
      else listeners.clear()
    }),
    listenerCount: vi.fn((event?: string) => {
      if (event) return listeners.get(event)?.size ?? 0
      return listeners.size
    }),
    emitWithMeta: vi.fn(),
    registerAgentEvents: vi.fn(),
    registeredEvents: () => Array.from(listeners.keys()),
    clear: vi.fn(),
  }
}

/**
 * Creates a mock Logger with stubbed methods.
 * Captures all log output for assertions.
 */
export function createMockLogger() {
  const entries: Array<{ level: string; event: string; meta?: any }> = []

  return {
    log: vi.fn((level: string, event: string, meta?: any) => {
      entries.push({ level, event, meta })
    }),
    info: vi.fn((event: string, meta?: any) => {
      entries.push({ level: 'INFO', event, meta })
    }),
    warn: vi.fn((event: string, meta?: any) => {
      entries.push({ level: 'WARN', event, meta })
    }),
    error: vi.fn((event: string, meta?: any) => {
      entries.push({ level: 'ERROR', event, meta })
    }),
    debug: vi.fn((event: string, meta?: any) => {
      entries.push({ level: 'DEBUG', event, meta })
    }),
    getEntries: () => [...entries],
    getEntriesByLevel: (level: string) => entries.filter((e) => e.level === level),
    getEntriesByEvent: (event: string) => entries.filter((e) => e.event === event),
    clear: () => {
      entries.length = 0
    },
  }
}

/**
 * Creates a mock ipcMain handler map for testing IPC handlers.
 */
export function createMockIPCHandlers() {
  const handlers = new Map<string, Function>()

  return {
    handle: vi.fn((channel: string, handler: Function) => {
      handlers.set(channel, handler)
    }),
    handleOnce: vi.fn((channel: string, handler: Function) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel)
    }),
    async invoke(channel: string, ...args: any[]): Promise<any> {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`No handler registered for channel: ${channel}`)
      return handler({} as any, ...args)
    },
    hasHandler: (channel: string) => handlers.has(channel),
    handlerCount: () => handlers.size,
    clear: () => handlers.clear(),
  }
}
