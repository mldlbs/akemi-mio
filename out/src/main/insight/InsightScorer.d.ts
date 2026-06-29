import type { RawDetection, Insight, DetectionContext } from './types';
export declare class InsightScorer {
    score(rawDetections: RawDetection[], ctx: DetectionContext): Insight[];
    private calculateScore;
    private calculateConfidence;
    private evidenceQuality;
    private dataFreshness;
    filterLowValue(insights: Insight[]): Insight[];
}
