/**
 * WorkflowScheduler V2 — 事件驱动式 DAG 执行引擎
 *
 * 相比于 V1 的关键改进：
 * - 事件驱动替代轮询（waitForAgents 回调而非定时 poll）
 * - 新增 handler: condition, foreach, transform, gate, aggregate
 * - 结构化数据通道（步骤间传递 JSON，而非拼字符串）
 * - 失败重试 + 可干预
 * - 并发控制器
 * - 条件分支 + 循环
 */
import { log } from '../logger/Logger'
import { eventBus } from '../core/EventBus'
import { workflowStore, resolveRunOutputDir } from './WorkflowStoreV2'
import { resolveTemplate, resolveExpression } from './TemplateEngine'
import { evaluateCondition } from './ConditionEvaluator'
import type { WorkflowDef, WorkflowRun, WorkflowStepDef, ValueSchema } from './types'
import type { SpawnTaskOptions } from '../agent/SubAgentPool'
import * as fs from 'fs'
import * as path from 'path'

export interface WorkflowDispatch {
  runSubAgent: (goal: string, parentGoal?: string, options?: SpawnTaskOptions) => string
  interruptAgent: (id: string) => boolean
  runTool: (name: string, args: Record<string, any>) => Promise<string>
  runApi: (url: string, method: string, body?: any) => Promise<string>
  injectPrompt: (prompt: string) => void
  getCompletedAgentResults: () => { id: string; summary: string; error?: string }[]
  /** 非破坏性读取已完成结果（不 drain），用于并行多步骤场景 */
  peekCompletedAgentResults: () => { id: string; summary: string; error?: string }[]
  runPlan: (prompt: string) => string
  getPlanStatus: () => { id: string; title: string; total: number; done: number; pending: string[]; status: string } | null
  getDefinition: (id: string) => WorkflowDef | null
}

interface StepContext {
  steps: Record<string, { result: any; status: string; error?: string }>
  input: any
}

export class WorkflowSchedulerV2 {
  private dispatch: WorkflowDispatch
  private running = new Map<string, AbortController>()
  /** 同步取消标记 — 避免 executeLoop 在 stopRun 之后再次写入 cancelled */
  private cancelled = new Set<string>()
  /** 每个运行追踪其 spawn 出的 agent ID，用于取消时 kill */
  private runAgentIds = new Map<string, string[]>()
  private maxConcurrency = 5

  constructor(dispatch: WorkflowDispatch) {
    this.dispatch = dispatch
  }

  startRun(def: WorkflowDef, userInput?: string): WorkflowRun {
    const run = workflowStore.createRun(def, def.trigger)
    run.userInput = userInput
    run.status = 'running'
    workflowStore.updateRun(run)

    const abort = new AbortController()
    this.running.set(run.runId, abort)

    log('INFO', 'workflow_v2_run_started', { runId: run.runId, defId: def.id, steps: def.steps.length })

    this.executeLoop(run, def, abort.signal).catch((err) => {
      log('ERROR', 'workflow_v2_error', { runId: run.runId, error: String(err) })
      // 如果 stopRun 已经写入了 cancelled，不再重复写
      if (!this.cancelled.has(run.runId)) {
        run.status = 'failed'
        workflowStore.updateRun(run)
      }
      cleanupSchedulerState(this, run.runId)
    })

    return run
  }

  /** 从历史运行重跑：基于上次 def 创建新 run（保留上下文） */
  rerunRun(prevRunId: string, userInput?: string): WorkflowRun | null {
    const prevRun = workflowStore.getRun(prevRunId)
    if (!prevRun) return null
    const def = workflowStore.getDefinition(prevRun.workflowDefId)
    if (!def) return null
    return this.startRun(def, userInput ?? prevRun.userInput)
  }

