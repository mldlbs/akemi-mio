import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { WORKSPACE } from '../config/index';
import { eventBus } from '../core/EventBus';
import { log } from '../logger/Logger';
import { PRESET_DEFINITIONS } from './presets';
let idCounter = 0;
const DEFINITIONS_DIR = join(WORKSPACE.workflows, 'definitions');
const RUNS_DIR = join(WORKSPACE.workflows, 'runs');
function ensureDirs() {
    if (!existsSync(DEFINITIONS_DIR))
        mkdirSync(DEFINITIONS_DIR, { recursive: true });
    if (!existsSync(RUNS_DIR))
        mkdirSync(RUNS_DIR, { recursive: true });
}
function readJson(path, fallback) {
    try {
        if (!existsSync(path))
            return fallback;
        return JSON.parse(readFileSync(path, 'utf-8'));
    }
    catch {
        return fallback;
    }
}
function writeJsonSafe(path, data) {
    try {
        const dir = dirname(path);
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
        const tmp = path + '.tmp.' + Date.now();
        writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
        renameSync(tmp, path);
    }
    catch (err) {
        log('ERROR', 'workflow_write_failed', { path, error: String(err) });
    }
}
export class WorkflowStore {
    constructor() {
        // ── Definitions ──
        // ── Preset seeding ──
        this.seeded = false;
    }
    listDefinitions() {
        ensureDirs();
        this.seedPresets();
        if (!existsSync(DEFINITIONS_DIR))
            return [];
        const files = readdirSync(DEFINITIONS_DIR).filter((f) => f.endsWith('.json'));
        return files.map((f) => readJson(join(DEFINITIONS_DIR, f), null)).filter(Boolean);
    }
    getDefinition(id) {
        return readJson(join(DEFINITIONS_DIR, `${id}.json`), null);
    }
    saveDefinition(def) {
        ensureDirs();
        def.updatedAt = Date.now();
        if (!def.createdAt)
            def.createdAt = Date.now();
        writeJsonSafe(join(DEFINITIONS_DIR, `${def.id}.json`), def);
        eventBus.emit('workflow.def.created', { workflowDefId: def.id, name: def.name });
        log('INFO', 'workflow_def_saved', { id: def.id, name: def.name, steps: def.steps.length });
    }
    deleteDefinition(id) {
        const path = join(DEFINITIONS_DIR, `${id}.json`);
        if (!existsSync(path))
            return false;
        try {
            unlinkSync(path);
            return true;
        }
        catch {
            return false;
        }
    }
    // ── Runs ──
    listRuns(limit = 20) {
        ensureDirs();
        if (!existsSync(RUNS_DIR))
            return [];
        const files = readdirSync(RUNS_DIR)
            .filter((f) => f.endsWith('.json'))
            .sort()
            .reverse()
            .slice(0, limit);
        return files.map((f) => readJson(join(RUNS_DIR, f), null)).filter(Boolean);
    }
    getRun(runId) {
        return readJson(join(RUNS_DIR, `${runId}.json`), null);
    }
    createRun(def) {
        ensureDirs();
        const run = {
            runId: `run_${Date.now()}_${++idCounter}`,
            workflowDefId: def.id,
            workflowName: def.name,
            status: 'pending',
            steps: def.steps.map((s) => ({
                stepId: s.id,
                status: 'pending',
            })),
            startedAt: Date.now(),
        };
        writeJsonSafe(join(RUNS_DIR, `${run.runId}.json`), run);
        eventBus.emit('workflow.run.created', { runId: run.runId, workflowDefId: def.id });
        log('INFO', 'workflow_run_created', { runId: run.runId, defId: def.id });
        return run;
    }
    updateRun(run) {
        writeJsonSafe(join(RUNS_DIR, `${run.runId}.json`), run);
        eventBus.emit('workflow.run.updated', { runId: run.runId, status: run.status });
    }
    updateStep(run, stepId, status, result, error) {
        const step = run.steps.find((s) => s.stepId === stepId);
        if (!step)
            return;
        step.status = status;
        if (result)
            step.agentResult = result;
        if (error)
            step.error = error;
        if (status === 'running' && !step.startedAt)
            step.startedAt = Date.now();
        if (status === 'done' || status === 'failed')
            step.completedAt = Date.now();
        this.updateRun(run);
        eventBus.emit('workflow.run.step', { runId: run.runId, stepId, status });
    }
    seedPresets() {
        if (this.seeded)
            return;
        this.seeded = true;
        ensureDirs();
        for (const def of PRESET_DEFINITIONS) {
            const path = join(DEFINITIONS_DIR, `${def.id}.json`);
            if (!existsSync(path)) {
                writeJsonSafe(path, def);
            }
        }
    }
}
// ── Module-level singleton ──
export const workflowStore = new WorkflowStore();
