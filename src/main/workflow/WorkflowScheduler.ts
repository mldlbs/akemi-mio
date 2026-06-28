import { log } from '../logger/Logger'
import { eventBus } from '../core/EventBus'
import { workflowStore } from './WorkflowStore'
import type { WorkflowDef, WorkflowRun, WorkflowStepDef, WorkflowStepRun } from './types'

export interface WorkflowDispatch {
  runSubAgent: (goal: string, parentGoal?: string) => string
  runTool: (name: string, args: Record<string, any>) => Promise<string>
  runApi: (url: string, method: string, body?: any) => Promise<string>
  injectPrompt: (prompt: string) => void
  getCompletedAgentResults: () => { id: string; summary: string; error?: string }[]
  runPlan: (prompt: string) => string
  getPlanStatus: () => { id: string; title: string; total: number; done: number; pending: string[]; status: string } | null
}

export class WorkflowScheduler {
  private dispatch: WorkflowDispatch
  private pendingAgents = new Map<string, string[]>()
  private active = false

  constructor(dispatch: WorkflowDispatch) {
    this.dispatch = dispatch
  }

  startRun(def: WorkflowDef): WorkflowRun {
    const run = workflowStore.createRun(def)
    run.status = 'running'
    workflowStore.updateRun(run)
    this.active = true

    log('INFO', 'workflow_run_started', { runId: run.runId, defId: def.id, steps: def.steps.length })

    // Execute in background
    this.executeLoop(run, def).catch((err) => {
      log('ERROR', 'workflow_execution_error', { runId: run.runId, error: String(err) })
      run.status = 'failed'
      workflowStore.updateRun(run)
      this.active = false
    })

    return run
  }

  private async executeLoop(run: WorkflowRun, def: WorkflowDef): Promise<void> {
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
        if (allDone) run.status = 'done'
        else if (allFailed) run.status = 'failed'
        else run.status = completed.size > 0 ? 'done' : 'failed'
        workflowStore.updateRun(run)
        this.active = false
        return
      }

      const promises = runnable.map(async (sd) => {
        workflowStore.updateStep(run, sd.id, 'running')

        try {
          const agentIds: string[] = []

          switch (sd.handler) {
            case 'subagent': {
              const agentId = this.dispatch.runSubAgent(sd.config.prompt || sd.description, def.description)
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
              this.dispatch.runPlan(planPrompt)
              // Poll for plan completion
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
            await this.waitForAgents(agentIds, run, sd)
            const results = this.dispatch.getCompletedAgentResults()
            const agentResult = results.find((r) => agentIds.includes(r.id))
            if (agentResult?.error) {
              workflowStore.updateStep(run, sd.id, 'failed', agentResult.summary, agentResult.error)
              failures.add(sd.id)
            } else {
              workflowStore.updateStep(run, sd.id, 'done', agentResult?.summary || '(completed)')
              completed.add(sd.id)
            }
          }
        } catch (err: any) {
          log('WARN', 'workflow_step_failed', { runId: run.runId, stepId: sd.id, error: err.message })
          workflowStore.updateStep(run, sd.id, 'failed', undefined, err.message)
          failures.add(sd.id)
        }
      })

      await Promise.allSettled(promises)
    }
  }

  private async waitForAgents(agentIds: string[], run: WorkflowRun, sd: WorkflowStepDef): Promise<void> {
    for (let i = 0; i < 300; i++) {
      const results = this.dispatch.getCompletedAgentResults()
      const done = agentIds.every((id) => results.some((r) => r.id === id))
      if (done) return
      await sleep(1000)
    }
    log('WARN', 'workflow_agent_wait_timeout', { runId: run.runId, stepId: sd.id })
  }

  stopRun(runId: string): boolean {
    const run = workflowStore.getRun(runId)
    if (!run || run.status !== 'running') return false
    run.status = 'failed'
    workflowStore.updateRun(run)
    this.active = false
    return true
  }

  isActive(): boolean {
    return this.active
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
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
