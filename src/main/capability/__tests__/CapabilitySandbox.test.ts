import { describe, it, expect, beforeEach } from 'vitest'
import { CapabilityEngine } from '../CapabilityEngine'
import { freezeDefaults, DEFAULT_CAPABILITIES } from '../CapabilityDefaults'

describe('CapabilitySandbox Hardening', () => {
  let engine: CapabilityEngine

  beforeEach(() => {
    engine = new CapabilityEngine({ enforcement: 'enforce' })
  })

  it('unknown caller has empty default capabilities (allow-all convention)', () => {
    const caps = DEFAULT_CAPABILITIES['unknown']
    expect(caps).toEqual([])
  })

  it('allows Kernel full capabilities', () => {
    const decision = engine.requestToken({
      action: 'file.write',
      context: { caller: 'Kernel', requestId: 'r2' },
    })
    expect(decision.granted).toBe(true)
    expect(decision.token).toBeDefined()
  })

  it('allows AgentService known capabilities', () => {
    const caps = ['file.read', 'file.write', 'llm.call', 'llm.call.chat', 'memory.read', 'mcp.call', 'shell.execute']
    for (const action of caps) {
      const decision = engine.requestToken({
        action: action as any,
        resource: undefined,
        context: { caller: 'AgentService', requestId: `r3-${action}` },
      })
      expect(decision.granted).toBe(true)
    }
  })

  it('blocks AgentService from evolution actions', () => {
    const decision = engine.requestToken({
      action: 'evolution.analyze',
      context: { caller: 'AgentService', requestId: 'r4' },
    })
    expect(decision.granted).toBe(false)
  })

  it('allows SelfEvolutionService evolution capabilities', () => {
    const decision = engine.requestToken({
      action: 'evolution.execute',
      context: { caller: 'SelfEvolutionService', requestId: 'r5' },
    })
    expect(decision.granted).toBe(true)
  })

  it('all delegates inherit ancestor restrictions', () => {
    const parent = engine.requestToken({
      action: 'memory.read',
      context: { caller: 'AgentService', requestId: 'r6' },
    })
    expect(parent.granted).toBe(true)

    const child = engine.delegateToken(parent.token!.id, {
      action: 'memory.read',
      context: { caller: 'MemoryIndexer', requestId: 'r7' },
    })
    expect(child).not.toBeNull()
    expect(child!.delegatedFrom).toBe(parent.token!.id)
  })

  it('delegate narrows resource scope (prefix-based)', () => {
    const parent = engine.requestToken({
      action: 'file.read',
      resource: '/data/',
      context: { caller: 'Kernel', requestId: 'r8' },
    })
    expect(parent.granted).toBe(true)

    const child = engine.delegateToken(parent.token!.id, {
      action: 'file.read',
      resource: '/data/subset/',
      context: { caller: 'MetricsCollector', requestId: 'r9' },
    })
    expect(child).not.toBeNull()

    const wrong = engine.delegateToken(parent.token!.id, {
      action: 'file.read',
      resource: '/other/',
      context: { caller: 'MetricsCollector', requestId: 'r10' },
    })
    expect(wrong).toBeNull()
  })

  it('revokeToken cascades through chain', () => {
    const p1 = engine.requestToken({
      action: 'file.read',
      context: { caller: 'Kernel', requestId: 'r11' },
    })
    const c1 = engine.delegateToken(p1.token!.id, {
      action: 'file.read',
      context: { caller: 'AgentService', requestId: 'r12' },
    })
    const c2 = engine.delegateToken(c1!.id, {
      action: 'file.read',
      context: { caller: 'MemoryIndexer', requestId: 'r13' },
    })

    const revoked = engine.revokeChain(p1.token!.id)
    expect(revoked).toContain(p1.token!.id)
    expect(revoked).toContain(c1!.id)
    expect(revoked).toContain(c2!.id)
  })

  it('warn mode logs but does not block', () => {
    const warnEngine = new CapabilityEngine({ enforcement: 'warn' })
    const decision = warnEngine.requestToken({
      action: 'evolution.execute',
      context: { caller: 'AgentService', requestId: 'r14' },
    })
    expect(decision.granted).toBe(false)
  })

  it('checkCallAllowed returns false for unauthorized action in enforce mode', () => {
    const result = engine.checkCallAllowed('evolution.execute', undefined, 'AgentService')
    expect(result).toBe(false)
  })

  it('audit log tracks denials for restricted callers', () => {
    // AgentService does NOT have network.connect
    engine.requestToken({
      action: 'network.connect',
      resource: 'external-service',
      context: { caller: 'AgentService', requestId: 'r15' },
    })
    const log = engine.getAuditLog()
    const denial = log.find((e) => !e.granted)
    expect(denial).toBeDefined()
    expect(denial!.caller).toBe('AgentService')
    expect(denial!.action).toBe('network.connect')
  })

  it('checkCallAllowed returns false for unauthorized caller action', () => {
    const result = engine.checkCallAllowed('network.connect', undefined, 'AgentService')
    expect(result).toBe(false)
  })
})
