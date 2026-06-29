import { log } from '../logger/Logger'
import { eventBus } from '../core/EventBus'
import { workflowStore, resolveRunOutputDir } from './WorkflowStore'
import type { WorkflowDef, WorkflowRun, WorkflowStepDef, WorkflowStepRun } from './types'
import type { SpawnTaskOptions } from '../agent/SubAgentPool'
import { writeWorkflowExcel } from './WorkflowExcelExporter'
import * as fs from 'fs'
import * as path from 'path'

export interface WorkflowDispatch {
  runSubAgent: (goal: string, parentGoal?: string, options?: SpawnTaskOptions) => string
  runTool: (name: string, args: Record<string, any>) => Promise<string>
  runApi: (url: string, method: string, body?: any) => Promise<string>
  injectPrompt: (prompt: string) => void
  waitForAgent: (agentId: string, timeoutMs?: number) => Promise<{ id: string; summary: string; error?: string }>
  runPlan: (prompt: string) => string
  getPlanStatus: () => { id: string; title: string; total: number; done: number; pending: string[]; status: string } | null
}

export class WorkflowScheduler {
  private dispatch: WorkflowDispatch
  private pendingAgents = new Map<string, string[]>()
  private active = false
  /** 当前正在运行的工作流定义 ID 集合，用于防止重复启动同一工作流 */
  private runningDefs = new Set<string>()

  constructor(dispatch: WorkflowDispatch) {
    this.dispatch = dispatch
  }

  startRun(def: WorkflowDef, userInput?: string): WorkflowRun {
    if (this.runningDefs.has(def.id)) {
      throw new Error(`工作流「${def.name}」已在运行中，不能重复启动`)
    }
    const run = workflowStore.createRun(def)
    run.userInput = userInput
    run.status = 'running'
    const outputDir = resolveRunOutputDir(def, run)
    ;(run as any)._outputDir = outputDir
    workflowStore.updateRun(run)
    this.active = true
    this.runningDefs.add(def.id)

    log('INFO', 'workflow_run_started', { runId: run.runId, defId: def.id, steps: def.steps.length, outputDir })

    log('INFO', 'workflow_before_executeLoop', { runId: run.runId })

    // Execute in background
    this.executeLoop(run, def, outputDir).catch((err) => {
      log('ERROR', 'workflow_execution_error', { runId: run.runId, error: String(err) })
      run.status = 'failed'
      workflowStore.updateRun(run)
      this.active = false
      this.runningDefs.delete(def.id)
    })

    return run
  }

