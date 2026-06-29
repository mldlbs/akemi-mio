/**
 * EvolutionReviewer — 进化流水线 Stage 4
 *
 * 职责：验证执行结果、回归检测、响应合规性验证
 * 生命周期：init() → [verify() / detectRegression() / stopAndValidate()] → destroy()
 */
import type { ResponseValidator } from '../ResponseValidator';
import type { VerificationRunner } from '../VerificationRunner';
import type { RegressionDetector } from '../RegressionDetector';
import type { EvolutionGitOps } from '../EvolutionGitOps';
import type { ISubsystem, HealthCheckResult, SubsystemState } from '../../core/lifecycle/types';
import type { ReviewInput, ReviewResult } from './types';
export declare function setSandboxRoot(root: string): void;
export declare class EvolutionReviewer implements ISubsystem {
    readonly name = "EvolutionReviewer";
    state: SubsystemState;
    private responseValidator;
    private verificationRunner;
    private regressionDetector;
    private gitOps;
    private proposalValidator;
    private lastValidationSummary;
    private verifyAfterSteps;
    constructor(responseValidator: ResponseValidator, options?: {
        verificationRunner?: VerificationRunner | null;
        regressionDetector?: RegressionDetector | null;
        gitOps?: EvolutionGitOps | null;
    });
    init(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    destroy(): Promise<void>;
    healthCheck(): Promise<HealthCheckResult>;
    setVerificationRunner(runner: VerificationRunner | null, verifyAfter?: boolean): void;
    setRegressionDetector(detector: RegressionDetector | null): void;
    setProposalValidator(v: any): void;
    setGitOps(gitOps: EvolutionGitOps | null): void;
    getLastValidationSummary(): string;
    startListen(): void;
    stopAndValidate(mode: 'analyze' | 'execute'): {
        passed: boolean;
        violations: any[];
        warnings: string[];
        stats: any;
        validationSummary: string;
    };
    verify(changedFiles: {
        newFiles: string[];
        modifiedFiles: string[];
    }): Promise<{
        passed: boolean;
    }>;
    detectRegression(changedFiles: {
        newFiles: string[];
        modifiedFiles: string[];
    }): Promise<{
        hasRegression: boolean;
    }>;
    /** 整体审查入口：验证 + 回归 */
    review(input: ReviewInput): Promise<ReviewResult>;
}
