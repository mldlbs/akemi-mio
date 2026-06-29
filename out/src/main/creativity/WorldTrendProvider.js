import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { resolveRandom } from '../utils/random';
/**
 * WorldTrendProvider — 从 Observer trends/ + observations/ 读取真实片段
 *
 * 不再返回干巴巴的关键词，而是返回具体的观察片段。
 * "高考" → "一个考生查分时全家屏住呼吸的视频获得300万点赞"
 */
export class WorldTrendProvider {
    constructor(observerDir, seed) {
        this.consumedNames = new Set();
        this.observerDir = observerDir;
        this.rng = resolveRandom(seed);
    }
    resetConsumed() {
        this.consumedNames.clear();
    }
    /**
     * 返回精选观察片段（3-6 条），按热度排序、轮换选取。
     */
    getTrends() {
        const signals = this.loadSignals(3);
        if (signals.length === 0)
            return [];
        const obsMap = this.buildObsMap(3);
        // 从 top-30 信号中取每条的前 2 条原文
        const candidates = signals.slice(0, 30);
        const allSnippets = [];
        const seenContent = new Set();
        for (const s of candidates) {
            const ids = (s.recentObservationIds ?? []).slice(0, 2);
            for (const id of ids) {
                const obs = obsMap.get(id);
                if (!obs)
                    continue;
                const text = `[${obs.source}] ${obs.content}`;
                const key = obs.content.slice(0, 50);
                if (seenContent.has(key))
                    continue;
                seenContent.add(key);
                allSnippets.push(text);
            }
            if (allSnippets.length >= 30)
                break;
        }
        if (allSnippets.length === 0)
            return [];
        // 轮换选取
        const fresh = allSnippets.filter((s) => !this.consumedNames.has(s.slice(0, 60)));
        const pool = fresh.length >= 3 ? fresh : (this.consumedNames.clear(), allSnippets);
        const count = Math.min(pool.length, 3 + Math.floor(this.rng() * 3));
        const shuffled = [...pool].sort(() => this.rng() - 0.5);
        const picked = shuffled.slice(0, count);
        for (const p of picked)
            this.consumedNames.add(p.slice(0, 60));
        return picked;
    }
    /**
     * 获取最近几天的精选观察片段（结构化，供工具使用）。
     */
    getTrendSignals(days = 3, limit = 20) {
        const signals = this.loadSignals(days);
        const obsMap = this.buildObsMap(days);
        const seen = new Set();
        return signals
            .filter((s) => {
            const key = s.keyword.trim();
            if (seen.has(key) || s.score < 0.3)
                return false;
            seen.add(key);
            return true;
        })
            .slice(0, limit)
            .map((s) => {
            const ids = (s.recentObservationIds ?? []).slice(0, 3);
            const snippets = [];
            const seenSnippet = new Set();
            for (const id of ids) {
                const obs = obsMap.get(id);
                if (!obs)
                    continue;
                const text = `[${obs.source}] ${obs.content.slice(0, 150)}`;
                const key = obs.content.slice(0, 50);
                if (seenSnippet.has(key))
                    continue;
                seenSnippet.add(key);
                snippets.push(text);
            }
            return { keyword: s.keyword, snippets, score: s.score };
        });
    }
    /**
     * 从 insights/ 取主题名。
     */
    getInsights() {
        const insightsDir = join(this.observerDir, 'insights');
        if (!existsSync(insightsDir))
            return [];
        try {
            const files = readdirSync(insightsDir)
                .filter((f) => f.endsWith('.json'))
                .sort()
                .reverse()
                .slice(0, 5);
            const topics = [];
            for (const file of files) {
                const raw = readFileSync(join(insightsDir, file), 'utf-8');
                const data = JSON.parse(raw);
                const topic = data.topic?.trim();
                if (topic && topic.length > 2 && topic.length < 50) {
                    topics.push(`昨日研究: ${topic}`);
                }
            }
            return topics;
        }
        catch {
            return [];
        }
    }
    // ── private ──────────────────────────────────────────────
    loadSignals(days) {
        const dir = join(this.observerDir, 'trends');
        if (!existsSync(dir))
            return [];
        const files = readdirSync(dir)
            .filter((f) => f.endsWith('.json'))
            .sort()
            .reverse()
            .slice(0, days);
        const signals = [];
        for (const file of files) {
            const raw = readFileSync(join(dir, file), 'utf-8');
            const data = JSON.parse(raw);
            if (data.signals) {
                for (const s of data.signals) {
                    signals.push({
                        keyword: s.keyword,
                        score: s.score ?? 0,
                        occurrenceCount: s.occurrenceCount ?? 0,
                        recentObservationIds: s.recentObservationIds ?? [],
                        source: s.source ?? 'unknown',
                    });
                }
            }
        }
        signals.sort((a, b) => b.score - a.score);
        return signals;
    }
    buildObsMap(days) {
        const map = new Map();
        const dir = join(this.observerDir, 'observations');
        if (!existsSync(dir))
            return map;
        const files = readdirSync(dir)
            .filter((f) => f.endsWith('.json'))
            .sort()
            .reverse()
            .slice(0, days);
        for (const file of files) {
            const raw = readFileSync(join(dir, file), 'utf-8');
            const data = JSON.parse(raw);
            if (data.observations) {
                for (const obs of data.observations) {
                    if (obs.id && obs.content) {
                        if (!map.has(obs.id)) {
                            map.set(obs.id, { id: obs.id, content: obs.content, source: obs.source });
                        }
                    }
                }
            }
        }
        return map;
    }
}
