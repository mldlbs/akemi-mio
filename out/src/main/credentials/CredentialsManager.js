import { safeStorage } from 'electron';
import { log } from '../logger/Logger';
import { getRawDb, markDirty } from '../db/connection';
function isEncrypted(value) {
    return value.startsWith('enc:');
}
function encrypt(plaintext) {
    if (safeStorage.isEncryptionAvailable()) {
        const buf = safeStorage.encryptString(plaintext);
        return 'enc:' + buf.toString('base64');
    }
    return 'b64:' + Buffer.from(plaintext).toString('base64');
}
function decrypt(value) {
    if (value.startsWith('enc:')) {
        try {
            const buf = Buffer.from(value.slice(4), 'base64');
            return safeStorage.decryptString(buf);
        }
        catch {
            log('WARN', 'secrets_decrypt_failed');
            return value;
        }
    }
    if (value.startsWith('b64:')) {
        return Buffer.from(value.slice(4), 'base64').toString('utf-8');
    }
    return value;
}
export class CredentialsManager {
    /** 验证凭据名称的合法性 */
    validateKey(name, allowMissing) {
        if (!name || typeof name !== 'string') {
            log('WARN', 'credential_invalid_key', { name: String(name) });
            return null;
        }
        if (name.length > 128) {
            log('WARN', 'credential_key_too_long', { length: name.length });
            if (!allowMissing)
                throw new Error('凭据名称过长（最大 128 字符）');
            return null;
        }
        return name;
    }
    get(name) {
        if (!this.validateKey(name, true))
            return null;
        const db = getRawDb();
        const stmt = db.prepare('SELECT value FROM credentials WHERE key = ?');
        stmt.bind([name]);
        let value = null;
        if (stmt.step()) {
            value = stmt.get()[0];
        }
        stmt.free();
        log('INFO', 'credential_get', { name });
        return value ? decrypt(value) : null;
    }
    set(name, value) {
        if (!this.validateKey(name))
            throw new Error('无效的凭据名称');
        const db = getRawDb();
        const encrypted = encrypt(value);
        db.run('INSERT OR REPLACE INTO credentials (key, value) VALUES (?, ?)', [name, encrypted]);
        markDirty();
        log('INFO', 'credential_set', { name });
    }
    delete(name) {
        if (!this.validateKey(name, true))
            return false;
        const db = getRawDb();
        db.run('DELETE FROM credentials WHERE key = ?', [name]);
        markDirty();
        log('INFO', 'credential_deleted', { name });
        return true;
    }
    list() {
        const db = getRawDb();
        const stmt = db.prepare('SELECT key FROM credentials ORDER BY key');
        stmt.bind([]);
        const keys = [];
        while (stmt.step()) {
            keys.push(String(stmt.get()[0]));
        }
        stmt.free();
        return keys;
    }
    has(name) {
        if (!this.validateKey(name, true))
            return false;
        const db = getRawDb();
        const stmt = db.prepare('SELECT 1 FROM credentials WHERE key = ? LIMIT 1');
        stmt.bind([name]);
        const exists = stmt.step();
        stmt.free();
        return exists;
    }
    migrate() {
        try {
            const { existsSync, readFileSync, unlinkSync } = require('fs');
            const { join } = require('path');
            const { app } = require('electron');
            const secretsPath = join(app.getPath('userData'), 'secrets.json');
            if (existsSync(secretsPath)) {
                const raw = readFileSync(secretsPath, 'utf-8');
                const store = JSON.parse(raw);
                const db = getRawDb();
                for (const [key, value] of Object.entries(store)) {
                    db.run('INSERT OR IGNORE INTO credentials (key, value) VALUES (?, ?)', [key, value]);
                }
                markDirty();
                unlinkSync(secretsPath);
                log('INFO', 'credential_migration_completed', { count: Object.keys(store).length });
            }
        }
        catch (err) {
            log('WARN', 'credential_migration_skipped', { error: String(err) });
        }
    }
}
export const credentialsManager = new CredentialsManager();