  private async executeLoop(run: WorkflowRun, def: WorkflowDef, outputDir: string): Promise<void> {
    console.log('[wf] executeLoop ENTERED', { runId: run.runId, steps: def.steps.length, runStatus: run.status, outputDir })
    log('INFO', 'workflow_executeLoop_entered', { runId: run.runId, steps: def.steps.length })
    const stepDefs = [...def.steps]
    const completed = new Set<string>()
    const failures = new Set<string>()
    const skipped = new Set<string>()

    while (this.active && run.status === 'running') {
      // 先检查 runOn: 'failure' 的步骤：依赖都成功则自动跳过
      for (const sd of stepDefs) {
        if (completed.has(sd.id) || failures.has(sd.id) || skipped.has(sd.id)) continue
        const stepRun = run.steps.find((s) => s.stepId === sd.id)
        if (!stepRun || stepRun.status !== 'pending') continue
        const depsReady = sd.dependsOn.every((depId) => completed.has(depId) || failures.has(depId) || skipped.has(depId))
        if (!depsReady) continue
        if (sd.runOn === 'failure') {
          const anyDepFailed = sd.dependsOn.some((depId) => failures.has(depId))
          if (!anyDepFailed) {
            workflowStore.updateStep(run, sd.id, 'skipped', '(条件不满足，跳过)')
            skipped.add(sd.id)
          }
        }
      }

      // 默认步骤(runOn!=='failure')的依赖如果失败了，永不可达，自动跳过
      for (const sd of stepDefs) {
        if (completed.has(sd.id) || failures.has(sd.id) || skipped.has(sd.id)) continue
        if (sd.runOn === 'failure') continue
        if (sd.dependsOn.some((depId) => failures.has(depId))) {
          workflowStore.updateStep(run, sd.id, 'skipped', '(依赖步骤失败，跳过)')
          skipped.add(sd.id)
        }
      }

      const runnable = stepDefs.filter((sd) => {
        if (completed.has(sd.id) || failures.has(sd.id) || skipped.has(sd.id)) return false
        const stepRun = run.steps.find((s) => s.stepId === sd.id)
        if (!stepRun || stepRun.status !== 'pending') return false
        const depsReady = sd.dependsOn.every((depId) => completed.has(depId) || failures.has(depId) || skipped.has(depId))
        if (!depsReady) return false
        if (sd.runOn === 'failure') {
          return sd.dependsOn.some((depId) => failures.has(depId))
        } else {
          // 默认：依赖成功或被跳过都算通过
          return sd.dependsOn.every((depId) => completed.has(depId) || skipped.has(depId))
        }
      })

      if (runnable.length === 0) {
        const allDone = stepDefs.every((sd) => completed.has(sd.id) || skipped.has(sd.id))
        const allFailed = stepDefs.every((sd) => failures.has(sd.id))
        if (allDone) {
          run.status = 'done'
          // 运行结束后生成 Excel
          writeWorkflowExcel(run, outputDir)
            .then((path) => {
              if (path) log('INFO', 'workflow_excel_generated', { runId: run.runId, path })
            })
            .catch((err) => log('WARN', 'workflow_excel_generation_failed', { runId: run.runId, error: String(err) }))
        } else if (allFailed) run.status = 'failed'
        else run.status = completed.size > 0 ? 'done' : 'failed'
        workflowStore.updateRun(run)
        this.active = false
        this.runningDefs.delete(def.id)
        return
      }

      const promises = runnable.map(async (sd) => {
        const stepTimeout = sd.config.stepTimeoutMs ?? 60 * 60 * 1000
        const stepPromise = this.executeStep(sd, run, def, outputDir, completed, failures)
        await Promise.race([
          stepPromise,
          new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`步骤「${sd.id}」执行超时 (${stepTimeout}ms)`)), stepTimeout)),
        ])
      })

      await Promise.allSettled(promises)
    }
  }

  /** 执行单个步骤（handler 分发 + waitForAgents），executeLoop 中的 Promise.race 调用它 */
  private async executeStep(
    sd: WorkflowStepDef,
    run: WorkflowRun,
    def: WorkflowDef,
    outputDir: string,
    completed: Set<string>,
    failures: Set<string>,
  ): Promise<void> {
    workflowStore.updateStep(run, sd.id, 'running')

    try {
      const agentIds: string[] = []

      switch (sd.handler) {
        case 'subagent': {
          const subOptions: SpawnTaskOptions = {}
          const allowedTools = sd.config.allowedTools
          if (allowedTools !== undefined) subOptions.allowedToolNames = allowedTools
          if (sd.config.maxTurns !== undefined) subOptions.maxTurns = sd.config.maxTurns
          if (sd.config.llmTimeoutMs !== undefined) subOptions.llmTimeoutMs = sd.config.llmTimeoutMs
          subOptions.onProgress = (msg) => {
            eventBus.emit('workflow.run.step' as any, { runId: run.runId, stepId: sd.id, status: 'running', agentResult: msg })
          }
          const depContext = this.buildDependencyContext(sd, run)
          const basePrompt = sd.config.prompt || sd.description
          const withInput = basePrompt.replace(
            /\{INPUT\}/g,
            run.userInput || '（用户未指定主题，请自行选择一个适合当前时间和社会热点的内容主题来创作）',
          )
          const withOutputDir = withInput.replace(/\{OUTPUT_DIR\}/g, outputDir)
          const fullPrompt = withOutputDir.includes('(dependency_context)')
            ? withOutputDir.replaceAll('(dependency_context)', depContext)
            : withOutputDir + depContext
          const agentId = this.dispatch.runSubAgent(fullPrompt, def.description, subOptions)
          agentIds.push(agentId)
          this.pendingAgents.set(run.runId, agentIds)
          break
        }
        case 'tool': {
          const result = await this.dispatch.runTool(sd.config.tool || '', {})
          workflowStore.updateStep(run, sd.id, 'done', result)
          completed.add(sd.id)
          return
        }
        case 'api': {
          const result = await this.dispatch.runApi(sd.config.apiUrl || '', sd.config.apiMethod || 'GET')
          workflowStore.updateStep(run, sd.id, 'done', result)
          completed.add(sd.id)
          return
        }
        case 'prompt': {
          this.dispatch.injectPrompt(sd.config.prompt || sd.description)
          workflowStore.updateStep(run, sd.id, 'done', '(prompt injected)')
          completed.add(sd.id)
          return
        }
        case 'plan': {
          const planPrompt = sd.config.planPrompt || sd.config.prompt || sd.description
          const planId = this.dispatch.runPlan(planPrompt)
          const ps0 = this.dispatch.getPlanStatus()
          if (ps0 && ps0.status === 'active' && ps0.total === 0) {
            log('INFO', 'workflow_plan_zero_step_completed', { runId: run.runId, stepId: sd.id, planId })
            workflowStore.updateStep(run, sd.id, 'done', `Plan 指令已注入：${planPrompt.slice(0, 60)}...`)
            completed.add(sd.id)
            return
          }
          for (let i = 0; i < 600; i++) {
            const ps = this.dispatch.getPlanStatus()
            if (!ps || ps.status === 'abandoned' || ps.status === 'completed') {
              if (ps?.status === 'completed') {
                workflowStore.updateStep(run, sd.id, 'done', `Plan「${ps.title}」${ps.done}/${ps.total} 步完成`)
              } else {
                workflowStore.updateStep(run, sd.id, 'failed', undefined, 'Plan was abandoned')
                failures.add(sd.id)
              }
              completed.add(sd.id)
              return
            }
            await sleep(5000)
          }
          workflowStore.updateStep(run, sd.id, 'failed', undefined, 'Plan wait timeout')
          failures.add(sd.id)
          return
        }
      }

      if (agentIds.length > 0) {
        const results = await this.waitForAgents(agentIds, run, sd)
        const agentResult = results.find((r) => agentIds.includes(r.id))
        if (agentResult?.error) {
          workflowStore.updateStep(run, sd.id, 'failed', agentResult.summary, agentResult.error)
          failures.add(sd.id)
        } else {
          workflowStore.updateStep(run, sd.id, 'done', agentResult?.summary || '(completed)')
          completed.add(sd.id)
          this.writeStepOutput(sd, agentResult?.summary, outputDir)
          if (sd.id === 's_browser' && agentResult?.summary) {
            this.collectScreenshots(agentResult.summary, outputDir)
          }
        }
      }
    } catch (err: any) {
      log('WARN', 'workflow_step_failed', { runId: run.runId, stepId: sd.id, error: err.message })
      workflowStore.updateStep(run, sd.id, 'failed', undefined, err.message)
      failures.add(sd.id)
    }
  }

  /** 收集依赖步骤的结果，拼接成上下文 */
  private buildDependencyContext(sd: WorkflowStepDef, run: WorkflowRun): string {
    if (!sd.dependsOn || sd.dependsOn.length === 0) return ''
    const parts: string[] = []
    for (const depId of sd.dependsOn) {
      const stepRun = run.steps.find((s) => s.stepId === depId)
      if (stepRun && stepRun.agentResult && stepRun.agentResult !== '(completed)') {
        const depDef = run.steps.find((s) => s.stepId === depId)
        parts.push(`\n\n## 来自步骤「${depId}」的结果\n\n${stepRun.agentResult}`)
      }
    }
    if (parts.length === 0) return ''
    return '\n\n---\n' + parts.join('\n') + '\n\n请基于以上步骤结果进行你的工作。'
  }

  private async waitForAgents(
    agentIds: string[],
    run: WorkflowRun,
    sd: WorkflowStepDef,
  ): Promise<{ id: string; summary: string; error?: string }[]> {
    console.log('[wf] waitForAgents ENTERED', { agentIds, stepId: sd.id })
    const timeout = sd.config.stepTimeoutMs ?? 60 * 60 * 1000
    const results = await Promise.allSettled(agentIds.map((id) => this.dispatch.waitForAgent(id, timeout)))
    return results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value
      log('WARN', 'workflow_agent_wait_error', {
        runId: run.runId,
        stepId: sd.id,
        agentId: agentIds[i],
        error: r.reason,
      })
      return { id: agentIds[i], summary: '', error: String(r.reason) }
    })
  }

  stopRun(runId: string): boolean {
    const run = workflowStore.getRun(runId)
    if (!run || run.status !== 'running') return false
    run.status = 'failed'
    workflowStore.updateRun(run)
    this.active = false
    this.runningDefs.delete(run.workflowDefId)
    return true
  }

  isActive(): boolean {
    return this.active
  }

  /** 从 s_browser 的 JSON 输出中提取截图路径，将文件移到成果目录 */
  private collectScreenshots(agentResult: string, outputDir: string): void {
    try {
      const parsed = JSON.parse(agentResult)
      const screenshotDir = path.join(outputDir, '截图')
      if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true })

      // 从输出的 JSON 中提取所有截图路径
      const screenshots: string[] = []
      const enterprises = parsed.enterprises || []
      for (const ent of enterprises) {
        const projects = ent.projects || []
        for (const proj of projects) {
          const ss = proj.screenshots || {}
          Object.values(ss).forEach((p: any) => {
            if (typeof p === 'string' && p.endsWith('.png')) screenshots.push(p)
          })
        }
      }

      for (const src of screenshots) {
        try {
          if (fs.existsSync(src)) {
            const basename = path.basename(src)
            const dest = path.join(screenshotDir, basename)
            if (src !== dest) fs.renameSync(src, dest)
          }
        } catch {
          /* 单个截图移动失败不影响整体 */
        }
      }
      if (screenshots.length > 0) {
        log('INFO', 'workflow_screenshots_collected', { count: screenshots.length, dir: screenshotDir })
      }
    } catch {
      /* JSON 解析失败说明输出不是 JSON，跳过 */
    }
  }

  /** 如果步骤配置了 outputFile，把步骤结果写入到该文件
   *
   * 占位符支持：
   * - {DATE} → 当天日期
   * - {OUTPUT_DIR} → 本次运行的根输出目录
   * - {STEP_ID} → 步骤 ID
   */
  private writeStepOutput(sd: WorkflowStepDef, content?: string, outputDir?: string): void {
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

      // 尝试解析 JSON 平台输出
      const parsed = tryParsePlatformContent(content)
      if (parsed) {
        this.writePlatformFiles(path.dirname(outputFile), parsed)
        return
      }

      // 普通文本写入单个文件
      const dir = path.dirname(outputFile)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(outputFile, content, 'utf-8')
      log('INFO', 'workflow_step_output_written', { stepId: sd.id, path: outputFile, bytes: content.length })
    } catch (err: any) {
      log('WARN', 'workflow_step_output_write_failed', { stepId: sd.id, path: outputFile, error: err.message })
    }
  }

  /** 按平台写入多个文件 */
  private writePlatformFiles(baseDir: string, platforms: Record<string, { title: string; body: string; cta?: string }>): void {
    for (const [platform, data] of Object.entries(platforms)) {
      const dir = path.join(baseDir, platform)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const title = data.title || '未命名'
      const safeName = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
      const filePath = path.join(dir, `${safeName}.md`)
      const md = [`# ${title}`, '', data.body, data.cta ? `\n---\n${data.cta}` : ''].join('\n')
      fs.writeFileSync(filePath, md, 'utf-8')
      log('INFO', 'workflow_platform_output_written', { platform, path: filePath, bytes: md.length })
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 尝试从 LLM 输出中解析 platforms 结构，失败返回 null */
function tryParsePlatformContent(content: string): Record<string, { title: string; body: string; cta?: string }> | null {
  // 尝试直接解析整个内容为 JSON
  try {
    const root = JSON.parse(content)
    const pkg = root.contentPackage || root
    const platforms = pkg.platforms
    if (platforms && typeof platforms === 'object') return platforms
  } catch {}
  // 尝试用正则提取 JSON 块
  const match = content.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (match) {
    try {
      const root = JSON.parse(match[1].trim())
      const platforms = root.contentPackage?.platforms || root.platforms
      if (platforms && typeof platforms === 'object') return platforms
    } catch {}
  }
  return null
}

// ── Module-level singleton ──
let _scheduler: WorkflowScheduler | null = null

export function setWorkflowScheduler(s: WorkflowScheduler): void {
  _scheduler = s
}

export function getWorkflowScheduler(): WorkflowScheduler {
  if (!_scheduler) throw new Error('WorkflowScheduler not initialized')
  return _scheduler
}
