import type { SkillManifest, InstalledSkill } from './SkillTypes'
import { log } from '../logger/Logger'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export interface SkillAgentDef {
  skillName: string
  allowedTools: string[]
  systemPrompt: string
  outputSchema: Record<string, unknown>
  requiresInput: Record<string, unknown>
}

/**
 * SkillAgentRegistry — Executor 技能注册表
 *
 * 加载 executor 类型的技能时，记录其工具列表、SKILL.md 生成的 system prompt、
 * 以及输入/输出 schema，供 ScopedAgent 创建时使用。
 */
export class SkillAgentRegistry {
  private agents = new Map<string, SkillAgentDef>()

  /**
   * 注册一个 executor 技能
   */
  register(manifest: SkillManifest, allowedTools: string[], skillsDir: string): void {
    if (manifest.type !== 'executor') return

    const promptPath = join(skillsDir, manifest.name, 'prompt.md')
    const skillMdPath = join(skillsDir, manifest.name, 'SKILL.md')
    const promptFile = existsSync(promptPath) ? promptPath : existsSync(skillMdPath) ? skillMdPath : null
    const promptContent = promptFile ? readFileSync(promptFile, 'utf-8') : ''

    const def: SkillAgentDef = {
      skillName: manifest.name,
      allowedTools,
      systemPrompt: this.buildSystemPrompt(manifest.name, promptContent),
      outputSchema: {},
      requiresInput: {},
    }

    this.agents.set(manifest.name, def)
    log('INFO', 'skill_agent_registered', { name: manifest.name, tools: allowedTools.length })
  }

  /**
   * 取消注册一个技能
   */
  unregister(skillName: string): void {
    this.agents.delete(skillName)
  }

  /**
   * 获取已注册的 executor 技能
   */
  get(skillName: string): SkillAgentDef | undefined {
    return this.agents.get(skillName)
  }

  /**
   * 获取所有 executor 技能定义
   */
  getAll(): SkillAgentDef[] {
    return Array.from(this.agents.values())
  }

  /**
   * 判断是否存在
   */
  has(skillName: string): boolean {
    return this.agents.has(skillName)
  }

  private buildSystemPrompt(skillName: string, promptContent: string): string {
    return `你是一个执行「${skillName}」技能的专用助手。

你的任务：严格按照以下技能说明执行，不要偏离。

=== 技能说明 ===
${promptContent}

=== 执行规则 ===
1. 只使用分配给你的工具
2. 严格按照输入参数执行
3. 完成后以 JSON 格式返回结果：{ "success": true/false, "data": ..., "error": "错误信息（如有）" }
4. 不要在结果之外输出任何额外内容
5. 如果遇到无法处理的情况，返回 error 而非猜测`
  }
}

/** 全局单例 */
export const skillAgentRegistry = new SkillAgentRegistry()
