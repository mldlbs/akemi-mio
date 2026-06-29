/**
 * EvolutionReviewer — 进化流水线 Stage 4
 *
 * 职责：验证执行结果、回归检测、响应合规性验证
 * 生命周期：init() → [verify() / detectRegression() / stopAndValidate()] → destroy()
 */
import { log } from '../../logger/Logger';
import { formatValidationSummary } from '../ResponseValidator';
import { validateAllSandboxes } from '../SandboxValidator';
import { existsSync } from 'fs';
/** 沙盒产物根目录（由 AppRuntime 在运行时传入） */
let sandboxRoot = null;
export function setSandboxRoot(root) {
    sandboxRoot = root;
    log('INFO', 'sandbox_root_set', { root });
}
export class EvolutionReviewer {
    constructor(responseValidator, options) {
        this.name = 'EvolutionReviewer';
        this.state = 'created';
        this.verificationRunner = null;
        this.regressionDetector = null;
        this.gitOps = null;
        this.proposalValidator = null;
        this.lastValidationSummary = '';
        this.verifyAfterSteps = false;
        this.responseValidator = responseValidator;
        this.verificationRunner = options?.verificationRunner ?? null;
        this.regressionDetector = options?.regressionDetector ?? null;
        this.gitOps = options?.gitOps ?? null;
    }
    async init() {
        this.state = 'initializing';
        log('INFO', 'evolution_reviewer.init');
        this.state = 'ready';
    }
    async start() {
        this.state = 'running';
    }
    async stop() {
        this.state = 'ready';
    }
    async destroy() {
        this.state = 'stopped';
    }
    async healthCheck() {
        return { healthy: true };
    }
    setVerificationRunner(runner, verifyAfter) {
        this.verificationRunner = runner;
        if (verifyAfter !== undefined)
            this.verifyAfterSteps = verifyAfter;
    }
    setRegressionDetector(detector) {
        this.regressionDetector = detector;
    }
    setProposalValidator(v) {
        this.proposalValidator = v;
    }
    setGitOps(gitOps) {
        this.gitOps = gitOps;
    }
    getLastValidationSummary() {
        return this.lastValidationSummary;
    }
    // ==================== 响应合规性验证 ====================
    startListen() {
        this.responseValidator.startListening();
    }
    stopAndValidate(mode) {
        const result = this.responseValidator.stopAndValidate(mode);
        if (!result.passed) {
            this.lastValidationSummary = formatValidationSummary(result);
            log('WARN', 'evolution_validation_failed', {
                violations: result.violations.filter((v) => v.severity === 'error').length,
                details: this.lastValidationSummary,
            });
        }
        else {
            this.lastValidationSummary = '';
            log('INFO', 'evolution_validation_passed', { stats: result.stats });
        }
        return {
            passed: result.passed,
            violations: result.violations,
            warnings: result.warnings,
            stats: result.stats,
            validationSummary: this.lastValidationSummary,
        };
    }
    // ==================== 步骤后验证 ====================
    async verify(changedFiles) {
        // 1. 编译/测试/lint 验证（原有逻辑）
        let passed = true;
        if (this.verifyAfterSteps && this.verificationRunner) {
            const allChanged = [...changedFiles.newFiles, ...changedFiles.modifiedFiles];
            const verifyResult = await this.verificationRunner.verify(allChanged);
            if (!verifyResult.passed) {
                log('WARN', 'plan_step_verification_failed', {
                    compile: verifyResult.checks.compile?.passed,
                    test: verifyResult.checks.test?.passed,
                    lint: verifyResult.checks.lint?.passed,
                });
                passed = false;
            }
            else {
                log('INFO', 'plan_step_verification_passed');
            }
        }
        // 2. sandbox HTML 产物验证（新增）
        const sandboxHtmlFiles = [...changedFiles.newFiles, ...changedFiles.modifiedFiles].filter((f) => f.endsWith('.html') && f.includes('sandbox'));
        if (sandboxHtmlFiles.length > 0 && sandboxRoot && existsSync(sandboxRoot)) {
            log('INFO', 'sandbox_validation_check', { files: sandboxHtmlFiles });
            const sandboxResult = validateAllSandboxes(sandboxRoot);
            if (sandboxResult.failed > 0) {
                log('WARN', 'sandbox_validation_failed', {
                    total: sandboxResult.total,
                    failed: sandboxResult.failed,
                    details: Object.entries(sandboxResult.results)
                        .filter(([, r]) => !r.passed)
                        .map(([name, r]) => `${name}: ${r.summary}`)
                        .join(' | '),
                });
                passed = false;
            }
            else if (sandboxResult.total > 0) {
                log('INFO', 'sandbox_validation_passed', { total: sandboxResult.total });
            }
        }
        return { passed };
    }
    // ==================== 回归检测 ====================
    async detectRegression(changedFiles) {
        if (!this.regressionDetector)
            return { hasRegression: false };
        try {
            const before = await this.regressionDetector.snapshot();
            const after = await this.regressionDetector.snapshot();
            const report = await this.regressionDetector.detectRegression(before, after, changedFiles);
            if (report.hasRegression) {
                log('WARN', 'plan_step_regression_detected', {
                    testDelta: report.changes.testPassRate.delta,
                    compileDelta: report.changes.compileErrors.delta,
                });
            }
            else {
                log('INFO', 'plan_step_no_regression');
            }
            return { hasRegression: report.hasRegression };
        }
        catch (err) {
            log('WARN', 'plan_step_regression_check_failed', { error: String(err) });
            return { hasRegression: false };
        }
    }
    /** 整体审查入口：验证 + 回归 */
    async review(input) {
        const validation = this.stopAndValidate(input.mode);
        const [verificationResult, regressionResult] = await Promise.all([
            this.verify(input.changedFiles),
            this.detectRegression(input.changedFiles),
        ]);
        return {
            passed: validation.passed && verificationResult.passed && !regressionResult.hasRegression,
            verification: verificationResult,
            regression: regressionResult,
            validationSummary: validation.validationSummary,
        };
    }
}
