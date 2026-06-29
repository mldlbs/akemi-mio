export interface BaselineSnapshot {
    testPassRate: number;
    compileErrors: number;
    timestamp: number;
}
export interface RegressionReport {
    hasRegression: boolean;
    changes: {
        testPassRate: {
            before: number;
            after: number;
            delta: number;
        };
        compileErrors: {
            before: number;
            after: number;
            delta: number;
        };
    };
    newFiles: string[];
    modifiedFiles: string[];
}
export declare class RegressionDetector {
    snapshot(): Promise<BaselineSnapshot>;
    detectRegression(before: BaselineSnapshot, after: BaselineSnapshot, changedFiles: {
        newFiles: string[];
        modifiedFiles: string[];
    }): Promise<RegressionReport>;
    private getTestPassRate;
    private getCompileErrors;
}
