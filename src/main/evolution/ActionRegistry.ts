/**
 * ActionRegistry — 进化可执行动作注册表
 *
 * 将分析阶段的发现映射为确定性、低延迟的可执行动作。
 * 与旧的 EvolutionExecutor 不同，这些动作无需 LLM agent 驱动，
 * 纯 Node.js 同步/轻量异步操作，<5s 完成。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import type { ActionContext } from './ActionContext'
import { log } from '../logger/Logger'
import { eventBus } from '../core/EventBus'
import { WORKSPACE } from '../config'

// ─── 类型定义 ────────────────────────────────────────────────────

export interface Action {
  name: string
  description: string
  category: 'config_fix' | 'script_run' | 'file_edit' | 'git_op' | 'verify'
  run: (params: any, ctx?: ActionContext) => Promise<ActionResult>
}

export interface ActionResult {
  success: boolean
  summary: string
  durationMs: number
  details?: any
}

export interface ActionSequence {
  actions: Action[]
  context: {
    // 动作计划的来源分析摘要（用于日志和报告）
    triggeredBy: string
    analysisTimestamp: number
  }
}

// ─── 路径常量 ────────────────────────────────────────────────────

const EVOLUTION_STATE_PATH = join(WORKSPACE.evolution, 'living_plan', 'evolution_state.json')
const LIVING_PLAN_DIR = join(WORKSPACE.evolution, 'living_plan')

// ─── 黄金配置（与 config-watchdog.mjs 保持一致） ──────────────────

const GOLDEN_CONFIG: Record<string, any> = {
  promptTrimMode: true,
  analysisStuckTimeoutMs: 30000,
  analysisTimeoutMs: 150000,
  historyMaxEntries: 10,
}

// ─── 动作注册 ────────────────────────────────────────────────────

const registry = new Map<string, Action>()

/** 注册一个动作 */
function register(action: Action): void {
  registry.set(action.name, action)
}

/** 按名称获取动作 */
function get(name: string): Action | undefined {
  return registry.get(name)
}

/** 列出所有注册动作 */
function list(): Action[] {
  return Array.from(registry.values())
}

// ═════════════════════════════════════════════════════════════════
// fix_config — 修正 evolution_state.json 中的配置值
// ═════════════════════════════════════════════════════════════════

register({
  name: 'fix_config',
  description: '修复 evolution_state.json 中的配置漂移',
  category: 'config_fix',
  run: async (params: { key: string; value: any; reason?: string }): Promise<ActionResult> => {
    const startedAt = Date.now()
    try {
      if (!existsSync(EVOLUTION_STATE_PATH)) {
        return { success: false, summary: `evolution_state.json 不存在`, durationMs: Date.now() - startedAt }
      }

      const raw = readFileSync(EVOLUTION_STATE_PATH, 'utf-8')
      const state = JSON.parse(raw)
      const oldValue = state[params.key]

      if (oldValue === params.value) {
        return {
          success: true,
          summary: `${params.key} 已经是期望值 ${JSON.stringify(params.value)}，无需修正`,
          durationMs: Date.now() - startedAt,
        }
      }

      state[params.key] = params.value

      // 记录修正历史
      const driftHistory = Array.isArray(state.configDriftHistory) ? [...state.configDriftHistory] : []
      driftHistory.push({
        timestamp: Date.now(),
        key: params.key,
        from: oldValue,
        to: params.value,
        reason: params.reason || 'evolution_action',
      })
      if (driftHistory.length > 50) driftHistory.splice(0, driftHistory.length - 50)
      state.configDriftHistory = driftHistory

      writeFileSync(EVOLUTION_STATE_PATH, JSON.stringify(state, null, 2), 'utf-8')
      log('INFO', 'action_fix_config', { key: params.key, from: oldValue, to: params.value })

      return {
        success: true,
        summary: `${params.key}: ${JSON.stringify(oldValue)} → ${JSON.stringify(params.value)}`,
        durationMs: Date.now() - startedAt,
        details: { key: params.key, from: oldValue, to: params.value },
      }
    } catch (err: any) {
      return { success: false, summary: `fix_config 失败: ${err.message}`, durationMs: Date.now() - startedAt }
    }
  },
})

