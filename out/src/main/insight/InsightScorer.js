export class InsightScorer {
    score(rawDetections, ctx) {
        return rawDetections.map((r, i) => {
            const score = this.calculateScore(r);
            const confidence = this.calculateConfidence(r, ctx);
            return {
                id: `insight_${Date.now()}_${i}`,
                detector: r.detector,
                title: r.title,
                description: r.description,
                evidence: r.evidence,
                score,
                confidence,
                createdAt: Date.now()
            };
        }).sort((a, b) => b.score - a.score);
    }
    calculateScore(raw) {
        const n = raw.novelty * 0.4;
        const i = raw.impact * 0.4;
        const a = raw.actionability * 0.2;
        return Math.round((n + i + a) * 100) / 100;
    }
    calculateConfidence(raw, ctx) {
        const evidenceCount = raw.evidence.length;
        const evidenceQuality = this.evidenceQuality(raw.evidence);
        const dataFreshness = this.dataFreshness(ctx);
        const rawConfidence = evidenceCount * 0.25 * evidenceQuality * dataFreshness;
        return Math.round(Math.min(Math.max(rawConfidence, 0), 1) * 100) / 100;
    }
    evidenceQuality(evidence) {
        if (evidence.length === 0)
            return 0.3;
        const avgLen = evidence.reduce((s, e) => s + e.length, 0) / evidence.length;
        if (avgLen > 50)
            return 1.0;
        if (avgLen > 20)
            return 0.8;
        if (avgLen > 10)
            return 0.6;
        return 0.4;
    }
    dataFreshness(ctx) {
        if (ctx.interactionCount === 0)
            return 0.2;
        if (ctx.memoryEntries.length === 0)
            return 0.3;
        const freshness = Math.min(ctx.interactionCount / 100, 1);
        return 0.5 + 0.5 * freshness;
    }
    filterLowValue(insights) {
        return insights.filter(i => i.score >= 20);
    }
}
