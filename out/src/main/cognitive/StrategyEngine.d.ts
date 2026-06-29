export interface Strategy {
    id: string;
    name: string;
    description: string;
    promptTemplate: string;
    applicableContext: string;
    priority: number;
    active: number;
    version: number;
    createdAt: number;
    updatedAt: number;
}
export type StrategyInput = Omit<Strategy, 'id' | 'createdAt' | 'updatedAt' | 'active' | 'version'>;
export declare class StrategyEngine {
    getActive(contextKeywords: string[]): Strategy[];
    create(input: StrategyInput): Strategy;
    analyzeFailures(failureLogs: Array<{
        task: string;
        error: string;
        timestamp: number;
    }>): string[];
    private matchesContext;
    getFormattedContext(keywords?: string[]): string;
    private rowToStrategy;
}