// ═════════════════════════════════════════════════════════════════
// run_script — 动态加载并执行 living_plan/ 中的工具脚本
// ═════════════════════════════════════════════════════════════════

register({
  name: 'run_script',
  description: '执行 living_plan/ 目录下的工具脚本',
  category: 'script_run',
  run: async (params: { script: string; exportName?: string; args?: any }): Promise<ActionResult> => {
    const startedAt = Date.now()
    const scriptPath = join(LIVING_PLAN_DIR, params.script)

    try {
      if (!existsSync(scriptPath)) {
        return { success: false, summary: `脚本不存在: ${params.script}`, durationMs: Date.now() - startedAt }
      }

      // 动态加载 ES module
      const mod = await import(/* @vite-ignore */ scriptPath)

      // 如果指定了导出函数名，调用它
      if (params.exportName) {
        const fn = mod[params.exportName]
        if (typeof fn !== 'function') {
          return {
            success: false,
            summary: `脚本 ${params.script} 未导出函数 ${params.exportName}`,
            durationMs: Date.now() - startedAt,
          }
        }
        const result = params.args ? await fn(params.args) : await fn()
        log('INFO', 'action_run_script', { script: params.script, exportName: params.exportName, success: true })
        return {
          success: true,
          summary: `执行 ${params.script}#${params.exportName} 完成`,
          durationMs: Date.now() - startedAt,
          details: result,
        }
      }

      // 未指定导出函数：如果脚本有默认执行逻辑，import 即触发
      // （部分脚本如 fix-bootstrap-config.mjs 有 CLI 自执行逻辑）
      log('INFO', 'action_run_script', { script: params.script, exportName: '(module loaded)', success: true })
      return {
        success: true,
        summary: `加载 ${params.script} 完成`,
        durationMs: Date.now() - startedAt,
      }
    } catch (err: any) {
      return { success: false, summary: `执行 ${params.script} 失败: ${err.message}`, durationMs: Date.now() - startedAt }
    }
  },
})

// ═════════════════════════════════════════════════════════════════
// verify_state — 验证 evolution_state.json 配置是否符合期望
// ═════════════════════════════════════════════════════════════════

register({
  name: 'verify_state',
  description: '验证 evolution_state.json 配置是否与黄金配置一致',
  category: 'verify',
  run: async (params?: { expected?: Record<string, any> }): Promise<ActionResult> => {
    const startedAt = Date.now()
    const expected = params?.expected || GOLDEN_CONFIG

    try {
      if (!existsSync(EVOLUTION_STATE_PATH)) {
        return { success: false, summary: `evolution_state.json 不存在`, durationMs: Date.now() - startedAt }
      }

      const raw = readFileSync(EVOLUTION_STATE_PATH, 'utf-8')
      const state = JSON.parse(raw)

      const drifts: { key: string; expected: any; actual: any }[] = []
      for (const [key, expectedValue] of Object.entries(expected)) {
        if (state[key] !== expectedValue) {
          drifts.push({ key, expected: expectedValue, actual: state[key] })
        }
      }

      if (drifts.length === 0) {
        return { success: true, summary: '所有配置值与黄金配置一致', durationMs: Date.now() - startedAt, details: { drifted: false } }
      }

      return {
        success: true,
        summary: `检测到 ${drifts.length} 个配置漂移: ${drifts.map((d) => `${d.key}=${JSON.stringify(d.actual)}`).join(', ')}`,
        durationMs: Date.now() - startedAt,
        details: { drifted: true, drifts },
      }
    } catch (err: any) {
      return { success: false, summary: `verify_state 失败: ${err.message}`, durationMs: Date.now() - startedAt }
    }
  },
})

