/**
 * ReasoningPlanner Contract Test
 *
 * 验证：
 *  - 相同输入 ⇒ 相同 Directive（纯函数性质）
 *  - 每种 ThinkingPattern 正确映射
 *  - EMPTY_DIRECTIVE 在无需推理时返回
 *
 * 原则：
 *  - 不 mock 任何模块
 *  - 只测试 plan() 的纯函数行为
 *  - 测试用例如 ADR 附录可直接引用
 */

import { describe, expect, it } from 'vitest'
import { plan } from '@akemi-mio/reasoning/ReasoningPlanner'
import type { ReasoningDirective, ReasoningContext } from '@akemi-mio/reasoning/types'

/** 快捷构造 ReasoningContext */
function ctx(text: string, category?: string, scene?: string): ReasoningContext {
  return { input: { text, category, scene } }
}

/** 判别 Directive 是否为空 */
function isEmpty(d: ReasoningDirective): boolean {
  return d.pattern === 'none' && d.goals.length === 0 && d.constraints.length === 0 && d.outputStyle === 'default'
}

/** 判别 Directive 是否匹配指定 Pattern */
function hasPattern(d: ReasoningDirective, pattern: string): boolean {
  return d.pattern === pattern
}

describe('ReasoningPlanner contract', () => {
  // ─── 纯函数性质：相同输入返回相同 Directive ───

  it('should be deterministic: same input → same directive', () => {
    const input = ctx('为什么会这样？')
    const r1 = plan(input)
    const r2 = plan(input)
    expect(r1).toEqual(r2)
  })

  it('should be deterministic: empty input → same EMPTY', () => {
    const input = ctx('今天天气不错')
    const r1 = plan(input)
    const r2 = plan(input)
    expect(r1).toEqual(r2)
  })

  // ─── Pattern 映射 ───

  it('should return cause_effect for why questions', () => {
    const cases = ['为什么会这样？', '根因是什么？', '为何会出现这个问题？', 'why did this happen']
    for (const text of cases) {
      const d = plan(ctx(text))
      expect(hasPattern(d, 'cause_effect')).toBe(true)
    }
  })

  it('should return option_evaluation for comparison questions', () => {
    const cases = ['Redis 还是 SQLite？', '比较一下 A 和 B', '这两个方案的区别', '选哪个比较好']
    for (const text of cases) {
      const d = plan(ctx(text))
      expect(hasPattern(d, 'option_evaluation')).toBe(true)
    }
  })

  it('should return goal_constraint_tradeoff for evaluation questions', () => {
    const cases = ['评估一下这个方案', '这个技术怎么样', '有哪些优缺点', '值得升级吗']
    for (const text of cases) {
      const d = plan(ctx(text))
      expect(hasPattern(d, 'goal_constraint_tradeoff')).toBe(true)
    }
  })

  it('should return hypothesis_verification for hypothesis questions', () => {
    const cases = ['是不是内存泄漏？', '会不会是网络问题？', '可能缓存失效了']
    for (const text of cases) {
      const d = plan(ctx(text))
      expect(hasPattern(d, 'hypothesis_verification')).toBe(true)
    }
  })

  // ─── 场景透传 ───

  it('should respect scene=deep_discussion as goal_constraint_tradeoff', () => {
    const d = plan(ctx('我们聊聊这个设计', undefined, 'deep_discussion'))
    expect(hasPattern(d, 'goal_constraint_tradeoff')).toBe(true)
  })

  it('should respect scene=analysis as cause_effect', () => {
    const d = plan(ctx('分析一下数据', undefined, 'analysis'))
    expect(hasPattern(d, 'cause_effect')).toBe(true)
  })

  it('should respect scene=decision as option_evaluation', () => {
    const d = plan(ctx('决定用哪个方案', undefined, 'decision'))
    expect(hasPattern(d, 'option_evaluation')).toBe(true)
  })

  // ─── 默认无推理 ───

  it('should return EMPTY_DIRECTIVE for casual chat', () => {
    const d = plan(ctx('今天天气不错'))
    expect(isEmpty(d)).toBe(true)
  })

  it('should return EMPTY_DIRECTIVE for very short code queries', () => {
    const d = plan(ctx('git', 'code'))
    expect(isEmpty(d)).toBe(true)
  })

  // ─── 边界情况 ───

  it('should handle empty text gracefully', () => {
    const d = plan(ctx(''))
    // 不会抛异常，返回 EMPTY_DIRECTIVE
    expect(isEmpty(d)).toBe(true)
  })

  it('should handle very long text', () => {
    const longText = '为什么 '.repeat(1000)
    const d = plan(ctx(longText))
    // 长文本仍能正确匹配 keywords
    expect(hasPattern(d, 'cause_effect')).toBe(true)
  })

  it('should allocate goals and constraints for non-empty patterns', () => {
    const d = plan(ctx('为什么系统出错了？'))
    expect(d.goals.length).toBeGreaterThan(0)
  })
})
