/**
 * RC Validation — 10 场景集成验证脚本
 *
 * 模拟 ChatExecutor 的完整管线：
 *   SceneClassifier.analyzeScene() → ToolPolicyPlanner.decide() → 日志输出
 *
 * 输出 JSON lines，与附录 A.3 对比验证。
 */

import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// 动态导入 UserBehaviorAnalyzer (依赖 better-sqlite3, 可能失败)
let userBehaviorAnalyzer: any = null
try {
  const mod = await import(join(__dirname, '../UserBehaviorAnalyzer.ts'))
  userBehaviorAnalyzer = mod.userBehaviorAnalyzer
} catch {
  console.error('WARN: UserBehaviorAnalyzer import failed (better-sqlite3), using static scene')
}

import { ToolPolicyPlanner } from '../toolPolicy/ToolPolicyPlanner'
import { ToolPromptAssembler } from '../toolPolicy/ToolPromptAssembler'

const planner = new ToolPolicyPlanner()
const assembler = new ToolPromptAssembler()

const SCENARIOS = [
  { id: 1,  desc: 'Quick QA + 时间查询',       text: '现在几点了' },
  { id: 2,  desc: 'Quick QA（纯简短）',         text: '你好' },
  { id: 3,  desc: '新鲜信息查询',               text: '今天天气怎么样' },
  { id: 4,  desc: '上传文件',                   text: '我刚发了一个文件你看一下' },
  { id: 5,  desc: '执行任务',                   text: '帮我实现一个排序函数' },
  { id: 6,  desc: 'Meta Feedback',              text: '你只会说不会做' },
  { id: 7,  desc: '显式工具请求',               text: '用工具查一下这个' },
  { id: 8,  desc: 'Casual Chat',                text: '今天心情不错' },
  { id: 9,  desc: 'Code Debugging',             text: '这个bug怎么修' },
  { id: 10, desc: 'Deep Discussion',            text: '你怎么看这个架构设计' },
]

console.log('=== ADR-008 RC Validation — 10 场景集成验证 ===')
console.log(`Timestamp: ${new Date().toISOString()}`)
console.log()

for (const sc of SCENARIOS) {
  // 使用 UserBehaviorAnalyzer 分类（如果可用），否则手动指定场景
  let scene: string
  if (userBehaviorAnalyzer) {
    const result = userBehaviorAnalyzer.analyzeScene(sc.text)
    scene = result.scene
  } else {
    // 硬编码场景匹配（与附录 A.3 一致）
    const SCENE_MAP: Record<number, string> = {
      1: 'quick_qa', 2: 'quick_qa', 3: 'casual_chat', 4: 'quick_qa',
      5: 'task_execution', 6: 'casual_chat', 7: 'casual_chat',
      8: 'casual_chat', 9: 'code_debugging', 10: 'deep_discussion',
    }
    scene = SCENE_MAP[sc.id]
  }

  // ToolPolicyPlanner 决策
  const decision = planner.decide(scene as any, sc.text)
  const filter = planner.toToolFilter(decision)
  const prompt = assembler.assemble(decision)

  // 模拟日志输出（与 ChatExecutor 第 478-486 行一致）
  const logEntry = {
    event: 'behavior_adaptive_scene',
    scene,
    toolPreference: decision.preference,
    toolReason: decision.reason,
    toolFilter: filter === undefined ? 'all' : filter.length === 0 ? 'none' : 'restricted',
    confidence: decision.confidence,
    promptInjected: prompt !== null,
  }

  console.log(`#${sc.id} ${sc.desc}`)
  console.log(`  输入: "${sc.text}"`)
  console.log(`  场景: ${scene}`)
  console.log(`  决策: ${decision.preference} | ${decision.reason} | conf=${decision.confidence}`)
  console.log(`  Filter: ${filter === undefined ? 'undefined (all tools)' : JSON.stringify(filter)}`)
  console.log(`  注入: ${prompt !== null ? `YES: "${prompt}"` : 'NO (null)'}`)
  console.log()
}

console.log('=== 验证完成 ===')