// ═════════════════════════════════════════════════════════════════
// emit_event — 向 EventBus 发送通知
// ═════════════════════════════════════════════════════════════════

register({
  name: 'emit_event',
  description: '发送 EventBus 事件通知下游服务',
  category: 'git_op',
  run: async (params: { event: string; payload?: any }): Promise<ActionResult> => {
    const startedAt = Date.now()
    try {
      eventBus.emit(params.event as any, params.payload || {})
      log('INFO', 'action_emit_event', { event: params.event })
      return { success: true, summary: `事件已发送: ${params.event}`, durationMs: Date.now() - startedAt }
    } catch (err: any) {
      return { success: false, summary: `emit_event 失败: ${err.message}`, durationMs: Date.now() - startedAt }
    }
  },
})

// ═════════════════════════════════════════════════════════════════
// run_config_watchdog — 运行 living_plan/config-watchdog.mjs
// ═════════════════════════════════════════════════════════════════

register({
  name: 'run_config_watchdog',
  description: '运行 living_plan/config-watchdog.mjs 的全量配置漂移检测与修正',
  category: 'config_fix',
  run: async (): Promise<ActionResult> => {
    const startedAt = Date.now()
    const scriptPath = join(LIVING_PLAN_DIR, 'config-watchdog.mjs')

    try {
      if (!existsSync(scriptPath)) {
        return { success: false, summary: 'config-watchdog.mjs 不存在', durationMs: Date.now() - startedAt }
      }

      const mod = await import(/* @vite-ignore */ scriptPath)
      if (typeof mod.runConfigWatchdog !== 'function') {
        return { success: false, summary: 'config-watchdog.mjs 未导出 runConfigWatchdog', durationMs: Date.now() - startedAt }
      }

      const report = mod.runConfigWatchdog()
      log('INFO', 'action_run_config_watchdog', {
        drifted: report.drifted,
        corrections: report.corrections?.length || 0,
      })

      // 如果有修正需要写入，applyChanges
      if (report.drifted && report.changes && Object.keys(report.changes).length > 0) {
        const raw = readFileSync(EVOLUTION_STATE_PATH, 'utf-8')
        const state = JSON.parse(raw)
        Object.assign(state, report.changes)
        writeFileSync(EVOLUTION_STATE_PATH, JSON.stringify(state, null, 2), 'utf-8')
        log('INFO', 'action_config_watchdog_applied', { changes: Object.keys(report.changes).join(', ') })
      }

      return {
        success: true,
        summary: report.message || `配置检查完成，${report.corrections?.length || 0} 个修正`,
        durationMs: Date.now() - startedAt,
        details: report,
      }
    } catch (err: any) {
      return { success: false, summary: `run_config_watchdog 失败: ${err.message}`, durationMs: Date.now() - startedAt }
    }
  },
})

// ═════════════════════════════════════════════════════════════════
// run_goal_tracker — 运行 living_plan/goal-tracker.mjs
// ═════════════════════════════════════════════════════════════════

register({
  name: 'run_goal_tracker',
  description: '运行 living_plan/goal-tracker.mjs 更新目标进度',
  category: 'script_run',
  run: async (): Promise<ActionResult> => {
    const startedAt = Date.now()
    const scriptPath = join(LIVING_PLAN_DIR, 'goal-tracker.mjs')

    try {
      if (!existsSync(scriptPath)) {
        return { success: false, summary: 'goal-tracker.mjs 不存在', durationMs: Date.now() - startedAt }
      }

      const mod = await import(/* @vite-ignore */ scriptPath)
      if (typeof mod.updateAllGoalProgresses !== 'function') {
        return { success: false, summary: 'goal-tracker.mjs 未导出 updateAllGoalProgresses', durationMs: Date.now() - startedAt }
      }

      const result = mod.updateAllGoalProgresses()
      log('INFO', 'action_goal_tracker', { result })

      return {
        success: true,
        summary: result ? `目标进度已更新` : `目标进度更新完成（无可更新目标）`,
        durationMs: Date.now() - startedAt,
        details: result,
      }
    } catch (err: any) {
      return { success: false, summary: `run_goal_tracker 失败: ${err.message}`, durationMs: Date.now() - startedAt }
    }
  },
})