  /** 启动并等待完成（用于 AI 自主调度后同步获取结果） */
  runAndWait(def: WorkflowDef, userInput?: string, timeoutMs = 120_000): Promise<WorkflowRun> {
    const run = this.startRun(def, userInput)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup()
        const stored = workflowStore.getRun(run.runId)
        resolve(stored ?? run)
      }, timeoutMs)

      const handler = (evt: any) => {
        if (evt.runId === run.runId && (evt.status === 'done' || evt.status === 'failed' || evt.status === 'paused')) {
          cleanup()
          const stored = workflowStore.getRun(run.runId)
          resolve(stored ?? run)
        }
      }
      eventBus.on('workflow.run.updated', handler)

      const cleanup = () => {
        clearTimeout(timer)
        eventBus.off('workflow.run.updated', handler)
      }
    })
  }

  private async executeLoop(run: WorkflowRun, def: WorkflowDef, signal: AbortSignal): Promise<void> {
    const outputDir = resolveRunOutputDir(def, run)
    const stepDefs = [...def.steps]
    const completed = new Set<string>()
    const failures = new Set<string>()
    const skipped = new Set<string>()
    const concurrency = def.maxConcurrency ?? this.maxConcurrency

    const ctx: StepContext = {
      steps: {},
      input: run.userInput ?? '',
    }

    while (!signal.aborted && run.status === 'running') {
      // 1. Handle pending gate → pause
      if (run.pendingGate) {
        run.status = 'paused'
        workflowStore.updateRun(run)
        log('INFO', 'workflow_v2_paused_gate', { runId: run.runId, stepId: run.pendingGate.stepId })
        return
      }

      // 2. Skip runOn:failure steps whose dependencies all succeeded
      for (const sd of stepDefs) {
        if (!isPending(sd, completed, failures, skipped)) continue
        if (!depsReady(sd, completed, failures, skipped)) continue
        if (sd.runOn === 'failure') {
          if (!sd.dependsOn.some((d) => failures.has(d))) {
            markSkipped(run, sd, '(条件不满足，跳过)', skipped, workflowStore)
          }
        }
      }

      // 3. Find runnable steps
      const runnable = stepDefs.filter((sd) => {
        if (!isPending(sd, completed, failures, skipped)) return false
        if (!depsReady(sd, completed, failures, skipped)) return false
        if (sd.runOn === 'failure') {
          return sd.dependsOn.some((d) => failures.has(d))
        }
        return sd.dependsOn.every((d) => completed.has(d) || skipped.has(d))
      })

      if (runnable.length === 0) {
        finishRun(run, stepDefs, completed, failures, skipped, workflowStore)
        cleanupSchedulerState(this, run.runId)
        return
      }

      // 4. Execute runnable steps with concurrency limit
      const queue = [...runnable]
      const active: Promise<void>[] = []

      while (queue.length > 0 && !signal.aborted) {
        while (queue.length > 0 && active.length < concurrency) {
          const sd = queue.shift()!
          const promise = this.executeStep(sd, run, def, outputDir, ctx, signal).then((result) => {
            if (signal.aborted) return
            if (result.status === 'done') {
              completed.add(sd.id)
              ctx.steps[sd.id] = { result: result.data, status: 'done' }
              workflowStore.updateStep(run, sd.id, 'done', result.data)
            } else if (result.status === 'failed') {
              failures.add(sd.id)
              ctx.steps[sd.id] = { result: null, status: 'failed', error: result.error }
              workflowStore.updateStep(run, sd.id, 'failed', undefined, result.error)
            } else if (result.status === 'skipped') {
              skipped.add(sd.id)
            }
            if (result.pauseRun) {
              run.status = 'paused'
              run.pendingGate = result.pendingGate
              workflowStore.updateRun(run)
            }
          })
          active.push(promise)
        }

        if (active.length > 0) {
          const settled = await Promise.allSettled(active.map((p, i) => p.then(() => i).catch(() => i)))
          const doneIdx = new Set(settled.map((r: any) => r.value))
          for (const i of doneIdx) active[i] = undefined as any
          while (active.length > 0 && active[active.length - 1] === undefined) active.pop()
        }

        if (run.pendingGate) break
      }

      if (active.length > 0 && !run.pendingGate) {
        await Promise.allSettled(active)
      }
    }

    if (signal.aborted) {
      // stopRun 已经写入 DB + emit 事件，这里不再重复写
      // 只清理内存状态
      cleanupSchedulerState(this, run.runId)
      return
    }
  }

  private async executeStep(
    sd: WorkflowStepDef,
    run: WorkflowRun,
    def: WorkflowDef,
    outputDir: string,
    ctx: StepContext,
    signal: AbortSignal,
  ): Promise<{ status: string; data?: any; error?: string; pauseRun?: boolean; pendingGate?: any }> {
    workflowStore.updateStep(run, sd.id, 'running')

    let retries = 0
    const maxRetries = sd.retryCount ?? 0

    while (retries <= maxRetries && !signal.aborted) {
      try {
        const result = await this.dispatchHandler(sd, run, def, outputDir, ctx, signal)
        if (result.pauseRun) return result

        if (sd.outputSchema && result.data !== undefined) {
          const errors = validateSchema(result.data, sd.outputSchema)
          if (errors.length > 0) {
            log('WARN', 'workflow_v2_schema_validation', { stepId: sd.id, errors })
            if (sd.config.outputFile) {
              this.writeOutputFile(sd, JSON.stringify(result.data, null, 2), outputDir)
            }
            return { status: 'failed', error: errors.join('; ') }
          }
        }

        if (sd.config.outputFile && result.data !== undefined) {
          this.writeOutputFile(sd, typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2), outputDir)
        }

        return result
      } catch (err: any) {
        retries++
        log('WARN', 'workflow_v2_step_retry', { stepId: sd.id, retry: retries, maxRetries, error: err.message })
        if (retries > maxRetries) {
          workflowStore.updateStep(run, sd.id, 'failed', undefined, err.message)
          return { status: 'failed', error: err.message }
        }
        const delay = sd.retryDelayMs ?? 5000
        await sleep(delay)
      }
    }

    return { status: 'failed', error: 'Aborted' }
  }

  private async dispatchHandler(
    sd: WorkflowStepDef,
    run: WorkflowRun,
    def: WorkflowDef,
    outputDir: string,
    ctx: StepContext,
    signal: AbortSignal,
  ): Promise<{ status: string; data?: any; error?: string; pauseRun?: boolean; pendingGate?: any }> {
    switch (sd.handler) {
      case 'condition':
        return this.handleCondition(sd, run, ctx)
      case 'foreach':
        return this.handleForeach(sd, run, def, outputDir, ctx, signal)
      case 'transform':
        return this.handleTransform(sd, ctx)
      case 'gate':
        return this.handleGate(sd, run, ctx)
      case 'aggregate':
        return this.handleAggregate(sd, ctx)
      case 'subflow':
        return this.handleSubflow(sd, run, def, outputDir, ctx, signal)
      case 'wait':
        return this.handleWait(sd, ctx, signal)
      case 'script':
        return this.handleScript(sd, ctx)
      case 'event':
        return this.handleEvent(sd, ctx)
      default:
        return this.handleLegacy(sd, run, def, outputDir, ctx, signal)
    }
  }

  // ── New handler implementations ──

  private async handleCondition(sd: WorkflowStepDef, run: WorkflowRun, ctx: StepContext): Promise<{ status: string; data?: any }> {
    const cfg = sd.config.condition
    if (!cfg) return { status: 'done', data: { goto: null } }

    const sourceVal = resolveTemplate(cfg.source, ctx)
    let goto: string | null = null

    for (const c of cfg.cases) {
      if (evaluateCondition(c.if, sourceVal)) {
        goto = c.goto
        break
      }
    }
    if (!goto) goto = cfg.defaultGoto ?? null

    workflowStore.updateStep(run, sd.id, 'done', JSON.stringify({ source: sourceVal, goto }))
    return { status: 'done', data: { source: sourceVal, goto } }
  }

  private async handleForeach(
    sd: WorkflowStepDef,
    run: WorkflowRun,
    def: WorkflowDef,
    outputDir: string,
    ctx: StepContext,
    signal: AbortSignal,
  ): Promise<{ status: string; data?: any }> {
    const cfg = sd.config.foreach
    if (!cfg) return { status: 'done', data: [] }

    const rawItems = resolveExpression(cfg.items, ctx)
    if (!Array.isArray(rawItems)) {
      return { status: 'done', data: [] }
    }

    const concurrency = cfg.concurrency ?? 3
    const results: any[] = []

    let subDef: WorkflowDef | null = null
    if (cfg.workflowId) {
      subDef = this.dispatch.getDefinition(cfg.workflowId)
    }
    if (!subDef && cfg.inlineSteps) {
      subDef = {
        id: `_inline_${sd.id}`,
        name: sd.name,
        description: sd.description,
        steps: cfg.inlineSteps,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as WorkflowDef
    }
    if (!subDef) return { status: 'done', data: [] }

    const queue = [...rawItems]
    const active: Promise<void>[] = []

    while (queue.length > 0 && !signal.aborted) {
      while (queue.length > 0 && active.length < concurrency) {
        const item = queue.shift()!
        const p = this.runForeachItem(subDef!, def, run, outputDir, ctx, item, signal, results)
        active.push(p)
      }
      if (active.length > 0) {
        const settled = await Promise.allSettled(active.map((p, i) => p.then(() => i).catch(() => i)))
        const doneIdx = new Set(settled.map((r: any) => r.value))
        for (const i of doneIdx) active[i] = undefined as any
        while (active.length > 0 && active[active.length - 1] === undefined) active.pop()
      }
    }
    await Promise.allSettled(active)

    workflowStore.updateStep(run, sd.id, 'done', JSON.stringify(results))
    return { status: 'done', data: results }
  }

  private async runForeachItem(
    subDef: WorkflowDef,
    _parentDef: WorkflowDef,
    _parentRun: WorkflowRun,
    _outputDir: string,
    _ctx: StepContext,
    item: any,
    signal: AbortSignal,
    results: any[],
  ): Promise<any> {
    const itemCtx: StepContext = { steps: {}, input: item }
    for (const step of subDef.steps) {
      if (signal.aborted) break
      try {
        const result = await this.dispatchHandler(step, null as any, subDef, '', itemCtx, signal)
        if (result.status === 'done' && result.data !== undefined) {
          itemCtx.steps[step.id] = { result: result.data, status: 'done' }
        } else {
          itemCtx.steps[step.id] = { result: null, status: result.status, error: result.error }
        }
      } catch {}
    }
    results.push(itemCtx.steps)
    return itemCtx
  }

  private async handleTransform(sd: WorkflowStepDef, ctx: StepContext): Promise<{ status: string; data?: any }> {
    const cfg = sd.config.transform
    if (!cfg) return { status: 'done', data: {} }

    const inputVal = resolveExpression(cfg.input, ctx)
    const mappingCtx = { ...ctx, input: inputVal }
    const output: Record<string, any> = {}
    for (const [key, expr] of Object.entries(cfg.mapping)) {
      const raw = resolveTemplate(expr, mappingCtx)
      if (raw === 'true') output[key] = true
      else if (raw === 'false') output[key] = false
      else if (raw === 'null') output[key] = null
      else if (/^-?\d+(\.\d+)?$/.test(raw)) output[key] = Number(raw)
      else output[key] = raw
    }

    return { status: 'done', data: output }
  }

  private async handleGate(
    sd: WorkflowStepDef,
    run: WorkflowRun,
    ctx: StepContext,
  ): Promise<{ status: string; data?: any; pauseRun?: boolean; pendingGate?: any }> {
    const cfg = sd.config.gate
    if (!cfg) return { status: 'done', data: { approved: true } }

    const message = resolveTemplate(cfg.message, ctx)
    const preview = resolveTemplate(cfg.preview, ctx)
    const options = cfg.options ?? ['approve', 'reject']

    const pendingGate = { stepId: sd.id, message, preview, options }

    workflowStore.updateStep(run, sd.id, 'running', `⏳ 等待审批: ${message}`)
    return {
      status: 'running',
      data: null,
      pauseRun: true,
      pendingGate,
    }
  }

  approveGate(runId: string, stepId: string, decision: string, modifiedInput?: string): boolean {
    const run = workflowStore.getRun(runId)
    if (!run || !run.pendingGate || run.pendingGate.stepId !== stepId) return false

    run.pendingGate = undefined
    run.status = 'running'

    workflowStore.updateStep(run, stepId, 'done', JSON.stringify({ decision, modifiedInput }))
    workflowStore.updateRun(run)

    const def = workflowStore.getDefinition(run.workflowDefId)
    if (def) {
      this.executeLoop(run, def, new AbortController().signal).catch((err) => {
        log('ERROR', 'workflow_v2_resume_error', { runId, error: String(err) })
        run.status = 'failed'
        workflowStore.updateRun(run)
      })
    }

    return true
  }

  private async handleAggregate(sd: WorkflowStepDef, ctx: StepContext): Promise<{ status: string; data?: any }> {
    const cfg = sd.config.aggregate
    if (!cfg) return { status: 'done', data: {} }

    const sources = cfg.sources ?? sd.dependsOn
    const items = sources.map((src) => ctx.steps[src]?.result).filter((r) => r !== undefined)

    let result: any
    switch (cfg.strategy) {
      case 'merge':
        result = Object.assign({}, ...items)
        break
      case 'concat':
        result = items.flat()
        break
      case 'pick-first':
        result = items[0] ?? null
        break
      case 'custom':
        result = cfg.expression ? resolveTemplate(cfg.expression, ctx) : items
        break
      default:
        result = items
    }

    return { status: 'done', data: result }
  }

  private async handleSubflow(
    sd: WorkflowStepDef,
    run: WorkflowRun,
    def: WorkflowDef,
    outputDir: string,
    ctx: StepContext,
    signal: AbortSignal,
  ): Promise<{ status: string; data?: any; error?: string }> {
    const cfg = sd.config.subflow
    if (!cfg) return { status: 'done', data: null }

    let subDef: WorkflowDef | null = null
    if (cfg.workflowId) {
      subDef = this.dispatch.getDefinition(cfg.workflowId)
    }
    if (!subDef && cfg.inlineSteps) {
      subDef = {
        id: `_sub_${sd.id}`,
        name: sd.name,
        description: sd.description,
        steps: cfg.inlineSteps,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
    }
    if (!subDef) return { status: 'done', data: null }

    const subCtx: StepContext = {
      steps: {},
      input: cfg.input ? resolveTemplate(JSON.stringify(cfg.input), ctx) : ctx.input,
    }

    for (const step of subDef.steps) {
      if (signal.aborted) break
      try {
        const result = await this.dispatchHandler(step, run, def, outputDir, subCtx, signal)
        if (result.status === 'done' && result.data !== undefined) {
          subCtx.steps[step.id] = { result: result.data, status: 'done' }
        } else {
          subCtx.steps[step.id] = { result: null, status: result.status, error: result.error }
        }
        if (result.pauseRun) return result
      } catch (err: any) {
        return { status: 'failed', error: err.message }
      }
    }

    return { status: 'done', data: subCtx.steps }
  }

  private async handleWait(sd: WorkflowStepDef, _ctx: StepContext, signal: AbortSignal): Promise<{ status: string; data?: any }> {
    const cfg = sd.config.wait
    if (!cfg) return { status: 'done', data: null }

    if (cfg.durationMs) {
      await sleepWithSignal(cfg.durationMs, signal)
      return { status: 'done', data: { waited: cfg.durationMs } }
    }

    return { status: 'done', data: null }
  }

  private async handleScript(sd: WorkflowStepDef, ctx: StepContext): Promise<{ status: string; data?: any; error?: string }> {
    const cfg = sd.config.script
    if (!cfg || !cfg.code) return { status: 'done', data: null }

    try {
      const fn = new Function('ctx', 'steps', 'input', cfg.code)
      const result = fn(ctx, ctx.steps, ctx.input)
      return { status: 'done', data: result }
    } catch (err: any) {
      return { status: 'failed', error: `Script error: ${err.message}` }
    }
  }

  private async handleEvent(sd: WorkflowStepDef, _ctx: StepContext): Promise<{ status: string; data?: any }> {
    const cfg = sd.config.event
    if (!cfg) return { status: 'done', data: null }

    const payload = cfg.payload ? resolveTemplate(cfg.payload, _ctx) : undefined
    eventBus.emit(cfg.eventName as any, payload ? { workflow: true, payload } : { workflow: true })

    return { status: 'done', data: { event: cfg.eventName, emitted: true } }
  }

  // ── Legacy handlers ──

  private async handleLegacy(
    sd: WorkflowStepDef,
    run: WorkflowRun,
    def: WorkflowDef,
    outputDir: string,
    ctx: StepContext,
    signal: AbortSignal,
  ): Promise<{ status: string; data?: any; error?: string }> {
    switch (sd.handler) {
      case 'subagent':
        return this.handleSubagent(sd, run, def, outputDir, ctx, signal)
      case 'tool':
        return this.handleToolStep(sd)
      case 'api':
        return this.handleApiStep(sd)
      case 'prompt':
        return this.handlePromptStep(sd)
      case 'plan':
        return this.handlePlanStep(sd, signal)
      default:
        return { status: 'failed', error: `Unknown handler: ${sd.handler}` }
    }
  }

  private async handleSubagent(
    sd: WorkflowStepDef,
    run: WorkflowRun,
    def: WorkflowDef,
    outputDir: string,
    ctx: StepContext,
    signal: AbortSignal,
  ): Promise<{ status: string; data?: any; error?: string }> {
    if (signal.aborted) return { status: 'failed', error: 'Cancelled' }

    const subOptions: SpawnTaskOptions = {}
    if (sd.config.allowedTools !== undefined) subOptions.allowedToolNames = sd.config.allowedTools
    if (sd.config.maxTurns !== undefined) subOptions.maxTurns = sd.config.maxTurns
    if (sd.config.llmTimeoutMs !== undefined) subOptions.llmTimeoutMs = sd.config.llmTimeoutMs

    subOptions.onProgress = (msg) => {
      if (signal.aborted) return
      eventBus.emit('workflow.run.step', { runId: run.runId, stepId: sd.id, status: 'running', agentResult: msg })
    }

    // Build dependency context from previous step results
    const depContext = sd.dependsOn
      .map((depId) => {
        const step = ctx.steps[depId]
        if (!step) return ''
        const resultStr = typeof step.result === 'string' ? step.result : JSON.stringify(step.result, null, 2)
        return `【上一步 ${depId} 的输出】\n${resultStr}`
      })
      .filter(Boolean)
      .join('\n\n')

    const basePrompt = sd.config.prompt || sd.description || ''
    const withInput = basePrompt.replace(/\{INPUT\}/g, run.userInput || '(请输入主题)')
    const withOutputDir = withInput.replace(/\{OUTPUT_DIR\}/g, outputDir)
    const fullPrompt = withOutputDir.replace('(dependency_context)', depContext)

    const agentId = this.dispatch.runSubAgent(fullPrompt, def.description, subOptions)
    const pendingAgents = [agentId]
    // 追踪 agent ID，用于取消时 kill
    const prev = this.runAgentIds.get(run.runId) ?? []
    prev.push(agentId)
    this.runAgentIds.set(run.runId, prev)

    const results = await this.waitForAgents(pendingAgents, run, sd, signal)
    const agentResult = results.find((r) => pendingAgents.includes(r.id))

    if (signal.aborted) {
      return { status: 'failed', error: 'Cancelled' }
    }
    if (agentResult?.error) {
      return { status: 'failed', error: agentResult.error, data: agentResult.summary }
    }
    const summary = agentResult?.summary || '(completed)'
    return { status: 'done', data: summary }
  }

  private async handleToolStep(sd: WorkflowStepDef): Promise<{ status: string; data?: any }> {
    const result = await this.dispatch.runTool(sd.config.tool || '', {})
    return { status: 'done', data: result }
  }

  private async handleApiStep(sd: WorkflowStepDef): Promise<{ status: string; data?: any }> {
    const result = await this.dispatch.runApi(sd.config.apiUrl || '', sd.config.apiMethod || 'GET')
    return { status: 'done', data: result }
  }

  private async handlePromptStep(sd: WorkflowStepDef): Promise<{ status: string; data?: any }> {
    this.dispatch.injectPrompt(sd.config.prompt || sd.description || '')
    return { status: 'done', data: '(prompt injected)' }
  }

  private async handlePlanStep(sd: WorkflowStepDef, signal: AbortSignal): Promise<{ status: string; data?: any; error?: string }> {
    const planPrompt = sd.config.planPrompt || sd.config.prompt || sd.description || ''
    this.dispatch.runPlan(planPrompt)

    const ps0 = this.dispatch.getPlanStatus()
    if (ps0 && ps0.status === 'active' && ps0.total === 0) {
      return { status: 'done', data: `Plan 指令已注入：${planPrompt.slice(0, 60)}...` }
    }

    for (let i = 0; i < 600; i++) {
      if (signal.aborted) return { status: 'failed', error: 'Cancelled' }
      const ps = this.dispatch.getPlanStatus()
      if (!ps || ps.status === 'abandoned' || ps.status === 'completed') {
        if (ps?.status === 'completed') {
          return { status: 'done', data: `Plan「${ps.title}」${ps.done}/${ps.total} 步完成` }
        }
        return { status: 'failed', error: 'Plan was abandoned' }
      }
      await sleep(5000)
    }
    return { status: 'failed', error: 'Plan wait timeout' }
  }

  // ── Utilities ──

  private async waitForAgents(
    agentIds: string[],
    run: WorkflowRun,
    sd: WorkflowStepDef,
    signal?: AbortSignal,
  ): Promise<{ id: string; summary: string; error?: string }[]> {
    const maxWait = 60 * 60 * 1000
    const interval = 2000
    let waited = 0
    while (waited < maxWait) {
      if (signal?.aborted) return []
      // 使用非破坏性 peek — 不 drain 其他步骤的结果
      const allResults = this.dispatch.peekCompletedAgentResults()
      const done = agentIds.every((id) => allResults.some((r) => r.id === id))
      if (done) {
        // 仅消费属于自己的结果
        const results = this.dispatch.getCompletedAgentResults()
        return results.filter((r) => agentIds.includes(r.id))
      }
      eventBus.emit('workflow.run.step', {
        runId: run.runId,
        stepId: sd.id,
        status: 'running',
        agentResult: `⏳ ${Math.floor(waited / 1000)}s`,
      })
      await sleep(interval)
      waited += interval
    }
    log('WARN', 'workflow_v2_agent_wait_timeout', { runId: run.runId, stepId: sd.id })
    return []
  }

  private writeOutputFile(sd: WorkflowStepDef, content: string, outputDir?: string): void {
    let outputFile = sd.config.outputFile
    if (!outputFile || !content) return
    try {
      const today = new Date().toISOString().slice(0, 10)
      outputFile = outputFile
        .replace(/\{DATE\}/g, today)
        .replace(/\{OUTPUT_DIR\}/g, outputDir || '')
        .replace(/\{STEP_ID\}/g, sd.id)
      if (!path.isAbsolute(outputFile) && outputDir) {
        outputFile = path.join(outputDir, outputFile)
      }
      const dir = path.dirname(outputFile)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(outputFile, content, 'utf-8')
      log('INFO', 'workflow_v2_output_written', { stepId: sd.id, path: outputFile, bytes: content.length })
    } catch (err: any) {
      log('WARN', 'workflow_v2_output_failed', { stepId: sd.id, error: err.message })
    }
  }

  stopRun(runId: string): boolean {
    const abort = this.running.get(runId)
    if (abort) {
      abort.abort()
      this.running.delete(runId)
    }
    this.cancelled.add(runId)

    // 中断所有由该 workflow spawn 出的子 agent
    const agentIds = this.runAgentIds.get(runId) ?? []
    for (const aid of agentIds) {
      this.dispatch.interruptAgent(aid)
    }
    this.runAgentIds.delete(runId)

    const run = workflowStore.getRun(runId)
    if (!run) return false
    run.status = 'cancelled'
    run.completedAt = Date.now()
    // 使用 forceCancelRun 绕过 DB CHECK constraint(SQLite 不支持 cancelled)
    // 写入 failed + 单独发射 cancelled 事件供前端 FSM 正确转换
    workflowStore.forceCancelRun(runId)
    return true
  }

  isActive(runId?: string): boolean {
    if (runId) return this.running.has(runId)
    return this.running.size > 0
  }
}

// ── Module-level singleton ──
let _scheduler: WorkflowSchedulerV2 | null = null

export function setWorkflowScheduler(s: WorkflowSchedulerV2): void {
  _scheduler = s
}

export function getWorkflowScheduler(): WorkflowSchedulerV2 {
  if (!_scheduler) throw new Error('WorkflowSchedulerV2 not initialized')
  return _scheduler
}

// ── Pure helpers ──

function isPending(sd: WorkflowStepDef, completed: Set<string>, failures: Set<string>, skipped: Set<string>): boolean {
  return !completed.has(sd.id) && !failures.has(sd.id) && !skipped.has(sd.id)
}

function depsReady(sd: WorkflowStepDef, completed: Set<string>, failures: Set<string>, skipped: Set<string>): boolean {
  if (!sd.dependsOn || sd.dependsOn.length === 0) return true
  return sd.dependsOn.every((d) => completed.has(d) || failures.has(d) || skipped.has(d))
}

function markSkipped(run: WorkflowRun, sd: WorkflowStepDef, reason: string, skipped: Set<string>, store: typeof workflowStore): void {
  store.updateStep(run, sd.id, 'skipped', reason)
  skipped.add(sd.id)
}

function finishRun(
  run: WorkflowRun,
  stepDefs: WorkflowStepDef[],
  completed: Set<string>,
  failures: Set<string>,
  skipped: Set<string>,
  store: typeof workflowStore,
): void {
  const allDone = stepDefs.every((sd) => completed.has(sd.id) || skipped.has(sd.id))
  if (allDone) {
    run.status = 'done'
  } else if (stepDefs.every((sd) => failures.has(sd.id))) {
    run.status = 'failed'
  } else {
    run.status = completed.size > 0 || skipped.size > 0 ? 'done' : 'failed'
  }
  run.completedAt = Date.now()
  store.updateRun(run)
  log('INFO', 'workflow_v2_run_completed', { runId: run.runId, status: run.status })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    setTimeout(r, ms)
  })
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(() => {
      if (!signal.aborted) resolve()
    }, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true },
    )
  })
}

function validateSchema(data: any, schema: Record<string, ValueSchema>): string[] {
  const errors: string[] = []
  for (const [key, field] of Object.entries(schema)) {
    const val = data?.[key]
    if (val === undefined || val === null) {
      if (!field.optional) errors.push(`${key}: required`)
      continue
    }
    if (field.type === 'string' && typeof val !== 'string') errors.push(`${key}: expected string, got ${typeof val}`)
    else if (field.type === 'number' && typeof val !== 'number') errors.push(`${key}: expected number, got ${typeof val}`)
    else if (field.type === 'boolean' && typeof val !== 'boolean') errors.push(`${key}: expected boolean, got ${typeof val}`)
    else if (field.type === 'array' && !Array.isArray(val)) errors.push(`${key}: expected array`)
  }
  return errors
}

/** 清理一次运行相关的所有内存状态 */
function cleanupSchedulerState(s: WorkflowSchedulerV2, runId: string): void {
  s.running.delete(runId)
  s.cancelled.delete(runId)
  s.runAgentIds.delete(runId)
}
