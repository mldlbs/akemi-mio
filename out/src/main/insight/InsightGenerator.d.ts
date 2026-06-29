import type { Insight, DetectionContext } from './types';
export interface InsightGeneratorDeps {
    chatJson: (userText: string, options?: {
        system?: string;
        temperature?: number;
        timeoutMs?: number;
        requestId?: string;
    }) => Promise<{
        data?: any;
        error?: string;
    }>;
}
export declare class InsightGenerator {
    private scorer;
    private llm;
    /** 保留原有 detector 引用，但已不再主动运行它们 */
    private detectors;
    constructor(llm: InsightGeneratorDeps);
    generate(ctx: DetectionContext): Promise<Insight[]>;
}
