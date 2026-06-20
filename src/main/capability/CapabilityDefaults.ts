import type { CapabilityAction } from './types'

/**
 * 默认能力规则 — 按模块/调用方定义的授权策略
 */

const DEFAULTS: Record<string, CapabilityAction[]> = {
  Kernel: [
    'file.read',
    'file.write',
    'file.delete',
    'llm.call',
    'shell.execute',
    'network.connect',
    'network.http',
    'memory.read',
    'memory.write',
    'mcp.call',
    'evolution.analyze',
    'evolution.execute',
    'evolution.rollback',
  ],
  SyscallBus: ['file.read', 'llm.call'],
  HealthChecker: [],

  AgentService: [
    'file.read',
    'file.write',
    'llm.call',
    'llm.call.chat',
    'llm.call.code',
    'memory.read',
    'memory.write',
    'mcp.call',
    'shell.execute',
  ],

  SelfEvolutionService: [
    'file.read',
    'file.write',
    'llm.call',
    'evolution.analyze',
    'evolution.execute',
    'evolution.rollback',
    'memory.read',
  ],

  InsightService: ['file.read', 'llm.call', 'memory.read'],
  CreativityService: ['file.read', 'llm.call', 'memory.read'],
  ObserverService: ['file.read', 'network.http', 'memory.read'],

  /** 后台服务 */
  MemoryIndexer: ['file.read', 'memory.read', 'memory.write'],
  MetricsCollector: ['file.read'],
  TelegramService: ['file.read', 'memory.read', 'network.http'],

  '@mcp/external': ['file.read', 'mcp.call'],

  unknown: [],
}

export const DEFAULT_CAPABILITIES: Readonly<Record<string, readonly CapabilityAction[]>> = DEFAULTS

let _frozen = false

export function freezeDefaults(): void {
  _frozen = true
  Object.freeze(DEFAULTS)
  for (const key of Object.keys(DEFAULTS)) {
    Object.freeze(DEFAULTS[key])
  }
}

export function isDefaultsFrozen(): boolean {
  return _frozen
}
