import { log } from '../logger/Logger';
import { execAsync } from '../utils/async';
import { DEV_PROJECT_ROOT } from '../config';
const PROJECT_ROOT = DEV_PROJECT_ROOT;
export class RegressionDetector {
    async snapshot() {
        const [testPassRate, compileErrors] = await Promise.all([this.getTestPassRate(), this.getCompileErrors()]);
        return { testPassRate, compileErrors, timestamp: Date.now() };
    }
    async detectRegression(before, after, changedFiles) {
        const testDelta = after.testPassRate - before.testPassRate;
        const compileDelta = after.compileErrors - before.compileErrors;
        const hasRegression = testDelta < -0.05 || compileDelta > 0;
        log('INFO', 'regression_check', {
            hasRegression,
            testDelta: testDelta.toFixed(2),
            compileDelta,
            newFiles: changedFiles.newFiles.length,
            modifiedFiles: changedFiles.modifiedFiles.length,
        });
        return {
            hasRegression,
            changes: {
                testPassRate: { before: before.testPassRate, after: after.testPassRate, delta: testDelta },
                compileErrors: { before: before.compileErrors, after: after.compileErrors, delta: compileDelta },
            },
            newFiles: changedFiles.newFiles,
            modifiedFiles: changedFiles.modifiedFiles,
        };
    }
    async getTestPassRate() {
        try {
            const output = await execAsync('npx vitest run --reporter=json 2>&1', {
                cwd: PROJECT_ROOT || process.cwd(),
                timeout: 60000,
            });
            const text = String(output || '');
            const total = parseInt(text.match(/(\d+)\s+tests/)?.[1] || '0');
            const failed = parseInt(text.match(/(\d+)\s+failed/)?.[1] || '0');
            return total > 0 ? (total - failed) / total : 1;
        }
        catch {
            return 1;
        }
    }
    async getCompileErrors() {
        try {
            const output = await execAsync('npx tsc --noEmit --pretty false 2>&1', {
                cwd: PROJECT_ROOT || process.cwd(),
                timeout: 60000,
            });
            const text = String(output || '');
            const IGNORED_TS_CODES = ['TS6305', 'TS6192', 'TS5053'];
            const errors = text.match(/error TS\d+/g) || [];
            return errors.filter((e) => !IGNORED_TS_CODES.some((code) => e.includes(code))).length;
        }
        catch {
            return 0;
        }
    }
}
