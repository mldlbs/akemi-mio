import initSqlJs from 'sql.js';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { join } from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { log } from '../logger/Logger';
import { WORKSPACE_ROOT } from '../config';
import * as schema from './schema';
import { runMigrations } from './migration';
import { classifyContent } from '../agent/ContentClassifier';
let db = null;
let sqlite = null;
let dbPath = '';
let saveTimer = null;
let dirty = false;
let initializing = false;
async function proxyCallback(sql, params, method) {
    if (!sqlite)
        throw new Error('Database not initialized');
    const convertedSql = sql.replace(/\$\d+/g, '?');
    try {
        if (method === 'run') {
            sqlite.run(convertedSql, params);
            return { rows: [] };
        }
        const stmt = sqlite.prepare(convertedSql);
        stmt.bind(params);
        if (method === 'get') {
            const row = stmt.step() ? stmt.getAsObject() : null;
            stmt.free();
            return { rows: row ? [row] : [] };
        }
        if (method === 'values') {
            const rows = [];
            while (stmt.step()) {
                rows.push(stmt.get());
            }
            stmt.free();
            return { rows };
        }
        const rows = [];
        while (stmt.step()) {
            rows.push(stmt.getAsObject());
        }
        stmt.free();
        return { rows };
    }
    catch (err) {
        log('ERROR', 'db_query_error', { sql: convertedSql.slice(0, 100), error: String(err) });
        throw err;
    }
}
export async function initDatabase() {
    if (db)
        return;
    if (initializing) {
        // Wait until the concurrent initialization finishes
        while (initializing) {
            await new Promise((r) => setTimeout(r, 50));
        }
        return;
    }
    initializing = true;
    dbPath = join(WORKSPACE_ROOT, 'akemi-mio.db');
    log('INFO', 'db_init', { path: dbPath });
    const SQL = await initSqlJs();
    if (existsSync(dbPath)) {
        const buffer = readFileSync(dbPath);
        sqlite = new SQL.Database(buffer);
    }
    else {
        sqlite = new SQL.Database();
    }
    sqlite.run('PRAGMA journal_mode = WAL');
    sqlite.run('PRAGMA foreign_keys = ON');
    db = drizzle(proxyCallback, { schema });
    runMigrations(sqlite);
    // 回填已有消息的 category（迁移 v25 引入 category 列后，旧消息仍为 'chat'）
    try {
        const rows = sqlite.exec(`SELECT id, content, session_id FROM messages WHERE role = 'user' AND category = 'chat' ORDER BY created_at ASC`);
        if (rows.length && rows[0].values.length) {
            const cols = rows[0].columns;
            const idIdx = cols.indexOf('id');
            const contentIdx = cols.indexOf('content');
            const sessionIdx = cols.indexOf('session_id');
            const stmt1 = sqlite.prepare('UPDATE messages SET category = ? WHERE id = ?');
            const stmt2 = sqlite.prepare('UPDATE messages SET category = ? WHERE session_id = ? AND role = ? AND category = ?');
            for (const row of rows[0].values) {
                const content = String(row[contentIdx] || '');
                const cat = classifyContent(content);
                if (cat !== 'chat') {
                    const id = String(row[idIdx]);
                    stmt1.bind([cat, id]);
                    stmt1.step();
                    stmt1.reset();
                    const sessionId = row[sessionIdx];
                    if (sessionId) {
                        stmt2.bind([cat, sessionId, 'assistant', 'chat']);
                        stmt2.step();
                        stmt2.reset();
                    }
                }
            }
            stmt1.free();
            stmt2.free();
            markDirty();
        }
    }
    catch (err) {
        log('ERROR', 'db_backfill_categories_failed', { error: String(err) });
    }
    saveTimer = setInterval(() => {
        if (dirty && sqlite) {
            const data = sqlite.export();
            writeFileSync(dbPath, Buffer.from(data));
            dirty = false;
        }
    }, 10000);
    log('INFO', 'db_ready');
    initializing = false;
}
export function getDatabase() {
    if (!db)
        throw new Error('Database not initialized. Call initDatabase() first.');
    return db;
}
export function markDirty() {
    dirty = true;
}
export function flushDatabase() {
    if (!sqlite || !dbPath)
        return;
    const data = sqlite.export();
    writeFileSync(dbPath, Buffer.from(data));
    dirty = false;
    log('INFO', 'db_flushed', { size: data.length });
}
export function closeDatabase() {
    if (saveTimer) {
        clearInterval(saveTimer);
        saveTimer = null;
    }
    if (sqlite) {
        flushDatabase();
        try {
            sqlite.close();
        }
        catch { }
        sqlite = null;
        db = null;
    }
}
export function getRawDb() {
    if (!sqlite)
        throw new Error('Database not initialized');
    return sqlite;
}
