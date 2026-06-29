import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import * as os from 'os'
import { WORKSPACE } from '../config/index'
import { eventBus } from '../core/EventBus'
import { log } from '../logger/Logger'
import type { WorkflowDef, WorkflowRun, WorkflowStepRun, WorkflowStoreData } from './types'
import { PRESET_DEFINITIONS } from './presets'

let idCounter = 0

const DEFINITIONS_DIR = join(WORKSPACE.workflows, 'definitions')
const RUNS_DIR = join(WORKSPACE.workflows, 'runs')

function ensureDirs(): void {
  if (!existsSync(DEFINITIONS_DIR)) mkdirSync(DEFINITIONS_DIR, { recursive: true })
  if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true })
}

function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return fallback
  }
}

function writeJsonSafe(path: string, data: unknown): void {
  try {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const tmp = path + '.tmp.' + Date.now()
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
    renameSync(tmp, path)
  } catch (err) {
    log('ERROR', 'workflow_write_failed', { path, error: String(err) })
  }
}

export class WorkflowStore {
  // ── Definitions ──

  listDefinitions(): WorkflowDef[] {
    ensureDirs()
    this.seedPresets()
    if (!existsSync(DEFINITIONS_DIR)) return []
    const files = readdirSync(DEFINITIONS_DIR).filter((f) => f.endsWith('.json'))
    return files.map((f) => readJson<WorkflowDef | null>(join(DEFINITIONS_DIR, f), null)).filter(Boolean) as WorkflowDef[]
  }

  getDefinition(id: string): WorkflowDef | null {
    return readJson<WorkflowDef | null>(join(DEFINITIONS_DIR, `${id}.json`), null)
  }

  saveDefinition(def: WorkflowDef): void {
    ensureDirs()
    def.updatedAt = Date.now()
    if (!def.createdAt) def.createdAt = Date.now()
    writeJsonSafe(join(DEFINITIONS_DIR, `${def.id}.json`), def)
    eventBus.emit('workflow.def.created' as any, { workflowDefId: def.id, name: def.name })
    log('INFO', 'workflow_def_saved', { id: def.id, name: def.name, steps: def.steps.length })
  }

  deleteDefinition(id: string): boolean {
    const path = join(DEFINITIONS_DIR, `${id}.json`)
    if (!existsSync(path)) return false
    try {
      unlinkSync(path)
      return true
    } catch {
      return false
    }
  }

  duplicateDefinition(id: string): WorkflowDef | null {
    const existing = this.getDefinition(id)
    if (!existing) return null
    const copy: WorkflowDef = {
      ...existing,
      id: `wf_dup_${Date.now()}`,
      name: `${existing.name} (副本)`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      enabled: false,
      steps: existing.steps.map((s) => ({ ...s, id: `s_dup_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` })),
    }
    this.saveDefinition(copy)
    return copy
  }

  deleteRun(runId: string): boolean {
    const path = join(RUNS_DIR, `${runId}.json`)
    if (!existsSync(path)) return false
    try {
      unlinkSync(path)
      return true
    } catch {
      return false
    }
  }

  // ── Runs ──

  listRuns(limit = 20): WorkflowRun[] {
    ensureDirs()
    if (!existsSync(RUNS_DIR)) return []
    const files = readdirSync(RUNS_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, limit)
    return files.map((f) => readJson<WorkflowRun | null>(join(RUNS_DIR, f), null)).filter(Boolean) as WorkflowRun[]
  }

  getRun(runId: string): WorkflowRun | null {
    return readJson<WorkflowRun | null>(join(RUNS_DIR, `${runId}.json`), null)
  }

  createRun(def: WorkflowDef): WorkflowRun {
    ensureDirs()
    const run: WorkflowRun = {
      runId: `run_${Date.now()}_${++idCounter}`,
      workflowDefId: def.id,
      workflowName: def.name,
      status: 'pending',
      steps: def.steps.map((s) => ({
        stepId: s.id,
        status: 'pending',
      })),
      startedAt: Date.now(),
    }
    writeJsonSafe(join(RUNS_DIR, `${run.runId}.json`), run)
    eventBus.emit('workflow.run.created' as any, {
      runId: run.runId,
      workflowDefId: def.id,
      workflowName: def.name,
      steps: def.steps.map((s) => ({ stepId: s.id, status: 'pending' })),
      startedAt: run.startedAt,
      status: 'running',
    })
    log('INFO', 'workflow_run_created', { runId: run.runId, defId: def.id })
    return run
  }

  updateRun(run: WorkflowRun): void {
    writeJsonSafe(join(RUNS_DIR, `${run.runId}.json`), run)
    eventBus.emit('workflow.run.updated' as any, { runId: run.runId, status: run.status })
  }

  updateStep(run: WorkflowRun, stepId: string, status: string, result?: string, error?: string): void {
    const step = run.steps.find((s) => s.stepId === stepId)
    if (!step) return
    step.status = status as any
    if (result) step.agentResult = result
    if (error) step.error = error
    if (status === 'running' && !step.startedAt) step.startedAt = Date.now()
    if (status === 'done' || status === 'failed') step.completedAt = Date.now()
    this.updateRun(run)
    eventBus.emit('workflow.run.step' as any, { runId: run.runId, stepId, status, error, agentResult: result })
  }

  // ── Preset seeding ──

  private seeded = false

  private seedPresets(): void {
    if (this.seeded) return
    this.seeded = true
    ensureDirs()
    for (const def of PRESET_DEFINITIONS) {
      const path = join(DEFINITIONS_DIR, `${def.id}.json`)
      if (!existsSync(path)) {
        writeJsonSafe(path, def)
      }
    }
  }
}

export const workflowStore = new WorkflowStore()

/** 解析本次运行的成果输出根目录
 *  优先使用 def.outputDir（支持 ~/Desktop 扩展），否则落到 runs/wf_{名称}/{时间戳}
 */
export function resolveRunOutputDir(def: WorkflowDef, run: WorkflowRun): string {
  const base = def.outputDir ? def.outputDir.replace(/^~/, os.homedir()) : join(RUNS_DIR, `wf_${def.name}`)
  const ts = new Date(run.startedAt).toISOString().slice(0, 16).replace('T', 'T')
  return join(base, ts)
}
