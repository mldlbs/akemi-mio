import type { WorkerPool } from '../core/WorkerPool';
export interface VerificationConfig {
    compileCheck: boolean;
    testRun: boolean;
    lintCheck: boolean;
    typeCheck: boolean;
    timeout: number;
}
export interface CheckResult {
    passed: boolean;
    errors: string[];
    output?: string;
}
export interface VerificationResult {
    passed: boolean;
    checks: {
        compile?: CheckResult;
        test?: TestCheckResult;
        lint?: CheckResult;
    };
    duration: number;
    affectedFiles: string[];
}
export interface TestCheckResult {
    passed: boolean;
    passedCount: number;
    failedCount: number;
    output: string;
}
export declare class VerificationRunner {
    private config;
    private workerPool;
    constructor(config?: Partial<VerificationConfig>);
    setWorkerPool(wp: WorkerPool | null): void;
    verify(changedFiles: string[]): Promise<VerificationResult>;
    private _doVerify;
    private runCompileCheck;
    private runTestCheck;
    private runLintCheck;
}
