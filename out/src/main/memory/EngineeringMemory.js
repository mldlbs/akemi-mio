import { getRawDb } from '../db/connection';
let idCounter = 0;
const MAX_ENTRIES = 100;
export class EngineeringMemory {
    store(entry) {
        const db = getRawDb();
        const id = `eng_${Date.now()}_${++idCounter}`;
        const now = Date.now();
        db.run(`INSERT INTO engineering_memory (id, type, content, source, confidence, related_files, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            id,
            entry.type,
            entry.content,
            entry.source,
            entry.confidence,
            JSON.stringify(entry.relatedFiles),
            JSON.stringify(entry.tags),
            now,
            now,
        ]);
        this.prune();
    }
    query(params = {}) {
        const db = getRawDb();
        const conditions = [];
        const values = [];
        if (params.types?.length) {
            conditions.push(`type IN (${params.types.map(() => '?').join(',')})`);
            values.push(...params.types);
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const limit = params.topK || 10;
        const stmt = db.prepare(`SELECT * FROM engineering_memory ${where} ORDER BY confidence DESC, created_at DESC LIMIT ${limit}`);
        stmt.bind(values);
        const results = [];
        while (stmt.step()) {
            const r = stmt.getAsObject();
            results.push({
                id: r.id,
                type: r.type,
                content: r.content,
                source: r.source,
                confidence: r.confidence,
                relatedFiles: JSON.parse(r.related_files || '[]'),
                tags: JSON.parse(r.tags || '[]'),
                createdAt: r.created_at,
                updatedAt: r.updated_at,
            });
        }
        stmt.free();
        return results;
    }
    search(text, topK = 5) {
        const db = getRawDb();
        const like = `%${text}%`;
        const stmt = db.prepare(`SELECT * FROM engineering_memory WHERE content LIKE ? OR source LIKE ? OR tags LIKE ? ORDER BY confidence DESC LIMIT ${topK}`);
        stmt.bind([like, like, like]);
        const results = [];
        while (stmt.step()) {
            const r = stmt.getAsObject();
            results.push({
                id: r.id,
                type: r.type,
                content: r.content,
                source: r.source,
                confidence: r.confidence,
                relatedFiles: JSON.parse(r.related_files || '[]'),
                tags: JSON.parse(r.tags || '[]'),
                createdAt: r.created_at,
                updatedAt: r.updated_at,
            });
        }
        stmt.free();
        return results;
    }
    getFormattedContext(topK = 5) {
        const entries = this.query({ topK });
        if (entries.length === 0)
            return '';
        const parts = ['---', '【工程知识】'];
        for (const e of entries) {
            parts.push(`[${e.type}] ${e.content.slice(0, 150)}`);
            if (e.relatedFiles.length > 0)
                parts.push(`  文件: ${e.relatedFiles.join(', ')}`);
        }
        parts.push('---');
        return parts.join('\n');
    }
    getRelatedFiles(filePath) {
        const entries = this.search(filePath, 3);
        const files = new Set();
        for (const e of entries) {
            for (const f of e.relatedFiles)
                files.add(f);
        }
        return Array.from(files);
    }
    prune() {
        try {
            const db = getRawDb();
            const count = Number(db.exec('SELECT COUNT(*) AS c FROM engineering_memory')[0]?.values[0]?.[0] || 0);
            if (count > MAX_ENTRIES) {
                db.run(`DELETE FROM engineering_memory WHERE id IN (SELECT id FROM engineering_memory ORDER BY confidence ASC, created_at ASC LIMIT ?)`, [count - MAX_ENTRIES]);
            }
        }
        catch {
            /* ignore */
        }
    }
}
