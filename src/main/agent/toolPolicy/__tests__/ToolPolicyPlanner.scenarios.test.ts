/**
 * ADR-008 Regression Baseline — Scenario Tests
 *
 * 验证 Appendix A.3 的 10 场景回归基线。
 * 任何修改 ToolPolicyPlanner 或 ToolPromptAssembler 的变更必须与下表一致。
 */

import { describe, it, expect } from 'vitest'
import { ToolPolicyPlanner } from '../ToolPolicyPlanner'
import { ToolPromptAssembler } from '../ToolPromptAssembler'
import { ToolDecisionReason } from '../types'
import type { SceneLabel } from '../../UserBehaviorAnalyzer'

interface BaselineExpectation {
  scene: SceneLabel
  userText: string
  expectedPreference: string
  expectedReason: ToolDecisionReason
  expectedFilter: string[] | undefined
  expectPromptInjection: boolean
}

const planner = new ToolPolicyPlanner()
const assembler = new ToolPromptAssembler()

function runScenario(exp: BaselineExpectation) {
  const decision = planner.decide(exp.scene, exp.userText)
  const filter = planner.toToolFilter(decision)
  const prompt = assembler.assemble(decision)

  expect(decision.preference, `preference mismatch for "${exp.userText}"`).toBe(exp.expectedPreference)
  expect(decision.reason, `reason mismatch for "${exp.userText}"`).toBe(exp.expectedReason)
  expect(filter, `filter mismatch for "${exp.userText}"`).toEqual(exp.expectedFilter)

  if (exp.expectPromptInjection) {
    expect(prompt, `expected prompt injection for "${exp.userText}"`).toBeTypeOf('string')
  } else {
    expect(prompt, `expected no prompt injection for "${exp.userText}"`).toBeNull()
  }
}

describe('ADR-008 Regression Baseline — 10 Scenarios', () => {
  const CASES: BaselineExpectation[] = [
    // 1: Quick QA + 时间查询 → FRESH_INFORMATION → proactive, undefined, 注入
    {
      scene: 'quick_qa',
      userText: '现在几点了',
      expectedPreference: 'proactive',
      expectedReason: ToolDecisionReason.FRESH_INFORMATION,
      expectedFilter: undefined,
      expectPromptInjection: true,
    },
    // 2: Quick QA（纯简短）→ 无信号 → avoid, DEFAULT, [], 注入
    {
      scene: 'quick_qa',
      userText: '你好',
      expectedPreference: 'avoid',
      expectedReason: ToolDecisionReason.DEFAULT,
      expectedFilter: [],
      expectPromptInjection: true,
    },
    // 3: 新鲜信息查询 → FRESH_INFORMATION → proactive, undefined, 注入
    {
      scene: 'casual_chat',
      userText: '今天天气怎么样',
      expectedPreference: 'proactive',
      expectedReason: ToolDecisionReason.FRESH_INFORMATION,
      expectedFilter: undefined,
      expectPromptInjection: true,
    },
    // 4: 上传文件 → FILE_AVAILABLE → proactive, undefined, 注入
    {
      scene: 'quick_qa',
      userText: '我刚发了一个文件你看一下',
      expectedPreference: 'proactive',
      expectedReason: ToolDecisionReason.FILE_AVAILABLE,
      expectedFilter: undefined,
      expectPromptInjection: true,
    },
    // 5: 执行任务 → EXECUTION_TASK → proactive, undefined, 注入
    {
      scene: 'quick_qa',
      userText: '帮我实现一个排序函数',
      expectedPreference: 'proactive',
      expectedReason: ToolDecisionReason.EXECUTION_TASK,
      expectedFilter: undefined,
      expectPromptInjection: true,
    },
    // 6: Meta Feedback → META_FEEDBACK → proactive, undefined, 注入
    {
      scene: 'casual_chat',
      userText: '你只会说不会做',
      expectedPreference: 'proactive',
      expectedReason: ToolDecisionReason.META_FEEDBACK,
      expectedFilter: undefined,
      expectPromptInjection: true,
    },
    // 7: 显式工具请求 → USER_REQUEST → proactive, undefined, 注入
    {
      scene: 'casual_chat',
      userText: '用工具查一下这个',
      expectedPreference: 'proactive',
      expectedReason: ToolDecisionReason.USER_REQUEST,
      expectedFilter: undefined,
      expectPromptInjection: true,
    },
    // 8: Casual Chat → 无信号 → avoid, DEFAULT, [], 注入
    {
      scene: 'casual_chat',
      userText: '今天心情不错',
      expectedPreference: 'avoid',
      expectedReason: ToolDecisionReason.DEFAULT,
      expectedFilter: [],
      expectPromptInjection: true,
    },
    // 9: Code Debugging → 无信号 → proactive, DEFAULT, undefined, 注入
    {
      scene: 'code_debugging',
      userText: '这个bug怎么修',
      expectedPreference: 'proactive',
      expectedReason: ToolDecisionReason.DEFAULT,
      expectedFilter: undefined,
      expectPromptInjection: true,
    },
    // 10: Deep Discussion → 无信号 → auto, DEFAULT, undefined, 不注入
    {
      scene: 'deep_discussion',
      userText: '你怎么看这个架构设计',
      expectedPreference: 'auto',
      expectedReason: ToolDecisionReason.DEFAULT,
      expectedFilter: undefined,
      expectPromptInjection: false,
    },
  ]

  CASES.forEach((c, i) => {
    it(`Scenario ${i + 1}: "${c.userText}" → ${c.expectedPreference}/${c.expectedReason}`, () => {
      runScenario(c)
    })
  })
})
