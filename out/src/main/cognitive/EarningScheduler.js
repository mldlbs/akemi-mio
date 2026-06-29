import { execAsync } from '../utils/async';
import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logger/Logger';
import { WORKSPACE } from '../config';
import { scheduler } from '../core/Scheduler';
const EARNING_DIR = path.join(WORKSPACE.evolution, 'sandbox', 'earning');
const RESULT_FILE = path.join(EARNING_DIR, '.last_result.json');
const EARNING_SCRIPT = path.join(EARNING_DIR, 'now.ts');
export class EarningScheduler {
    constructor(tokenAccount) {
        this.initialized = false;
        this.tokenAccount = tokenAccount;
    }
    initialize() {
        if (this.initialized)
            return;
        scheduler.cron(0, 9, async () => {
            await this.runEarningCycle();
            return 'earning_daily_done';
        }, '@earning');
        log('INFO', 'earning_scheduler_registered', { script: EARNING_SCRIPT });
        this.initialized = true;
    }
    async runOnce() {
        return this.runEarningCycle();
    }
    async runEarningCycle() {
        log('INFO', 'earning_cycle_start');
        try {
            await fs.promises.access(EARNING_SCRIPT);
        }
        catch {
            log('WARN', 'earning_script_not_found', { path: EARNING_SCRIPT });
            return null;
        }
        try {
            await fs.promises.unlink(RESULT_FILE);
        }
        catch { }
        try {
            const rawStdout = await execAsync('npx tsx now.ts', {
                cwd: EARNING_DIR,
                timeout: 10 * 60 * 1000,
            });
            const stdout = rawStdout;
            log('INFO', 'earning_script_output', { stdout: stdout.slice(0, 500) });
            try {
                await fs.promises.access(RESULT_FILE);
            }
            catch {
                log('WARN', 'earning_result_file_missing');
                return null;
            }
            const raw = await fs.promises.readFile(RESULT_FILE, 'utf-8');
            const result = JSON.parse(raw);
            for (const r of result.results) {
                if (r.confirmedEarnings > 0) {
                    this.tokenAccount.earn(r.confirmedEarnings, 'earning_task', `平台: ${r.taskId} 到账 ¥${r.confirmedEarnings}`);
                }
            }
            const totalEstimated = result.totalEstimated;
            if (totalEstimated > 0) {
                this.tokenAccount.earn(Math.floor(totalEstimated * 0.1), 'earning_effort', `每日执行 ${result.results.length} 个平台，预估 ¥${totalEstimated}`);
            }
            log('INFO', 'earning_cycle_done', {
                totalEstimated: result.totalEstimated,
                totalConfirmed: result.totalConfirmed,
                taskCount: result.results.length,
            });
            return result;
        }
        catch (err) {
            const stderr = err.stderr?.toString().slice(0, 1000) || '';
            const stdout = err.stdout?.toString().slice(0, 500) || '';
            log('WARN', 'earning_cycle_failed', { error: String(err).slice(0, 200), stderr, stdout });
            return null;
        }
    }
    async getLastResult() {
        try {
            await fs.promises.access(RESULT_FILE);
            const raw = await fs.promises.readFile(RESULT_FILE, 'utf-8');
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
}