// ═════════════════════════════════════════════════════════════════
// batch_fix_config — 批量修正所有已知的配置漂移
// ═════════════════════════════════════════════════════════════════

register({
  name: 'batch_fix_config',
  description: '检测并批量修正 evolution_state.json 中所有已知的配置漂移',
  category: 'config_fix',
  run: async (): Promise<ActionResult> => {
    const startedAt = Date.now()
    try {
      if (!existsSync(EVOLUTION_STATE_PATH)) {
        return { success: false, summary: `evolution_state.json 不存在`, durationMs: Date.now() - startedAt }
      }

      const raw = readFileSync(EVOLUTION_STATE_PATH, 'utf-8')
      const state = JSON.parse(raw)

      const corrections: { key: string; from: any; to: any }[] = []
      for (const [key, expectedValue] of Object.entries(GOLDEN_CONFIG)) {
        if (state[key] !== expectedValue) {
          corrections.push({ key, from: state[key], to: expectedValue })
          state[key] = expectedValue
        }
      }

      if (corrections.length === 0) {
        return {
          success: true,
          summary: '所有配置与黄金配置一致，无需修正',
          durationMs: Date.now() - startedAt,
          details: { corrected: 0 },
        }
      }

      // 记录修正历史
      const driftHistory = Array.isArray(state.configDriftHistory) ? [...state.configDriftHistory] : []
      driftHistory.push({
        timestamp: Date.now(),
        corrections: corrections.map((c) => `${c.key}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`),
        source: 'batch_fix_config',
      })
      state.configDriftHistory = driftHistory

      writeFileSync(EVOLUTION_STATE_PATH, JSON.stringify(state, null, 2), 'utf-8')
      log('INFO', 'action_batch_fix_config', { count: corrections.length, corrections })

      return {
        success: true,
        summary: `修正 ${corrections.length} 个配置漂移: ${corrections.map((c) => `${c.key}: ${JSON.stringify(c.from)}→${JSON.stringify(c.to)}`).join(', ')}`,
        durationMs: Date.now() - startedAt,
        details: { corrected: corrections.length, corrections },
      }
    } catch (err: any) {
      return { success: false, summary: `batch_fix_config 失败: ${err.message}`, durationMs: Date.now() - startedAt }
    }
  },
})

// ─── 批量执行 ────────────────────────────────────────────────────

/**
 * 按顺序执行动作序列，遇失败停止。
 * 类似 git 事务：前面的成功不回滚，后面的不执行。
 * 每个动作的执行会被 tracer 记录为 tool 类型节点。
 */
async function executeSequence(actions: { name: string; params?: any }[], ctx?: ActionContext): Promise<ActionResult[]> {
  const results: ActionResult[] = []
  for (const item of actions) {
    const action = registry.get(item.name)
    if (!action) {
      results.push({ success: false, summary: `未知动作: ${item.name}`, durationMs: 0 })
      break
    }

    // Trace: record tool entry
    const nodeId = ctx?.tracer?.recordTool(action.name, item.params || {}, null, { token: 0, latency: 0 })

    const result = await action.run(item.params, ctx)
    results.push(result)

    // Trace: update tool node with output
    if (nodeId && ctx?.tracer) {
      const trace = (ctx.tracer as any).getTrace() as { nodes: any[] }
      const node = trace.nodes.find((n: any) => n.id === nodeId)
      if (node) {
        node.output = result
        node.cost.latency = result.durationMs
      }
    }

    if (!result.success) break
  }
  return results
}

// ─── 导出 ────────────────────────────────────────────────────────

export const ActionRegistry = {
  get,
  list,
  executeSequence,
  GOLDEN_CONFIG,
  EVOLUTION_STATE_PATH,
  LIVING_PLAN_DIR,
}
