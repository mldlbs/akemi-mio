/**
 * IdentityModule 单元测试
 *
 * 测试策略：
 * - 使用真实的 DB（initDatabase/closeDatabase 模式）
 * - 用临时 CONSTITUTION.md 文件测试冷启动解析
 * - 测试 trait 演化、会话记录、hash 变更检测
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { IdentityModule } from '@akemi-mio/intelligence/identity/IdentityModule'
import { initDatabase, closeDatabase } from '@akemi-mio/core/db/connection'
import { buildIdentityPrompt } from '@akemi-mio/intelligence/identity/prompts'
import { useIsolatedTestDatabase } from '../../db/__tests__/testDatabase'

const TEST_CONSTITUTION = join(process.cwd(), 'test-CONSTITUTION.md')

const SAMPLE_CONSTITUTION = `# Constitution

> 测试身份。

## Core Identity

- name: 测试助手
- role: 开发伙伴
- version: 1.0.0

## Capabilities

- 编码 — 写代码、改代码
- 调试 — 分析错误、修复问题

## Personality

- 严谨 — 代码质量第一
- 高效 — 不做多余操作

## Constraints

- 不操作生产环境
- 不删除未备份数据
`

const UPDATED_CONSTITUTION = `# Constitution

> 更新后的身份。

## Core Identity

- name: 测试助手 v2
- role: 高级开发伙伴
- version: 2.0.0

## Capabilities

- 编码 — 写代码、改代码、重构
- 调试 — 分析错误、修复问题、性能调优
- 架构设计 — 系统设计、技术选型

## Personality

- 严谨 — 代码质量第一
- 高效 — 不做多余操作
- 主动 — 提前发现潜在问题

## Constraints

- 不操作生产环境
- 不删除未备份数据
- 不执行未授权的操作
`

describe('IdentityModule', () => {
  let identity: IdentityModule
  let restoreTestDatabase: () => void

  beforeEach(async () => {
    if (existsSync(TEST_CONSTITUTION)) unlinkSync(TEST_CONSTITUTION)
    restoreTestDatabase = useIsolatedTestDatabase()
    await initDatabase()
    writeFileSync(TEST_CONSTITUTION, SAMPLE_CONSTITUTION, 'utf-8')
    identity = new IdentityModule()
  })

  afterEach(() => {
    closeDatabase()
    if (existsSync(TEST_CONSTITUTION)) unlinkSync(TEST_CONSTITUTION)
    restoreTestDatabase()
  })

  it('should initialize from constitution on cold start', async () => {
    await identity.initialize(TEST_CONSTITUTION)
    const core = identity.getCoreIdentity()
    expect(core).not.toBeNull()
    expect(core!.name).toBe('测试助手')
    expect(core!.role).toBe('开发伙伴')
    expect(core!.capabilities).toHaveLength(2)
    expect(core!.personality).toHaveLength(2)
    expect(core!.constraints).toHaveLength(2)
    expect(core!.constitutionHash).toHaveLength(64)
  })

  it('should load from DB on subsequent init (same hash)', async () => {
    await identity.initialize(TEST_CONSTITUTION)
    const firstHash = identity.getCoreIdentity()!.constitutionHash
    const identity2 = new IdentityModule()
    await identity2.initialize(TEST_CONSTITUTION)
    expect(identity2.getCoreIdentity()!.constitutionHash).toBe(firstHash)
    expect(identity2.getCoreIdentity()!.name).toBe('测试助手')
  })

  it('should detect constitution changes and re-parse', async () => {
    await identity.initialize(TEST_CONSTITUTION)
    writeFileSync(TEST_CONSTITUTION, UPDATED_CONSTITUTION, 'utf-8')
    const identity2 = new IdentityModule()
    await identity2.initialize(TEST_CONSTITUTION)
    expect(identity2.getCoreIdentity()!.name).toBe('测试助手 v2')
    expect(identity2.getCoreIdentity()!.role).toBe('高级开发伙伴')
    expect(identity2.getCoreIdentity()!.capabilities).toHaveLength(3)
  })

  it('should provide formatted context after init', async () => {
    await identity.initialize(TEST_CONSTITUTION)
    const ctx = identity.getFormattedContext()
    expect(ctx).toContain('测试助手')
    expect(ctx).toContain('开发伙伴')
    expect(ctx).toContain('编码')
  })

  it('should return empty context before init', () => {
    expect(identity.getFormattedContext()).toBe('')
  })

  it('should have default traits from migration', async () => {
    await identity.initialize(TEST_CONSTITUTION)
    const traits = identity.getTraits()
    expect(traits).toHaveLength(3)
    const alignment = traits.find((t) => t.name === 'goal_alignment')
    expect(alignment).toBeDefined()
    expect(alignment!.value).toBe(0.7)
    expect(alignment!.trend).toBe('stable')
  })

  it('should update traits with EMA smoothing', async () => {
    await identity.initialize(TEST_CONSTITUTION)
    identity.updateTraits({ score: 0.9, reason: 'tool_success' })
    let trait = identity.getTraits().find((t) => t.name === 'tool_efficiency')
    expect(trait!.value).toBeCloseTo(0.69, 2)
    expect(trait!.sampleCount).toBe(1)
    identity.updateTraits({ score: 0.2, reason: 'tool_failure' })
    trait = identity.getTraits().find((t) => t.name === 'tool_efficiency')
    expect(trait!.value).toBeCloseTo(0.543, 2)
    expect(trait!.sampleCount).toBe(2)
  })

  it('should persist trait updates to DB', async () => {
    await identity.initialize(TEST_CONSTITUTION)
    identity.updateTraits({ score: 0.95, reason: 'session_positive' })
    const identity2 = new IdentityModule()
    await identity2.initialize(TEST_CONSTITUTION)
    const trait = identity2.getTraits().find((t) => t.name === 'response_quality')
    expect(trait!.value).toBeCloseTo(0.78, 1)
  })

  it('should record sessions and maintain running avg score', async () => {
    await identity.initialize(TEST_CONSTITUTION)
    identity.recordSession('chat', 0.8)
    identity.recordSession('development', 0.6)
    const metrics = identity.getMetrics()
    expect(metrics!.sessionsCompleted).toBe(2)
    expect(metrics!.avgScore).toBeCloseTo(0.84, 1)
  })

  it('should record tool calls and goal drifts', async () => {
    await identity.initialize(TEST_CONSTITUTION)
    identity.recordToolCall()
    identity.recordToolCall()
    identity.recordToolCall()
    identity.recordGoalDrift()
    const metrics = identity.getMetrics()
    expect(metrics!.toolsUsed).toBe(3)
    expect(metrics!.goalsDrifted).toBe(1)
  })

  it('should provide complete snapshot', async () => {
    await identity.initialize(TEST_CONSTITUTION)
    identity.recordSession('chat', 0.9)
    identity.updateTraits({ score: 0.8, reason: 'tool_success' })
    const snap = identity.getSnapshot()
    expect(snap.core).not.toBeNull()
    expect(snap.core!.name).toBe('测试助手')
    expect(snap.traits).toHaveLength(3)
    expect(snap.metrics).not.toBeNull()
    expect(snap.metrics!.sessionsCompleted).toBe(1)
  })

  it('should handle missing constitution file gracefully', async () => {
    if (existsSync(TEST_CONSTITUTION)) unlinkSync(TEST_CONSTITUTION)
    await identity.initialize('/nonexistent/path.md')
    expect(identity.getFormattedContext()).toBe('')
    expect(identity.getCoreIdentity()).toBeNull()
    expect(identity.getTraits()).toHaveLength(3)
  })

  it('should persist metrics to DB across reloads', async () => {
    await identity.initialize(TEST_CONSTITUTION)
    identity.recordToolCall()
    identity.recordToolCall()
    identity.recordSession('chat', 0.7)
    const identity2 = new IdentityModule()
    await identity2.initialize(TEST_CONSTITUTION)
    const metrics = identity2.getMetrics()
    expect(metrics!.toolsUsed).toBe(2)
    expect(metrics!.sessionsCompleted).toBe(1)
  })
})

describe('buildIdentityPrompt', () => {
  it('should produce expected prompt format', () => {
    const prompt = buildIdentityPrompt(
      {
        constitutionHash: 'abc',
        name: '测试',
        role: '助手',
        personality: ['温柔', '高效'],
        capabilities: ['聊天', '编码'],
        constraints: ['不操作生产'],
        createdAt: 1000,
        updatedAt: 1000,
      },
      {
        sessionsCompleted: 5,
        toolsUsed: 10,
        goalsCompleted: 2,
        goalsDrifted: 1,
        avgScore: 0.8,
        constitutionChecksum: 'abc',
        lastUpdated: 1000,
      },
    )
    expect(prompt).toContain('你是测试')
    expect(prompt).toContain('助手')
    expect(prompt).toContain('聊天、编码')
    expect(prompt).toContain('已完成 5 次会话')
  })

  it('should omit metrics section when no data', () => {
    const prompt = buildIdentityPrompt(
      {
        constitutionHash: 'abc',
        name: '测试',
        role: '助手',
        personality: [],
        capabilities: ['聊天'],
        constraints: [],
        createdAt: 1000,
        updatedAt: 1000,
      },
      {
        sessionsCompleted: 0,
        toolsUsed: 0,
        goalsCompleted: 0,
        goalsDrifted: 0,
        avgScore: 1.0,
        constitutionChecksum: 'abc',
        lastUpdated: 1000,
      },
    )
    expect(prompt).not.toContain('已完成')
    expect(prompt).not.toContain('自我评估')
  })
})
