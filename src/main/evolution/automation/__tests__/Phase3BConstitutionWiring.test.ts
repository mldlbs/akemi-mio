/**
 * Phase 3B Contract Test — ProposalValidator ↔ ConstitutionEngine Wiring
 *
 * 验证 ProposalValidator.setConstitution() 接线正确性：
 *   ConstitutionEngine.checkWrite() 注入后，受宪法保护的路径将被拒绝。
 *
 * 不验证：
 *   - ConstitutionEngine 自身行为（由 constitution/__tests__/ConstitutionEngine.test.ts 覆盖）
 *   - ExecutionPolicy 集成（Phase 3C）
 *   - PipelineOrchestrator 行为
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { ProposalValidator } from '../../ProposalValidator'
import { ConstitutionEngine } from '../../../constitution/ConstitutionEngine'
import type { Proposal } from '../../ProposalValidator'

// =============================================================================
// 辅助：快速构造 Proposal
// =============================================================================
function makeProposal(overrides?: Partial<Proposal>): Proposal {
  return {
    id: `prop_test_${Date.now()}`,
    title: '测试提案',
    description: 'Phase 3B 接线验证',
    targetFiles: ['src/main/memory/MemoryService.ts'],
    expectedOutcome: '验证 constitution 接线',
    risk: 'low',
    createdAt: Date.now(),
    ...overrides,
  }
}

// =============================================================================
// 1. 未注入 ConstitutionEngine 时
// =============================================================================
describe('Phase 3B: ProposalValidator 无 Constitution', () => {
  let validator: ProposalValidator

  beforeEach(() => {
    validator = new ProposalValidator()
  })

  it('未注入 engine 时，constitutional 检查默认通过', async () => {
    const result = await validator.validate(makeProposal())
    expect(result.constitutional.passed).toBe(true)
    expect(result.constitutional.violations).toEqual([])
  })

  it('即使目标路径是核心文件，未注入时也不拦截', async () => {
    const result = await validator.validate(
      makeProposal({ targetFiles: ['src/main/core/EventBus.ts'] }),
    )
    expect(result.constitutional.passed).toBe(true)
    expect(result.passed).toBe(true) // 仅 scope check + budget check 决定 passed
  })
})

// =============================================================================
// 2. 注入 ConstitutionEngine（enforce mode）后
// =============================================================================
describe('Phase 3B: ProposalValidator 带 Constitution (enforce)', () => {
  let validator: ProposalValidator
  let engine: ConstitutionEngine

  beforeEach(async () => {
    engine = new ConstitutionEngine()
    // 注入受保护路径规则（模拟 constitution.json 加载后的状态）
    engine.protectedPaths.load(
      [
        {
          pattern: '**/src/main/core/**',
          mutable: false,
          reason: 'Runtime Kernel',
          layer: 'kernel',
        },
        {
          pattern: '**/src/main/constitution/**',
          mutable: false,
          reason: 'Constitution',
          layer: 'kernel',
        },
      ],
      [],
    )
    engine.setEnforcementMode('enforce')
    await engine.initialize('/nonexistent/path') // 标记 engine 为已初始化
    validator = new ProposalValidator()
    validator.setConstitution(engine)
  })

  it('非受保护路径 → 通过 constitutional 检查', async () => {
    const result = await validator.validate(
      makeProposal({ targetFiles: ['src/main/memory/MemoryService.ts'] }),
    )
    expect(result.constitutional.passed).toBe(true)
    expect(result.constitutional.violations).toEqual([])
  })

  it('受保护路径（core/）→ constitutional 检查失败', async () => {
    const result = await validator.validate(
      makeProposal({ targetFiles: ['src/main/core/EventBus.ts'] }),
    )
    expect(result.constitutional.passed).toBe(false)
    expect(result.constitutional.violations.length).toBeGreaterThanOrEqual(1)
    expect(result.constitutional.violations[0]).toContain('EventBus.ts')
  })

  it('多个路径中任一受保护 → 整体不通过', async () => {
    const result = await validator.validate(
      makeProposal({
        targetFiles: [
          'src/main/memory/MemoryService.ts',
          'src/main/core/EventBus.ts',
        ],
      }),
    )
    expect(result.constitutional.passed).toBe(false)
    expect(result.constitutional.violations.length).toBe(1) // 仅 core/ 路径被拒
  })

  it('全部受保护路径 → 全部报告违反', async () => {
    const result = await validator.validate(
      makeProposal({
        targetFiles: [
          'src/main/core/Kernel.ts',
          'src/main/constitution/types.ts',
        ],
      }),
    )
    expect(result.constitutional.passed).toBe(false)
    expect(result.constitutional.violations.length).toBe(2)
  })

  it('结果中包含 violation 原因', async () => {
    const result = await validator.validate(
      makeProposal({ targetFiles: ['src/main/core/Scheduler.ts'] }),
    )
    expect(result.constitutional.violations.length).toBe(1)
    expect(result.constitutional.violations[0]).toContain('Scheduler.ts')
    expect(result.constitutional.violations[0]).toContain('Runtime Kernel')
  })
})

// =============================================================================
// 3. 注入 ConstitutionEngine（warn mode）
// =============================================================================
describe('Phase 3B: ProposalValidator 带 Constitution (warn)', () => {
  let validator: ProposalValidator
  let engine: ConstitutionEngine

  beforeEach(() => {
    engine = new ConstitutionEngine()
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
    // warn mode: constitution 记录 violation 但允许通过
    engine.setEnforcementMode('warn')
    validator = new ProposalValidator()
    validator.setConstitution(engine)
  })

  it('warn mode 下受保护路径不触发 violation（watch 模式由 constitution 自行记录）', async () => {
    const result = await validator.validate(
      makeProposal({ targetFiles: ['src/main/core/EventBus.ts'] }),
    )
    // warn mode: constitution 返回 allowed=true, ProposalValidator 不追加 violation
    expect(result.constitutional.passed).toBe(true)
    expect(result.constitutional.violations).toEqual([])
  })
})

// =============================================================================
// 4. ConstitutionEngine 未加载规则（== 无保护）
// =============================================================================
describe('Phase 3B: ConstitutionEngine 无规则', () => {
  let validator: ProposalValidator
  let engine: ConstitutionEngine

  beforeEach(async () => {
    engine = new ConstitutionEngine()
    await engine.initialize('/nonexistent/path') // 无规则加载
    engine.setEnforcementMode('enforce')
    validator = new ProposalValidator()
    validator.setConstitution(engine)
  })

  it('engine 初始化后无保护路径规则，所有路径允许', async () => {
    const result = await validator.validate(
      makeProposal({ targetFiles: ['src/main/core/EventBus.ts'] }),
    )
    expect(result.constitutional.passed).toBe(true)
  })
})
