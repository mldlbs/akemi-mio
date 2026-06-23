import { describe, it, expect, beforeEach } from 'vitest'
import { ProtectedPaths } from '../ProtectedPaths'
import { ConstitutionEngine } from '../ConstitutionEngine'
import { validateConstitution, createDefaultJson } from '../ConstitutionDocument'
import { isKernelPath } from '../types'

// ─── ProtectedPaths ───

describe('ProtectedPaths', () => {
  let pp: ProtectedPaths

  beforeEach(() => {
    pp = new ProtectedPaths()
  })

  const IMMUTABLE_RULES = [
    {
      pattern: '**/src/main/core/**',
      mutable: false,
      reason: 'Runtime Kernel',
      layer: 'kernel' as const,
    },
    {
      pattern: '**/src/main/constitution/**',
      mutable: false,
      reason: 'Constitution',
      layer: 'kernel' as const,
    },
  ]

  it('should block writes to core/ directory in enforce mode', () => {
    pp.load(IMMUTABLE_RULES, [])

    const result = pp.isWriteAllowed('/project/src/main/core/EventBus.ts')
    expect(result).toBe(false)
  })

  it('should block writes to constitution/ directory', () => {
    pp.load(IMMUTABLE_RULES, [])

    const result = pp.isWriteAllowed('/project/src/main/constitution/types.ts')
    expect(result).toBe(false)
  })

  it('should allow writes to memory/ directory (mutable)', () => {
    pp.load(IMMUTABLE_RULES, [])

    const result = pp.isWriteAllowed('/project/src/main/memory/MemoryService.ts')
    expect(result).toBe(true)
  })

  it('should allow writes to evolution/ directory', () => {
    pp.load(IMMUTABLE_RULES, [])

    const result = pp.isWriteAllowed('/project/src/main/evolution/SelfEvolutionService.ts')
    expect(result).toBe(true)
  })

  it('should handle Windows path separators', () => {
    pp.load(IMMUTABLE_RULES, [])

    const result = pp.isWriteAllowed('D:\\project\\src\\main\\core\\EventBus.ts')
    expect(result).toBe(false)
  })

  it('should return null for unprotected paths', () => {
    pp.load(IMMUTABLE_RULES, [])

    const match = pp.isProtected('/project/src/main/memory/MemoryService.ts')
    expect(match).toBeNull()
  })

  it('should return the matching ProtectedPath for protected paths', () => {
    pp.load(IMMUTABLE_RULES, [])

    const match = pp.isProtected('/project/src/main/core/Scheduler.ts')
    expect(match).not.toBeNull()
    expect(match!.pattern).toBe('**/src/main/core/**')
    expect(match!.layer).toBe('kernel')
  })

  it('should report hasRules correctly', () => {
    expect(pp.hasRules).toBe(false)
    pp.load(IMMUTABLE_RULES, [])
    expect(pp.hasRules).toBe(true)
  })

  it('should clear all rules on reset', () => {
    pp.load(IMMUTABLE_RULES, [])
    expect(pp.hasRules).toBe(true)
    pp.clear()
    expect(pp.hasRules).toBe(false)
  })
})

// ─── ConstitutionEngine ───

