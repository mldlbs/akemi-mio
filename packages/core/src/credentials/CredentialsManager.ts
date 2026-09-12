import { safeStorage } from 'electron'
import { log } from '@akemi-mio/core/logger/Logger'
import { getRawDb, markDirty } from '@akemi-mio/core/db/connection'
import { migrateSocialCredsFile } from './socialCredsMigration'

function isEncrypted(value: string): boolean {
  return value.startsWith('enc:')
}

function encrypt(plaintext: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    const buf = safeStorage.encryptString(plaintext)
    return 'enc:' + buf.toString('base64')
  }
  return 'b64:' + Buffer.from(plaintext).toString('base64')
}

function decrypt(value: string): string {
  if (value.startsWith('enc:')) {
    try {
      const buf = Buffer.from(value.slice(4), 'base64')
      return safeStorage.decryptString(buf)
    } catch {
      log('WARN', 'secrets_decrypt_failed')
      return value
    }
  }
  if (value.startsWith('b64:')) {
    return Buffer.from(value.slice(4), 'base64').toString('utf-8')
  }
  return value
}

export class CredentialsManager {
  /** 验证凭据名称的合法性 */
  private validateKey(name: string, allowMissing?: boolean): string | null {
    if (!name || typeof name !== 'string') {
      log('WARN', 'credential_invalid_key', { name: String(name) })
      return null
    }
    if (name.length > 128) {
      log('WARN', 'credential_key_too_long', { length: name.length })
      if (!allowMissing) throw new Error('凭据名称过长（最大 128 字符）')
      return null
    }
    return name
  }

  get(name: string): string | null {
    if (!this.validateKey(name, true)) return null
    const db = getRawDb()
    const stmt = db.prepare('SELECT value FROM credentials WHERE key = ?')
    stmt.bind([name])
    let value: string | null = null
    if (stmt.step()) {
      value = stmt.get()[0] as string
    }
    stmt.free()
    return value ? decrypt(value) : null
  }

  set(name: string, value: string): void {
    if (!this.validateKey(name)) throw new Error('无效的凭据名称')
    const db = getRawDb()
    const encrypted = encrypt(value)
    db.run('INSERT OR REPLACE INTO credentials (key, value) VALUES (?, ?)', [name, encrypted])
    markDirty()
    log('INFO', 'credential_set', { name })
  }

  delete(name: string): boolean {
    if (!this.validateKey(name, true)) return false
    const db = getRawDb()
    db.run('DELETE FROM credentials WHERE key = ?', [name])
    markDirty()
    log('INFO', 'credential_deleted', { name })
    return true
  }

  list(): string[] {
    const db = getRawDb()
    const stmt = db.prepare('SELECT key FROM credentials ORDER BY key')
    stmt.bind([])
    const keys: string[] = []
    while (stmt.step()) {
      keys.push(String(stmt.get()[0]))
    }
    stmt.free()
    return keys
  }

  /**
   * 批量获取全部凭据（一条 SQL 查完）。
   * 比先 list() 再逐条 get() 快 N 倍。
   */
  getAll(): Record<string, string> {
    const db = getRawDb()
    const stmt = db.prepare('SELECT key, value FROM credentials ORDER BY key')
    stmt.bind([])
    const entries: Record<string, string> = {}
    while (stmt.step()) {
      const [key, value] = stmt.get() as [string, string]
      entries[String(key)] = decrypt(String(value))
    }
    stmt.free()
    return entries
  }

  has(name: string): boolean {
    if (!this.validateKey(name, true)) return false
    const db = getRawDb()
    const stmt = db.prepare('SELECT 1 FROM credentials WHERE key = ? LIMIT 1')
    stmt.bind([name])
    const exists = stmt.step()
    stmt.free()
    return exists
  }

  migrate(): void {
    try {
      const { existsSync, readFileSync, unlinkSync } = require('fs') as typeof import('fs')
      const { join } = require('path') as typeof import('path')
      const { app } = require('electron') as typeof import('electron')
      const secretsPath = join(app.getPath('userData'), 'secrets.json')
      if (existsSync(secretsPath)) {
        const raw = readFileSync(secretsPath, 'utf-8')
        const store = JSON.parse(raw) as Record<string, string>
        const db = getRawDb()
        for (const [key, value] of Object.entries(store)) {
          db.run('INSERT OR IGNORE INTO credentials (key, value) VALUES (?, ?)', [key, value])
        }
        markDirty()
        unlinkSync(secretsPath)
        log('INFO', 'credential_migration_completed', { count: Object.keys(store).length })
      }
    } catch (err) {
      log('WARN', 'credential_migration_skipped', { error: String(err) })
    }
  }

  /** 社交平台旧版明文凭据迁移（设计 4.4）：.creds.json 大写键 → 小写键；全部写入成功后才删除明文文件 */
  migrateFromSocialCreds(credsPath: string): number {
    const count = migrateSocialCredsFile(credsPath, (key, value) => this.set(key, value))
    if (count > 0) log('INFO', 'social_creds_migrated', { count })
    return count
  }
}

export const credentialsManager = new CredentialsManager()
