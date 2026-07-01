/**
 * ActionPlanner — 将分析结果映射为确定性动作序列
 *
 * 输入：AnalysisResult + evolution_state.json 当前状态 + living_plan/ 脚本列表
 * 输出：Action[] 动作序列（最多 3 个，防止失控）
 *
 * 核心原则：
 * - 纯函数（无 side effect，无 LLM 调用）
 * - 完不成就少做，不要创建抽象计划
 * - 失败不影响之前的成功动作
 */

import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { ActionRegistry, type Action, type ActionSequence } from './ActionRegistry'
import type { AnalysisResult } from './pipeline/types'
import { WORKSPACE } from '../config'
import type { ExecutionTracer } from './ExecutionTracer'

const LIVING_PLAN_DIR = ActionRegistry.LIVING_PLAN_DIR
const EVOLUTION_STATE_PATH = ActionRegistry.EVOLUTION_STATE_PATH

/**
 * living_plan/ 中已知可调用的工具脚本及其导出函数
 * 按优先级排序（高价值工具优先）
 */
const KNOWN_SCRIPTS: { file: string; exportName: string; description: string; priority: number }[] = [
  { file: 'config-watchdog.mjs', exportName: 'runConfigWatchdog', description: '全量配置漂移检测与修正', priority: 90 },
  { file: 'goal-tracker.mjs', exportName: 'updateAllGoalProgresses', description: '更新目标进度', priority: 60 },
  { file: 'state-manager.mjs', exportName: 'readState', description: '读取并验证状态文件完整性', priority: 50 },
]

/**
 * 检测 evolution_state.json 中与黄金配置的偏差
 */
function detectConfigDrifts(): { key: string; expected: any; actual: any }[] {
  if (!existsSync(EVOLUTION_STATE_PATH)) return []

  try {
    const raw = readFileSync(EVOLUTION_STATE_PATH, 'utf-8')
    const state = JSON.parse(raw)
    const drifts: { key: string; expected: any; actual: any }[] = []

    for (const [key, expected] of Object.entries(ActionRegistry.GOLDEN_CONFIG)) {
      if (state[key] !== expected) {
        drifts.push({ key, expected, actual: state[key] })
      }
    }
    return drifts
  } catch {
    return []
  }
}

/**
 * 列出 living_plan/ 中存在的脚本文件名
 */
function listAvailableScripts(): string[] {
  try {
    if (!existsSync(LIVING_PLAN_DIR)) return []
    return readdirSync(LIVING_PLAN_DIR).filter((f) => f.endsWith('.mjs'))
  } catch {
    return []
  }
}

/**
 * 从 AnalysisResult.summary 中提取修正指令
 *
 * 分析 prompt 现在引导 LLM 输出形如：
 *   ##fix: historyMaxEntries=10
 *   ##fix: analysisTimeoutMs=150000
 * 的行。如果没有这种结构化输出，返回空数组。
 */
function extractFixInstructions(summary: string): { key: string; value: any }[] {
  if (!summary) return []

  const fixes: { key: string; value: any }[] = []
  const lines = summary.split('\n')

  for (const line of lines) {
    const match = line.match(/##fix:\s*(\w+)\s*=\s*(.+)/)
    if (match) {
      const key = match[1].trim()
      const rawValue = match[2].trim()

      // 尝试解析为数字，否则保持字符串
      let value: any = rawValue
      if (/^\d+$/.test(rawValue)) value = parseInt(rawValue, 10)
      else if (/^\d+\.\d+$/.test(rawValue)) value = parseFloat(rawValue)
      else if (rawValue === 'true') value = true
      else if (rawValue === 'false') value = false

      fixes.push({ key, value })
    }
  }

  return fixes
}

/**
 * 构建动作序列
 *
 * @param analysisResult  刚完成的分析结果
 * @param tracer          可选的 trace 记录器（Phase 1 插桩）
 * @returns 动作序列（最多 3 个）
 */
export function plan(
  analysisResult: { success: boolean; summary: string; planCreated: boolean },
  tracer?: ExecutionTracer,
): ActionSequence {
  const actions: { name: string; params?: any }[] = []

  // ── 1. 检查配置漂移 ──────────────────────────────────────
  const drifts = detectConfigDrifts()
  if (drifts.length > 0) {
    tracer?.recordPlan('detect_config_drift', { drifts }, { decision: 'batch_fix_config' }, { token: 0, latency: 0 })
    actions.push({ name: 'batch_fix_config' })
  }

  // ── 2. 分析结果中是否包含显式修正指令 ────────────────────
  if (actions.length === 0 && analysisResult.success) {
    const fixInstructions = extractFixInstructions(analysisResult.summary)
    if (fixInstructions.length > 0) {
      tracer?.recordPlan(
        'extract_fix_instructions',
        { count: fixInstructions.length },
        { decision: 'fix_config' },
        { token: 0, latency: 0 },
      )
    }
    for (const fix of fixInstructions) {
      if (actions.length >= 3) break
      actions.push({
        name: 'fix_config',
        params: { key: fix.key, value: fix.value, reason: 'analysis_fix_instruction' },
      })
    }
  }

  // ── 3. LLM 创建了计划 → 说明有更高价值的工作要做 ────────
  if (analysisResult.planCreated && actions.length === 0) {
    tracer?.recordPlan('plan_created_workflow', { planCreated: true }, { decision: 'run_config_watchdog' }, { token: 0, latency: 0 })
    actions.push({ name: 'run_config_watchdog' })
  }

  // ── 4. 保底：如果 living_plan/ 中有工具从未执行过 ───────
  if (actions.length === 0) {
    const availableScripts = listAvailableScripts()
    if (availableScripts.length > 0) {
      for (const known of KNOWN_SCRIPTS) {
        if (availableScripts.includes(known.file)) {
          tracer?.recordPlan('fallback_script', { script: known.file }, { decision: 'run_script' }, { token: 0, latency: 0 })
          actions.push({ name: 'run_script', params: { script: known.file, exportName: known.exportName } })
          break
        }
      }
    }
  }

  // ── 限制最大动作数 ──────────────────────────────────────
  const capped = actions.slice(0, 3)

  return {
    actions: capped.map((a) => ({
      name: a.name,
      description: ActionRegistry.get(a.name)?.description || a.name,
      category: ActionRegistry.get(a.name)?.category || 'script_run',
      run: () => ActionRegistry.get(a.name)!.run(a.params),
    })),
    context: {
      triggeredBy: `analysis: ${analysisResult.summary?.slice(0, 120)}`,
      analysisTimestamp: Date.now(),
    },
  }
}

/**
 * 可读格式报告动作序列
 */
export function formatActionPlan(sequence: ActionSequence): string {
  if (sequence.actions.length === 0) return '无需执行动作'

  const lines = sequence.actions.map((a, i) => `  ${i + 1}. [${a.category}] ${a.name} — ${a.description}`)
  return `动作计划 (${sequence.actions.length} 步):\n${lines.join('\n')}`
}
