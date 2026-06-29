/**
 * DecisionStore — P1 决策记录
 *
 * 在每次交互后记录关键决策（工具选择、策略路由、计划调整、恢复），
 * 供 Evolution 和 FailureAnalyzer 查询。
 *
 * ReflectLoop 写入（不再写入 EngineeringMemory 的 failure_pattern）。
 */
import { log } from '../logger/Logger';
import { getRawDb } from '../db/connection';
let idCounter = 0;
const MAX_RECORDS = 200;
export class DecisionStore {
    /** 写入一条决策记录 */
    record(input) {
        const db = getRawDb();
        const id = `dec_${Date.now()}_${++idCounter}`;
        const now = Date.now();
        db.run(`INSERT INTO decisions (id, timestamp, agent_id, category, context, choice, alternatives, outcome, confidence, related_plan_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            id,
            now,
            input.agentId,
            input.category,
            input.context.slice(0, 500),
            input.choice,
            JSON.stringify(input.alternatives || []),
            input.outcome || 'pending',
            input.confidence ?? 0.5,
            input.relatedPlanId || null,
            now,
        ]);
        log('INFO', 'decision_recorded', { id, category: input.category, choice: input.choice.slice(0, 40) });
        this.prune();
        return id;
    }
    /** 更新决策结果 */
    updateOutcome(id, outcome) {
        const db = getRawDb();
        db.run('UPDATE decisions SET outcome = ? WHERE id = ?', [outcome, id]);
    }
    /** 查询决策记录 */
    query(q = {}) {
        const db = getRawDb();
        const conditions = [];
        const params = [];
        if (q.categories?.length) {
            conditions.push(`category IN (${q.categories.map(() => '?').join(',')})`);
            params.push(...q.categories);
        }
        if (q.agentId) {
            conditions.push('agent_id = ?');
            params.push(q.agentId);
        }
        if (q.since !== undefined) {
            conditions.push('timestamp >= ?');
            params.push(q.since);
        }
        if (q.until !== undefined) {
            conditions.push('timestamp <= ?');
            params.push(q.until);
        }
        if (q.outcome) {
            conditions.push('outcome = ?');
            params.push(q.outcome);
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const limit = q.limit || 20;
        const stmt = db.prepare(`SELECT * FROM decisions ${where} ORDER BY timestamp DESC LIMIT ${limit}`);
        stmt.bind(params);
        const results = [];
        while (stmt.step()) {
            const r = stmt.getAsObject();
            results.push({
                id: r.id,
                timestamp: r.timestamp,
                agentId: r.agent_id,
                category: r.category,
                context: r.context,
                choice: r.choice,
                alternatives: JSON.parse(r.alternatives || '[]'),
                outcome: r.outcome,
                confidence: r.confidence,
                relatedPlanId: r.related_plan_id || undefined,
                createdAt: r.created_at,
            });
        }
        stmt.free();
        return results;
    }
    /** 获取格式化上下文（供 Evolution 和 FailureAnalyzer 使用） */
    getFormattedContext(category, limit = 5) {
        const q = { limit };
        if (category)
            q.categories = [category];
        const records = this.query(q);
        if (records.length === 0)
            return '';
        const parts = ['---', '【近期决策记录】'];
        for (const r of records) {
            parts.push(`[${r.category}] ${r.choice.slice(0, 60)} (${r.outcome}, ${r.confidence.toFixed(2)})`);
        }
        parts.push('---');
        return parts.join('\n');
    }
    prune() {
        try {
            const db = getRawDb();
            const count = Number(db.exec('SELECT COUNT(*) AS c FROM decisions')[0]?.values[0]?.[0] || 0);
            if (count > MAX_RECORDS) {
                db.run(`DELETE FROM decisions WHERE id IN (SELECT id FROM decisions ORDER BY timestamp ASC LIMIT ?)`, [count - MAX_RECORDS]);
            }
        }
        catch {
            /* ignore */
        }
    }
    // ══════════════════════════════════════════
    //  决策分析
    // ══════════════════════════════════════════
    /** 查询近期失败决策，按 category 分组提取公共模式 */
    getFailurePatterns(options) {
        const since = options?.since ?? Date.now() - 7 * 24 * 3600000;
        const minCount = options?.minCount ?? 2;
        const failures = this.query({ outcome: 'failure', since });
        if (failures.length === 0)
            return [];
        const byCategory = new Map();
        for (const f of failures) {
            const list = byCategory.get(f.category) || [];
            list.push(f);
            byCategory.set(f.category, list);
        }
        const groups = [];
        for (const [category, records] of byCategory) {
            if (records.length < minCount)
                continue;
            const contextWords = records.map((r) => r.context.slice(0, 100));
            const common = this.findCommonContext(contextWords);
            const sampleChoices = [...new Set(records.map((r) => r.choice).filter(Boolean))].slice(0, 5);
            const lastSeen = Math.max(...records.map((r) => r.timestamp));
            groups.push({
                pattern: `${category} failures in ${common || 'general'}`,
                count: records.length,
                commonContext: common,
                sampleChoices,
                lastSeen,
            });
        }
        groups.sort((a, b) => b.count - a.count);
        return groups;
    }
    /** 聚合最近 N 天决策摘要 */
    getCrossSessionSummary(days = 7) {
        const since = Date.now() - days * 24 * 3600000;
        const records = this.query({ since });
        if (records.length === 0)
            return '';
        const byCategory = new Map();
        for (const r of records) {
            if (!byCategory.has(r.category))
                byCategory.set(r.category, { total: 0, success: 0, failure: 0 });
            const s = byCategory.get(r.category);
            s.total++;
            if (r.outcome === 'success')
                s.success++;
            else if (r.outcome === 'failure')
                s.failure++;
        }
        const parts = [`【跨会话决策总览 (${days}天)】`];
        for (const [cat, stats] of byCategory) {
            parts.push(`- ${cat}: ${stats.total} 次 (成功 ${stats.success}, 失败 ${stats.failure})`);
        }
        const failures = records.filter((r) => r.outcome === 'failure');
        if (failures.length > 0) {
            const catCount = new Map();
            for (const f of failures)
                catCount.set(f.category, (catCount.get(f.category) || 0) + 1);
            const worst = [...catCount.entries()].sort((a, b) => b[1] - a[1])[0];
            parts.push(`最频繁失败模式: ${worst[0]} (${worst[1]} 次)`);
        }
        return parts.join('\n');
    }
    findCommonContext(contexts) {
        if (contexts.length === 0)
            return '';
        if (contexts.length === 1)
            return contexts[0].slice(0, 40);
        const words = contexts.map((c) => c
            .split(/[\s,，。]+/)
            .filter((w) => w.length > 2)
            .slice(0, 10));
        const freq = new Map();
        for (const wlist of words) {
            for (const w of [...new Set(wlist)]) {
                freq.set(w, (freq.get(w) || 0) + 1);
            }
        }
        const common = [...freq.entries()]
            .filter(([, count]) => count >= Math.max(2, Math.floor(contexts.length / 2)))
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([w]) => w);
        return common.join(', ');
    }
}
