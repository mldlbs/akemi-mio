/**
 * WorkflowStoreV2 — SQLite 持久化实现
 *
 * 替代旧版 WorkflowStore（JSON 文件），使用 sql.js 直接读写。
 * 兼容 WorkflowDef 和 WorkflowRun 的内存模型，存为 JSON 文本字段。
 */
import { getRawDb, markDirty } from '../db/connection'
import { eventBus } from '../core/EventBus'
import { log } from '../logger/Logger'
import { WORKSPACE } from '../config/index'
import type { WorkflowDef, WorkflowRun, WorkflowStepRun } from './types'
import { PRESET_DEFINITIONS } from './presets'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { join } from 'path'

let idCounter = 0

export class WorkflowStoreV2 {
  private seeded = false

  private get db() {
    return getRawDb()
  }

  // ── Definitions ──

  listDefinitions(): WorkflowDef[] {
    this.seedPresets()
    const rows = this.db.exec('SELECT definition FROM workflow_defs ORDER BY created_at DESC')
    if (!rows.length || !rows[0].values.length) return []
    return rows[0].values
      .map((row: any) => {
        try {
          return JSON.parse(row[0] as string) as WorkflowDef
        } catch {
          return null
        }
      })
      .filter(Boolean) as WorkflowDef[]
  }

  getDefinition(id: string): WorkflowDef | null {
    const stmt = this.db.prepare('SELECT definition FROM workflow_defs WHERE id = ?')
    stmt.bind([id])
    if (!stmt.step()) {
      stmt.free()
      return null
    }
    const row = stmt.getAsObject() as any
    stmt.free()
    try {
      return JSON.parse(row.definition) as WorkflowDef
    } catch {
      return null
    }
  }

  saveDefinition(def: WorkflowDef): void {
    def.updatedAt = Date.now()
    if (!def.createdAt) def.createdAt = Date.now()

    const existing = this.db.prepare('SELECT 1 FROM workflow_defs WHERE id = ?')
    existing.bind([def.id])
    const exists = existing.step()
    existing.free()

    if (exists) {
      this.db.run('UPDATE workflow_defs SET name = ?, description = ?, definition = ?, enabled = ?, updated_at = ? WHERE id = ?', [
        def.name,
        def.description,
        JSON.stringify(def),
        def.enabled !== false ? 1 : 0,
        def.updatedAt,
        def.id,
      ])
    } else {
      this.db.run(
        'INSERT INTO workflow_defs (id, name, description, definition, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [def.id, def.name, def.description, JSON.stringify(def), def.enabled !== false ? 1 : 0, def.createdAt, def.updatedAt],
      )
    }
    markDirty()

    eventBus.emit('workflow.def.created' as any, { workflowDefId: def.id, name: def.name })
    log('INFO', 'workflow_def_saved', { id: def.id, name: def.name, steps: def.steps.length })
  }

