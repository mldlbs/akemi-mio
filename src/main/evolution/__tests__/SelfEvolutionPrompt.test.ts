/**
 * SelfEvolutionPrompt 测试
 *
 * 验证点：
 * 1. 精简提示比完整系统提示减少 35%+ 的 token 数
 * 2. 精简提示保留核心进化分析指令
 * 3. 精简提示已移除 TTS/写作/插件/凭据模块
 */

import { describe, it, expect } from 'vitest'
import { buildEvolutionSystemPrompt, getEvolutionPromptTokens } from '../SelfEvolutionPrompt'
import { getBasePromptTokens } from '../../agent/context'

describe('SelfEvolutionPrompt — 精简提示体积验证', () => {
  it('精简提示 token 数应比完整系统提示减少 35% 以上', () => {
    const fullTokens = getBasePromptTokens()
    const evoTokens = getEvolutionPromptTokens()
    const reduction = 1 - evoTokens / fullTokens

    console.log(`完整系统提示 token 估算: ${fullTokens}`)
    console.log(`进化精简提示 token 估算: ${evoTokens}`)
    console.log(`缩减比例: ${(reduction * 100).toFixed(1)}%`)

    expect(reduction).toBeGreaterThanOrEqual(0.35)
  })
})

describe('SelfEvolutionPrompt — 内容完整性验证', () => {
  it('精简提示应包含核心分析指令', () => {
    const prompt = buildEvolutionSystemPrompt()
    expect(prompt).toContain('自进化系统')
    expect(prompt).toContain('分析模式')
    expect(prompt).toContain('create_dev_plan')
    expect(prompt).toContain('analyze_codebase')
  })

  it('精简提示不应包含 TTS 相关指令', () => {
    const prompt = buildEvolutionSystemPrompt()
    expect(prompt).not.toContain('TTS')
    expect(prompt).not.toContain('朗读')
    expect(prompt).not.toContain('口语化')
    expect(prompt).not.toContain('颜文字')
  })

  it('精简提示不应包含写作模式指令', () => {
    const prompt = buildEvolutionSystemPrompt()
    expect(prompt).not.toContain('小说创作')
    expect(prompt).not.toContain('写作系统')
    expect(prompt).not.toContain('curl')
  })

  it('精简提示不应包含凭据管理指令', () => {
    const prompt = buildEvolutionSystemPrompt()
    expect(prompt).not.toContain('凭据管理')
    // 工具列表中的 get_credential/set_credential 必然提及 "API 密钥"
    // 但凭据管理的详细说明段落已全部移除
  })

  it('精简提示不应包含插件系统说明', () => {
    const prompt = buildEvolutionSystemPrompt()
    expect(prompt).not.toContain('插件系统')
    expect(prompt).not.toContain('create_plugin')
  })

  it('精简提示支持记忆上下文注入', () => {
    const prompt = buildEvolutionSystemPrompt('用户偏好使用SQLite')
    expect(prompt).toContain('用户偏好使用SQLite')
    expect(prompt).toContain('长期记忆')
  })
})
