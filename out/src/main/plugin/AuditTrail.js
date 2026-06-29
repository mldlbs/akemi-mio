import { getRawDb } from '../db/connection';
let idCounter = 0;
const MAX_ENTRIES = 10000;
export class AuditTrail {
    record(entry) {
        const db = getRawDb();
        const id = `audit_${Date.now()}_${++idCounter}`;
        const now = Date.now();
        try {
            db.run(`INSERT INTO audit_trail (id, timestamp, source, action, target, plugin_name, tool_name, details, allowed, duration, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                id,
                now,
                entry.source,
                entry.action,
                entry.target,
                entry.pluginName || null,
                entry.toolName || null,
                JSON.stringify(entry.details),
                entry.allowed ? 1 : 0,
                entry.duration || null,
                entry.reason || null,
            ]);
        }
        catch {
            /* ignore */
        }
        this.prune();
    }
    query(filter = {}) {
        const db = getRawDb();
        const conditions = [];
        const values = [];
        if (filter.source) {
            conditions.push('source = ?');
            values.push(filter.source);
        }
        if (filter.action) {
            conditions.push('action = ?');
            values.push(filter.action);
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const limit = filter.limit || 50;
        const stmt = db.prepare(`SELECT * FROM audit_trail ${where} ORDER BY timestamp DESC LIMIT ${limit}`);
        stmt.bind(values);
        const results = [];
        while (stmt.step()) {
            const r = stmt.getAsObject();
            results.push({
                id: r.id,
                timestamp: r.timestamp,
                source: r.source,
                action: r.action,
                target: r.target,
                pluginName: r.plugin_name || undefined,
                toolName: r.tool_name || undefined,
                details: JSON.parse(r.details || '{}'),
                allowed: !!r.allowed,
                duration: r.duration || undefined,
                reason: r.reason || undefined,
            });
        }
        stmt.free();
        return results;
    }
    getRecent(limit = 20) {
        return this.query({ limit });
    }
    getBySource(source, limit = 20) {
        return this.query({ source, limit });
    }
    getStats() {
        const db = getRawDb();
        const total = Number(db.exec('SELECT COUNT(*) AS c FROM audit_trail')[0]?.values[0]?.[0] || 0);
        const bySource = {};
        const byAction = {};
        try {
            const srcRows = db.exec('SELECT source, COUNT(*) AS c FROM audit_trail GROUP BY source');
            if (srcRows[0])
                for (const row of srcRows[0].values)
                    bySource[String(row[0])] = Number(row[1]);
            const actRows = db.exec('SELECT action, COUNT(*) AS c FROM audit_trail GROUP BY action');
            if (actRows[0])
                for (const row of actRows[0].values)
                    byAction[String(row[0])] = Number(row[1]);
        }
        catch {
            /* ignore */
        }
        return { total, bySource, byAction };
    }
    prune() {
        try {
            const db = getRawDb();
            const count = Number(db.exec('SELECT COUNT(*) AS c FROM audit_trail')[0]?.values[0]?.[0] || 0);
            if (count > MAX_ENTRIES) {
                db.run(`DELETE FROM audit_trail WHERE id IN (SELECT id FROM audit_trail ORDER BY timestamp ASC LIMIT ?)`, [count - MAX_ENTRIES]);
            }
        }
        catch {
            /* ignore */
        }
    }
}