  deleteDefinition(id: string): boolean {
    const stmt = this.db.prepare('SELECT 1 FROM workflow_defs WHERE id = ?')
    stmt.bind([id])
    const exists = stmt.step()
    stmt.free()
    if (!exists) return false
    this.db.run('DELETE FROM workflow_defs WHERE id = ?', [id])
    markDirty()
    return true
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

  enableDefinition(id: string): boolean {
    this.db.run('UPDATE workflow_defs SET enabled = 1 WHERE id = ?', [id])
    markDirty()
    return true
  }

  disableDefinition(id: string): boolean {
    this.db.run('UPDATE workflow_defs SET enabled = 0 WHERE id = ?', [id])
    markDirty()
    return true
  }

  // ── Runs ──

  listRuns(limit = 50): WorkflowRun[] {
    const stmt = this.db.prepare('SELECT * FROM workflow_runs ORDER BY started_at DESC LIMIT ?')
    stmt.bind([limit])
    const runs: WorkflowRun[] = []
    while (stmt.step()) {
      const row = stmt.getAsObject() as any
      runs.push(this.rowToRun(row))
    }
    stmt.free()
    return runs
  }

  listActiveRuns(): WorkflowRun[] {
    const stmt = this.db.prepare("SELECT * FROM workflow_runs WHERE status IN ('running','paused') ORDER BY started_at DESC")
    const runs: WorkflowRun[] = []
    while (stmt.step()) {
      const row = stmt.getAsObject() as any
      runs.push(this.rowToRun(row))
    }
    stmt.free()
    return runs
  }

  getRun(runId: string): WorkflowRun | null {
    const stmt = this.db.prepare('SELECT * FROM workflow_runs WHERE run_id = ?')
    stmt.bind([runId])
    if (!stmt.step()) {
      stmt.free()
      return null
    }
    const row = stmt.getAsObject() as any
    stmt.free()
    return this.rowToRun(row)
  }

  createRun(def: WorkflowDef, trigger?: WorkflowRun['trigger']): WorkflowRun {
    const runId = `run_${Date.now()}_${++idCounter}`
    const now = Date.now()
    const run: WorkflowRun = {
      runId,
      workflowDefId: def.id,
      workflowName: def.name,
      status: 'pending',
      steps: def.steps.map((s) => ({ stepId: s.id, status: 'pending' })),
      startedAt: now,
      trigger,
    }

    this.db.run(
      `INSERT INTO workflow_runs (run_id, workflow_def_id, workflow_name, status, trigger, context, pending_gate, user_input, started_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      [runId, def.id, def.name, trigger ? JSON.stringify(trigger) : null, null, null, null, now],
    )

    for (const s of def.steps) {
      this.db.run(
        `INSERT INTO workflow_step_runs (id, run_id, step_id, status, retry_count, started_at)
         VALUES (?, ?, ?, 'pending', 0, ?)`,
        [`${runId}_${s.id}`, runId, s.id, now],
      )
    }
    markDirty()

    eventBus.emit('workflow.run.created' as any, {
      runId: run.runId,
      workflowDefId: def.id,
      workflowName: def.name,
      steps: run.steps,
      startedAt: run.startedAt,
      status: 'running',
    })
    log('INFO', 'workflow_run_created', { runId: run.runId, defId: def.id })
    return run
  }

  updateRun(run: WorkflowRun): void {
    this.db.run(
      `UPDATE workflow_runs SET status = ?, context = ?, pending_gate = ?, completed_at = ?
       WHERE run_id = ?`,
      [
        run.status,
        run.context ? JSON.stringify(run.context) : null,
        run.pendingGate ? JSON.stringify(run.pendingGate) : null,
        run.completedAt ?? null,
        run.runId,
      ],
    )
    markDirty()
    eventBus.emit('workflow.run.updated' as any, { runId: run.runId, status: run.status })
  }

  updateStep(run: WorkflowRun, stepId: string, status: string, result?: string, error?: string): void {
    const now = Date.now()
    const step = run.steps.find((s) => s.stepId === stepId)
    if (!step) return
    step.status = status as any
    if (result !== undefined) step.agentResult = result
    if (error !== undefined) step.error = error
    if (status === 'running' && !step.startedAt) step.startedAt = now
    if (status === 'done' || status === 'failed') step.completedAt = now

    this.db.run(
      `UPDATE workflow_step_runs SET status = ?, output = ?, error = ?, retry_count = ?, completed_at = ?
       WHERE run_id = ? AND step_id = ?`,
      [
        status,
        result ? result : null,
        error ?? null,
        step.retryCount ?? 0,
        status === 'done' || status === 'failed' ? now : null,
        run.runId,
        stepId,
      ],
    )
    markDirty()
    this.updateRun(run)
    eventBus.emit('workflow.run.step' as any, { runId: run.runId, stepId, status, error, agentResult: result })
  }

  deleteRun(runId: string): boolean {
    this.db.run('DELETE FROM workflow_step_runs WHERE run_id = ?', [runId])
    this.db.run('DELETE FROM workflow_runs WHERE run_id = ?', [runId])
    markDirty()
    return true
  }

  // ── Presets ──

  private seedPresets(): void {
    if (this.seeded) return
    this.seeded = true

    // 从旧 JSON 文件目录导入一次
    this.importLegacyDefinitions()

    for (const def of PRESET_DEFINITIONS) {
      const stmt = this.db.prepare('SELECT 1 FROM workflow_defs WHERE id = ?')
      stmt.bind([def.id])
      const exists = stmt.step()
      stmt.free()
      if (!exists) {
        this.saveDefinition(def)
      }
    }
  }

  private importLegacyDefinitions(): void {
    try {
      const legacyDir = join(WORKSPACE.workflows, 'definitions')
      if (!fs.existsSync(legacyDir)) return
      const files = fs.readdirSync(legacyDir).filter((f) => f.endsWith('.json'))
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(legacyDir, file), 'utf-8')
          const def = JSON.parse(content) as WorkflowDef
          if (!def.id || !def.name) continue
          const stmt = this.db.prepare('SELECT 1 FROM workflow_defs WHERE id = ?')
          stmt.bind([def.id])
          const exists = stmt.step()
          stmt.free()
          if (!exists) {
            this.saveDefinition(def)
            log('INFO', 'workflow_legacy_imported', { id: def.id, name: def.name, file })
          }
        } catch {
          // skip malformed JSON files
        }
      }
    } catch (err: any) {
      log('WARN', 'workflow_legacy_import_error', { error: err.message })
    }
  }

  // ── Row mapping ──

  private rowToRun(row: any): WorkflowRun {
    const stmt = this.db.prepare('SELECT * FROM workflow_step_runs WHERE run_id = ? ORDER BY started_at ASC')
    stmt.bind([row.run_id])
    const steps: WorkflowStepRun[] = []
    while (stmt.step()) {
      const sr = stmt.getAsObject() as any
      steps.push({
        stepId: sr.step_id,
        status: sr.status,
        agentResult: sr.output,
        error: sr.error,
        retryCount: sr.retry_count,
        startedAt: sr.started_at,
        completedAt: sr.completed_at,
      })
    }
    stmt.free()

    return {
      runId: row.run_id,
      workflowDefId: row.workflow_def_id,
      workflowName: row.workflow_name,
      status: row.status,
      steps,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      userInput: row.user_input ?? undefined,
      trigger: row.trigger ? JSON.parse(row.trigger) : undefined,
      context: row.context ? JSON.parse(row.context) : undefined,
      pendingGate: row.pending_gate ? JSON.parse(row.pending_gate) : undefined,
    }
  }
}

export const workflowStore = new WorkflowStoreV2()

export function resolveRunOutputDir(def: WorkflowDef, run: WorkflowRun): string {
  const RUNS_DIR = join(process.env['WORKSPACE'] || process.cwd(), 'runs')
  const base = def.outputDir ? def.outputDir.replace(/^~/, os.homedir()) : join(RUNS_DIR, `wf_${def.name}`)
  const ts = new Date(run.startedAt).toISOString().slice(0, 16).replace('T', 'T')
  return join(base, ts)
}
