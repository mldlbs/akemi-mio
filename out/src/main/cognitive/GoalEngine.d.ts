export interface Goal {
    id: string;
    title: string;
    description: string;
    priority: number;
    status: 'active' | 'paused' | 'completed' | 'abandoned';
    category: 'mission' | 'long_term' | 'short_term' | 'initiative';
    parentGoalId: string | null;
    progress: number;
    createdAt: number;
    updatedAt: number;
}
export type GoalInput = Omit<Goal, 'id' | 'createdAt' | 'updatedAt' | 'progress'>;
export declare class GoalEngine {
    getActiveGoals(category?: Goal['category']): Goal[];
    getGoal(id: string): Goal | null;
    create(input: GoalInput): Goal;
    updateProgress(id: string, delta: number): void;
    setStatus(id: string, status: Goal['status']): void;
    getFormattedContext(): string;
    adjustPrioritiesByToken(tokenBalance: number): void;
    private estimateTokenCost;
    private rowToGoal;
}
