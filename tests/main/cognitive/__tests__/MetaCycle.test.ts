import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { MetaCycle } from '@akemi-mio/intelligence/cognitive/MetaCycle'
import { IdentityModule } from '@akemi-mio/intelligence/identity/IdentityModule'
import { initDatabase, closeDatabase, getRawDb } from '@akemi-mio/core/db/connection'
import { ProceduralMemory } from '@akemi-mio/intelligence/agent/ProceduralMemory'
import { EngineeringMemory } from '@akemi-mio/intelligence/memory/EngineeringMemory'
import { useIsolatedTestDatabase } from '../../db/__tests__/testDatabase'

const TEST_CONSTITUTION = join(process.cwd(), 'test-meta-constitution.md')

const SAMPLE_CONSTITUTION = `# Core Identity
- name: 测试助手
- role: 开发伙伴
## Capabilities
- 编码
- 调试
## Personality
- 耐心
- 细致
## Constraints
- 不执行代码
- 不联网
`

describe('MetaCycle', () => {
  let cycle: MetaCycle
  let identity: IdentityModule
  let procMem: ProceduralMemory
  let engMem: EngineeringMemory
  let restoreTestDatabase: () => void

  beforeEach(async () => {
    if (existsSync(TEST_CONSTITUTION)) unlinkSync(TEST_CONSTITUTION)
    restoreTestDatabase = useIsolatedTestDatabase()
    await initDatabase()
    writeFileSync(TEST_CONSTITUTION, SAMPLE_CONSTITUTION, 'utf-8')

    identity = new IdentityModule()
    await identity.initialize(TEST_CONSTITUTION)

    procMem = new ProceduralMemory()
    procMem.save({ name: '测试流程', description: '一个测试流程', steps: ['步骤1'], triggerKeywords: ['测试'] })

    engMem = new EngineeringMemory()
    engMem.store({
      type: 'failure_pattern',
      content: '工具调用超时',
      source: 'test',
      confidence: 0.7,
      relatedFiles: [],
      tags: ['超时'],
    })

    cycle = new MetaCycle()
  })

  afterEach(() => {
    closeDatabase()
    if (existsSync(TEST_CONSTITUTION)) unlinkSync(TEST_CONSTITUTION)
    restoreTestDatabase()
  })

  it('should initialize with deps', () => {
    cycle.initialize({ identity, engineeringMemory: engMem, proceduralMemory: procMem, llmService: null as any })
    expect(cycle).toBeDefined()
  })

  it('should collect snapshot with identity data', () => {
    cycle.initialize({ identity, engineeringMemory: engMem, proceduralMemory: procMem, llmService: null as any })
    const snapshot = cycle.collectSnapshot()
    expect(snapshot.traits).toContain('goal_alignment')
    expect(snapshot.metrics).toContain('sessions')
    expect(snapshot.failurePatterns).toContain('工具调用超时')
    expect(snapshot.procedures).toContain('测试流程')
  })

  it('should collect snapshot without deps gracefully', () => {
    const cycle2 = new MetaCycle()
    const snapshot = cycle2.collectSnapshot()
    expect(snapshot.traits).toBe('无特征数据')
    expect(snapshot.metrics).toBe('无统计数据')
  })

  it('should apply review and persist to DB', () => {
    cycle.initialize({ identity, engineeringMemory: engMem, proceduralMemory: procMem, llmService: null as any })
    cycle.applyReview({
      summary: '本周表现良好，工具调用效率提升',
      patterns: ['工具成功率上升', '超时减少'],
      improvements: ['继续优化超时处理'],
      traitAdjustments: { tool_efficiency: 0.85 },
      confidence: 0.8,
    })

    const db = getRawDb()
    const rows = db.exec('SELECT * FROM meta_reviews')[0]
    expect(rows).toBeDefined()
    expect(rows!.values.length).toBe(1)
    const val = rows!.values[0] as any[]
    const summaryIdx = rows!.columns.indexOf('summary')
    expect(val[summaryIdx]).toContain('本周表现良好')

    // 验证特征已更新
    const trait = identity.getTraits().find((t) => t.name === 'tool_efficiency')
    expect(trait).toBeDefined()
    expect(trait!.value).toBeCloseTo(0.68, 1)
  })

  it('should get empty formatted context before review', () => {
    cycle.initialize({ identity, engineeringMemory: engMem, proceduralMemory: procMem, llmService: null as any })
    expect(cycle.getFormattedContext()).toBe('')
  })

  it('should get formatted context after review', () => {
    cycle.initialize({ identity, engineeringMemory: engMem, proceduralMemory: procMem, llmService: null as any })
    cycle.applyReview({
      summary: '测试周期总结',
      patterns: ['模式1'],
      improvements: ['改进1'],
      traitAdjustments: { goal_alignment: 0.8 },
      confidence: 0.7,
    })

    const ctx = cycle.getFormattedContext()
    expect(ctx).toContain('【自评总结】')
    expect(ctx).toContain('测试周期总结')
    expect(ctx).toContain('goal_alignment')
    expect(ctx).toContain('改进1')
  })

  it('should not crash when run() called without LLM', async () => {
    cycle.initialize({ identity, engineeringMemory: engMem, proceduralMemory: procMem, llmService: null as any })
    await expect(cycle.run()).resolves.toBeUndefined()
  })

  it('should load latest review from DB on re-init', () => {
    cycle.initialize({ identity, engineeringMemory: engMem, proceduralMemory: procMem, llmService: null as any })
    cycle.applyReview({
      summary: '初始评估',
      patterns: [],
      improvements: [],
      traitAdjustments: {},
      confidence: 0.5,
    })

    const cycle2 = new MetaCycle()
    cycle2.initialize({ identity, engineeringMemory: engMem, proceduralMemory: procMem, llmService: null as any })
    const ctx = cycle2.getFormattedContext()
    expect(ctx).toContain('初始评估')
  })

  it('should handle empty trait adjustments in applyReview', () => {
    cycle.initialize({ identity, engineeringMemory: engMem, proceduralMemory: procMem, llmService: null as any })
    cycle.applyReview({
      summary: '无调整',
      patterns: [],
      improvements: [],
      traitAdjustments: {},
      confidence: 0.5,
    })
    const ctx = cycle.getFormattedContext()
    expect(ctx).toContain('无调整')
  })
})
