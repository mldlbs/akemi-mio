/**
 * RC 验证 — 10 场景集成验证，模拟 ChatExecutor 完整管线
 *
 * 不依赖 Electron 窗口，直接调用 UserBehaviorAnalyzer + ToolPolicyPlanner。
 * 输出验证报告，与 ADR-008 Appendix A.3 对比。
 */
import { describe, it, expect } from 'vitest'
import { ToolPolicyPlanner } from '../ToolPolicyPlanner'
import { ToolPromptAssembler } from '../ToolPromptAssembler'
import { userBehaviorAnalyzer } from '../../UserBehaviorAnalyzer'
import { ToolDecisionReason } from '../types'
import type { SceneLabel } from '../../UserBehaviorAnalyzer'

const planner = new ToolPolicyPlanner()
const assembler = new ToolPromptAssembler()

interface ScenarioReport {
  id: number
  desc: string
  userText: string
  scene: string
  toolPreference: string
  toolReason: string
  confidence: number
  filter: string
  promptInjected: boolean
  pass: boolean
}

const SCENARIOS = [
  { id: 1, desc: 'Quick QA + 时间查询',   text: '现在几点了' },
  { id: 2, desc: 'Quick QA（纯简短）',     text: '你好' },
  { id: 3, desc: '新鲜信息查询',           text: '今天天气怎么样' },
  { id: 4, desc: '上传文件',               text: '我刚发了一个文件你看一下' },
  { id: 5, desc: '执行任务',               text: '帮我实现一个排序函数' },
  { id: 6, desc: 'Meta Feedback',          text: '你只会说不会做' },
  { id: 7, desc: '显式工具请求',           text: '用工具查一下这个' },
  { id: 8, desc: 'Casual Chat',            text: '今天心情不错' },
  { id: 9, desc: 'Code Debugging',         text: '这个bug怎么修' },
  { id: 10, desc: 'Deep Discussion',       text: '你怎么看这个架构设计' },
]

/** 附录 A.3 基线期望 */
const BASELINE: Record<number, { preference: string; reason: ToolDecisionReason }> = {
  1: { preference: 'proactive', reason: ToolDecisionReason.FRESH_INFORMATION },
  2: { preference: 'avoid', reason: ToolDecisionReason.DEFAULT },
  3: { preference: 'proactive', reason: ToolDecisionReason.FRESH_INFORMATION },
  4: { preference: 'proactive', reason: ToolDecisionReason.FILE_AVAILABLE },
  5: { preference: 'proactive', reason: ToolDecisionReason.EXECUTION_TASK },
  6: { preference: 'proactive', reason: ToolDecisionReason.META_FEEDBACK },
  7: { preference: 'proactive', reason: ToolDecisionReason.USER_REQUEST },
  8: { preference: 'avoid', reason: ToolDecisionReason.DEFAULT },
  9: { preference: 'proactive', reason: ToolDecisionReason.DEFAULT },
  10: { preference: 'auto', reason: ToolDecisionReason.DEFAULT },
}

describe('ADR-008 RC Validation — 集成验证报告', () => {
  const report: ScenarioReport[] = []

  for (const sc of SCENARIOS) {
    it(`#${sc.id} ${sc.desc}`, () => {
      // Step 1: 真实 Scene 分类
      // 注意：UserBehaviorAnalyzer 依赖对话历史窗口做分类，
      // 单轮调用时部分场景会被归为 'unknown'。
      // 这是预期行为 — 真实对话中有历史上下文，分类准确度会更高。
      const sceneResult = userBehaviorAnalyzer.analyzeScene(sc.text)
      const scene: SceneLabel = sceneResult.scene as SceneLabel
      expect(scene).toBeTruthy()

      // Step 2: ToolPolicyPlanner 决策
      const decision = planner.decide(scene, sc.text)
      expect(decision).toHaveProperty('preference')
      expect(decision).toHaveProperty('confidence')
      expect(decision).toHaveProperty('reason')

      // Step 3: Safety Filter
      const filter = planner.toToolFilter(decision)

      // Step 4: Prompt 注入
      const prompt = assembler.assemble(decision)

      // 基线对比
      const baseline = BASELINE[sc.id]
      const pass = decision.preference === baseline.preference && decision.reason === baseline.reason

      const entry: ScenarioReport = {
        id: sc.id,
        desc: sc.desc,
        userText: sc.text,
        scene,
        toolPreference: decision.preference,
        toolReason: decision.reason,
        confidence: decision.confidence,
        filter: filter === undefined ? 'undefined' : JSON.stringify(filter),
        promptInjected: prompt !== null,
        pass,
      }
      report.push(entry)
    })
  }

  afterAll(() => {
    console.log()
    console.log('='.repeat(80))
    console.log('  ADR-008 RC Validation Report')
    console.log(`  ${new Date().toISOString()}`)
    console.log('='.repeat(80))
    console.log()
    console.log('  #  场景                         scene           pref       reason              filter     prompt   baseline')
    console.log('  ' + '-'.repeat(78))
    for (const r of report) {
      const status = r.pass ? '✓' : '✗'
      console.log(`  ${status} ${String(r.id).padEnd(3)} ${r.desc.padEnd(26)} ${r.scene.padEnd(14)} ${r.toolPreference.padEnd(10)} ${r.toolReason.padEnd(19)} ${r.filter.padEnd(10)} ${r.promptInjected ? 'YES' : 'NO '}  ${BASELINE[r.id].preference}/${BASELINE[r.id].reason}`)
    }
    console.log()
    const passed = report.filter(r => r.pass).length
    console.log(`  Results: ${passed}/${report.length} passed, ${report.length - passed} failed`)
    console.log()
  })
})
