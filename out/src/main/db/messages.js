import { getRawDb, markDirty } from './connection';
import { log } from '../logger/Logger';
export function createMessageId() {
    return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
function createSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}
export function insertMessage(msg) {
    try {
        const db = getRawDb();
        db.run(`INSERT INTO messages (id, source, role, content, category, session_id, telegram_chat_id, telegram_user_id, telegram_from, telegram_message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            msg.id,
            msg.source,
            msg.role,
            msg.content,
            msg.category,
            msg.sessionId ?? null,
            msg.telegramChatId ?? null,
            msg.telegramUserId ?? null,
            msg.telegramFrom ?? null,
            msg.telegramMessageId ?? null,
            msg.createdAt,
        ]);
        markDirty();
    }
    catch (err) {
        log('ERROR', 'db_insert_message_failed', { error: String(err) });
    }
}
export function getRecentMessages(limit = 100) {
    try {
        const db = getRawDb();
        const rows = db.exec(`SELECT id, source, role, content, category, session_id, telegram_chat_id, telegram_user_id, telegram_from, telegram_message_id, created_at
       FROM messages ORDER BY created_at ASC LIMIT ?`, [limit]);
        if (!rows.length || !rows[0].values.length)
            return [];
        const cols = rows[0].columns;
        return rows[0].values.map((row) => {
            const obj = {};
            for (let i = 0; i < cols.length; i++)
                obj[cols[i]] = row[i];
            return rowToMessage(obj);
        });
    }
    catch (err) {
        log('ERROR', 'db_get_messages_failed', { error: String(err) });
        return [];
    }
}
export function getSessions() {
    try {
        const db = getRawDb();
        const rows = db.exec(`SELECT session_id,
              (SELECT content FROM messages AS sub WHERE sub.session_id = m.session_id AND sub.role = 'user' ORDER BY sub.created_at ASC LIMIT 1) AS label,
              (SELECT source FROM messages AS sub2 WHERE sub2.session_id = m.session_id ORDER BY sub2.created_at ASC LIMIT 1) AS source,
              (SELECT category FROM messages AS sub3 WHERE sub3.session_id = m.session_id ORDER BY sub3.created_at ASC LIMIT 1) AS category,
              COUNT(*) AS message_count,
              MAX(created_at) AS last_activity_at,
              MIN(created_at) AS created_at
       FROM messages m
       WHERE session_id IS NOT NULL
       GROUP BY session_id
       ORDER BY last_activity_at DESC`);
        if (!rows.length || !rows[0].values.length)
            return [];
        const cols = rows[0].columns;
        return rows[0].values.map((row) => {
            const obj = {};
            for (let i = 0; i < cols.length; i++)
                obj[cols[i]] = row[i];
            return {
                id: obj.session_id,
                source: obj.source === 'telegram' ? 'telegram' : 'electron',
                category: obj.category || 'chat',
                label: obj.label?.slice(0, 40) || '新对话',
                messageCount: obj.message_count,
                lastActivityAt: obj.last_activity_at,
                createdAt: obj.created_at,
            };
        });
    }
    catch (err) {
        log('ERROR', 'db_get_sessions_failed', { error: String(err) });
        return [];
    }
}
export function getMessagesBySession(sessionId) {
    try {
        const db = getRawDb();
        const rows = db.exec(`SELECT id, source, role, content, category, session_id, telegram_chat_id, telegram_user_id, telegram_from, telegram_message_id, created_at
       FROM messages WHERE session_id = ? ORDER BY created_at ASC`, [sessionId]);
        if (!rows.length || !rows[0].values.length)
            return [];
        const cols = rows[0].columns;
        return rows[0].values.map((row) => {
            const obj = {};
            for (let i = 0; i < cols.length; i++)
                obj[cols[i]] = row[i];
            return rowToMessage(obj);
        });
    }
    catch (err) {
        log('ERROR', 'db_get_messages_by_session_failed', { error: String(err), sessionId });
        return [];
    }
}
/** 获取最后一条消息的 session_id（用于自动分组） */
export function getLastSessionId() {
    try {
        const db = getRawDb();
        const rows = db.exec(`SELECT session_id FROM messages ORDER BY created_at DESC LIMIT 1`);
        if (!rows.length || !rows[0].values.length)
            return null;
        return rows[0].values[0][0];
    }
    catch {
        return null;
    }
}
/** 获取最后一条消息的时间戳 */
export function getLastMessageTime() {
    try {
        const db = getRawDb();
        const rows = db.exec(`SELECT created_at FROM messages ORDER BY created_at DESC LIMIT 1`);
        if (!rows.length || !rows[0].values.length)
            return null;
        return rows[0].values[0][0];
    }
    catch {
        return null;
    }
}
export { createSessionId };
function rowToMessage(row) {
    return {
        id: row.id,
        source: row.source,
        role: row.role,
        content: row.content,
        category: row.category || 'chat',
        sessionId: row.session_id ?? undefined,
        telegramChatId: row.telegram_chat_id,
        telegramUserId: row.telegram_user_id,
        telegramFrom: row.telegram_from,
        telegramMessageId: row.telegram_message_id,
        createdAt: row.created_at,
    };
}
