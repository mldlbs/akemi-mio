/**
 * Injectable runtime for resource-control.
 *
 * The package used to hard-depend on `@akemi-mio/core` (Logger, EventBus,
 * WORKSPACE config). To stay reusable outside the Electron host, runtime
 * services are injectable with zero-dependency fallbacks:
 *
 * - logger: console-backed (silence with RESOURCE_CONTROL_SILENT=1)
 * - eventBus: minimal in-process emitter
 * - workspaceDir: MIO_WORKSPACE env or process.cwd()
 *
 * The host application can call `configureResourceRuntime({ logger, eventBus, workspaceDir })`
 * once at startup to plug its own implementations and restore full parity.
 */

export type RuntimeLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

export type RuntimeLogger = (
  level: RuntimeLogLevel,
  event: string,
  data?: Record<string, unknown>,
) => void

export interface RuntimeEventBus {
  emit(event: string, payload?: unknown): void
  /** Returns an unsubscribe function. */
  on(event: string, handler: (payload?: unknown) => void): () => void
}

export interface ResourceRuntime {
  logger: RuntimeLogger
  bus: RuntimeEventBus
  workspaceDir: string
}

function consoleLogger(): RuntimeLogger {
  return (level, event, data) => {
    if (process.env.RESOURCE_CONTROL_SILENT === '1') return
    const line = `[resource-control][${level}] ${event}`
    if (data === undefined) console.log(line)
    else console.log(line, JSON.stringify(data))
  }
}

class MiniEventBus implements RuntimeEventBus {
  private handlers = new Map<string, Set<(payload?: unknown) => void>>()

  on(event: string, handler: (payload?: unknown) => void): () => void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(handler)
    return () => {
      set?.delete(handler)
    }
  }

  emit(event: string, payload?: unknown): void {
    const set = this.handlers.get(event)
    if (!set) return
    for (const handler of [...set]) {
      try {
        handler(payload)
      } catch (_) {
        // listener errors must not break budget accounting
      }
    }
  }
}

const defaults: ResourceRuntime = {
  logger: consoleLogger(),
  bus: new MiniEventBus(),
  workspaceDir: process.env.MIO_WORKSPACE || process.cwd(),
}

let runtime: ResourceRuntime = defaults

export function configureResourceRuntime(overrides: Partial<ResourceRuntime>): void {
  runtime = {
    logger: overrides.logger ?? runtime.logger,
    bus: overrides.bus ?? runtime.bus,
    workspaceDir: overrides.workspaceDir ?? runtime.workspaceDir,
  }
}

export function resetResourceRuntime(): void {
  runtime = {
    logger: consoleLogger(),
    bus: new MiniEventBus(),
    workspaceDir: process.env.MIO_WORKSPACE || process.cwd(),
  }
}

export function getResourceRuntime(): ResourceRuntime {
  return runtime
}

/**
 * Convenience facade used inside the package. Every call reads the *current*
 * runtime, so `configureResourceRuntime()` takes effect immediately even for
 * call sites that captured `rt` at module load.
 */
export const rt = {
  /** Call-style logger: rt.logger('INFO', 'event', {...}) */
  logger: (level: RuntimeLogLevel, event: string, data?: Record<string, unknown>) => runtime.logger(level, event, data),
  /** Alias kept for concise call sites. */
  log: (level: RuntimeLogLevel, event: string, data?: Record<string, unknown>) => runtime.logger(level, event, data),
  /** Event bus facade; every call reads the current runtime. */
  bus: {
    emit: (event: string, payload?: unknown) => runtime.bus.emit(event, payload),
    on: (event: string, handler: (payload?: unknown) => void) => runtime.bus.on(event, handler),
  },
  on: (event: string, handler: (payload?: unknown) => void) => runtime.bus.on(event, handler),
  /** Directory root for persisted budget state. */
  workspaceDir: () => runtime.workspaceDir,
}
