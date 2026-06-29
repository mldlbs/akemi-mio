export interface Proposal {
    id: string;
    title: string;
    description: string;
    targetFiles: string[];
    expectedOutcome: string;
    risk: 'low' | 'medium' | 'high';
    createdAt: number;
}
export interface ProposalValidation {
    proposalId: string;
    passed: boolean;
    constitutional: {
        passed: boolean;
        violations: string[];
    };
    scopeCheck: {
        passed: boolean;
        message: string;
    };
    regressionRisk: 'low' | 'medium' | 'high';
    budgetCheck?: {
        passed: boolean;
        message: string;
    };
}
export declare class ProposalValidator {
    private constitution;
    private planManager;
    private resourceBudget;
    private stabilityScore;
    setConstitution(engine: {
        checkWrite: Function;
    }): void;
    setPlanManager(mgr: {
        listPlans: Function;
    }): void;
    setResourceBudget(budget: any): void;
    setStabilityScore(ss: any): void;
    validate(proposal: Proposal): Promise<ProposalValidation>;
    private checkConstitutional;
    private checkScope;
    private assessRegressionRisk;
    private checkBudget;
}