describe('ConstitutionEngine', () => {
  let engine: ConstitutionEngine

  beforeEach(() => {
    engine = new ConstitutionEngine()
  })

  it('should initialize without errors when no constitution.json exists', async () => {
    await engine.initialize('/nonexistent/path')
    expect(engine.isInitialized).toBe(true)
  })

  it('should default to warn mode', () => {
    expect(engine.enforcementMode).toBe('warn')
  })

  it('should allow writes in warn mode even when path is protected', async () => {
    engine.protectedPaths.load(
      [
        {
          pattern: '**/src/main/core/**',
          mutable: false,
          reason: 'Runtime Kernel',
          layer: 'kernel',
        },
      ],
      [],
    )
    await engine.initialize('/nonexistent/path')

    const check = engine.checkWrite('/project/src/main/core/EventBus.ts')
    expect(check.allowed).toBe(true)
    expect(check.violation).toBeDefined()
    expect(check.violation!.severity).toBe('error')
  })

  it('should block writes in enforce mode for protected paths', async () => {
    engine.protectedPaths.load(
      [
        {
          pattern: '**/src/main/core/**',
          mutable: false,
          reason: 'Runtime Kernel',
          layer: 'kernel',
        },
      ],
      [],
    )
    engine.setEnforcementMode('enforce')
    await engine.initialize('/nonexistent/path')

    const check = engine.checkWrite('/project/src/main/core/EventBus.ts')
    expect(check.allowed).toBe(false)
    expect(check.violation).toBeDefined()
  })

  it('should allow writes in enforce mode for mutable paths', async () => {
    engine.protectedPaths.load(
      [
        {
          pattern: '**/src/main/core/**',
          mutable: false,
          reason: 'Runtime Kernel',
          layer: 'kernel',
        },
      ],
      [],
    )
    engine.setEnforcementMode('enforce')
    await engine.initialize('/nonexistent/path')

    const check = engine.checkWrite('/project/src/main/memory/MemoryService.ts')
    expect(check.allowed).toBe(true)
    expect(check.violation).toBeUndefined()
  })

  it('should bypass checks in off mode', async () => {
    engine.protectedPaths.load(
      [
        {
          pattern: '**/src/main/core/**',
          mutable: false,
          reason: 'Runtime Kernel',
          layer: 'kernel',
        },
      ],
      [],
    )
    engine.setEnforcementMode('off')
    await engine.initialize('/nonexistent/path')

    const check = engine.checkWrite('/project/src/main/core/EventBus.ts')
    expect(check.allowed).toBe(true)
  })

  it('should fire violation event on protected write', async () => {
    engine.protectedPaths.load(
      [
        {
          pattern: '**/src/main/core/**',
          mutable: false,
          reason: 'Runtime Kernel',
          layer: 'kernel',
        },
      ],
      [],
    )
    await engine.initialize('/nonexistent/path')

    const events: any[] = []
    engine.on('constitution.violation', (p) => events.push(p))

    engine.checkWrite('/project/src/main/core/Scheduler.ts')
    expect(events.length).toBe(1)
    expect(events[0].path).toContain('Scheduler.ts')
    expect(events[0].layer).toBe('kernel')
  })

  it('should fire mode_changed event on mode switch', () => {
    const events: any[] = []
    engine.on('constitution.mode_changed', (p) => events.push(p))

    engine.setEnforcementMode('enforce')
    expect(events.length).toBe(1)
    expect(events[0].mode).toBe('enforce')
    expect(events[0].previous).toBe('warn')
  })
})

// ─── ConstitutionDocument ───

describe('ConstitutionDocument', () => {
  it('should validate a valid document', () => {
    const doc = createDefaultJson()
    const errors = validateConstitution(doc)
    expect(errors.length).toBe(0)
  })

  it('should reject null/undefined document', () => {
    const errors = validateConstitution(null)
    expect(errors.length).toBeGreaterThan(0)
  })

  it('should reject document without version', () => {
    const errors = validateConstitution({ immutablePaths: [], mutablePaths: [] })
    expect(errors).toContain('version must be a string')
  })

  it('should reject document without immutablePaths', () => {
    const errors = validateConstitution({ version: '1.0', mutablePaths: [] })
    expect(errors).toContain('immutablePaths must be an array')
  })

  it('should create default JSON with correct structure', () => {
    const doc = createDefaultJson()
    expect(doc.version).toBe('1.0.0')
    expect(doc.immutablePaths.length).toBe(3)
    expect(doc.immutablePaths[0].pattern).toContain('core')
    expect(doc.immutablePaths[1].pattern).toContain('constitution')
    expect(doc.immutablePaths[2].pattern).toContain('bootstrap')
  })
})

const TEST_KERNEL_PREFIXES = [
  '/project/src/main/core/',
  '/project/src/main/constitution/',
  '/project/src/main/bootstrap/',
  'D:/project/src/main/core/',
  'D:/project/src/main/constitution/',
  'D:/project/src/main/bootstrap/',
]

// ─── isKernelPath ───

describe('isKernelPath', () => {
  it('should detect core/ paths', () => {
    expect(isKernelPath('/project/src/main/core/EventBus.ts', TEST_KERNEL_PREFIXES)).toBe(true)
  })

  it('should detect constitution/ paths', () => {
    expect(isKernelPath('/project/src/main/constitution/types.ts', TEST_KERNEL_PREFIXES)).toBe(true)
  })

  it('should reject non-kernel paths', () => {
    expect(isKernelPath('/project/src/main/memory/MemoryService.ts', TEST_KERNEL_PREFIXES)).toBe(false)
  })

  it('should handle Windows paths', () => {
    expect(isKernelPath('D:\\project\\src\\main\\core\\Scheduler.ts', TEST_KERNEL_PREFIXES)).toBe(true)
  })

  it('should not match partial paths', () => {
    expect(isKernelPath('/project/src/main/core_related/helper.ts', TEST_KERNEL_PREFIXES)).toBe(false)
  })
})
