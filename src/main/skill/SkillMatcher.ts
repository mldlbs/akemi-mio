import { SkillManifest } from './SkillTypes'

export interface MatchedSkill {
  manifest: SkillManifest
  weight: number
  matchType: 'keyword' | 'description' | 'semantic'
}

/**
 * SkillMatcher — Trigger 匹配引擎
 *
 * 根据用户输入匹配已安装技能的 triggers，返回匹配列表。
 * 匹配优先级：精确命中 > 描述模糊匹配 > 语义兜底
 */
export class SkillMatcher {
  /**
   * 精确关键词匹配：input 包含 trigger 中的任意一个词
   */
  matchByKeyword(input: string, triggers: string[]): boolean {
    if (!triggers || triggers.length === 0) return false
    const lower = input.toLowerCase()
    return triggers.some((t) => {
      const kw = t.toLowerCase()
      // 全词匹配
      if (lower.includes(kw)) return true
      // 空格分割的多词组合（如 "powerpoint 演示"），需要全部命中
      if (kw.includes(' ')) {
        const parts = kw.split(/\s+/).filter(Boolean)
        return parts.every((p) => lower.includes(p))
      }
      return false
    })
  }

  /**
   * 描述模糊匹配：检查技能名称或 description 是否包含 input 中的关键片段
   */
  matchByDescription(input: string, manifest: SkillManifest): boolean {
    const lower = input.toLowerCase()
    const name = manifest.name.toLowerCase()
    const desc = (manifest.description || '').toLowerCase()
    // 技能名命中（如输入 "ppt" 匹配技能 "pptx"）
    if (name.includes(lower) || lower.includes(name)) return true
    // 描述中包含输入的关键字
    const words = lower.split(/[\s,，、。.]+/).filter((w) => w.length >= 2)
    return words.some((w) => desc.includes(w))
  }

  /**
   * 综合匹配入口
   */
  match(input: string, allSkills: SkillManifest[]): MatchedSkill[] {
    if (!input || !allSkills.length) return []

    const results: MatchedSkill[] = []

    for (const manifest of allSkills) {
      const triggers = manifest.triggers || []

      // Phase 1: 精确关键词匹配
      const keywordHit = this.matchByKeyword(input, triggers)
      if (keywordHit) {
        results.push({ manifest, weight: 1.0, matchType: 'keyword' })
        continue
      }

      // Phase 2: 描述/名称模糊匹配
      const descHit = this.matchByDescription(input, manifest)
      if (descHit) {
        results.push({ manifest, weight: 0.6, matchType: 'description' })
        continue
      }
    }

    return results
  }
}
