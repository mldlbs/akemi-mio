import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { CompatDatabase } from '@akemi-mio/core/db/connection'

function memDb(): CompatDatabase {
  return new CompatDatabase(new Database(':memory:'))
}

/**
 * 这些用例锁住的是一条曾经静默失效的数据通路：
 * CompatStatement 构造时无条件 `stmt.columns()`，而 better-sqlite3 对
 * UPDATE/INSERT 调 columns() 必然抛 —— 于是所有写语句的 prepare 都失败。
 *
 * 空库里 migrateLegacyEvents / 分类回填整段被跳过，所以 dev 与测试从没触发，
 * 只有真实用户库（有历史数据）才会暴露。别再让它退化。
 */
describe('compat 层：写语句的 prepare 必须可用', () => {
  it('prepare(UPDATE) 不抛，且真的改到数据', () => {
    const db = memDb()
    db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)')
    db.run("INSERT INTO t (a) VALUES ('x')")

    const stmt = db.prepare('UPDATE t SET a = ? WHERE id = ?')
    stmt.bind(['y', 1])
    stmt.step()
    stmt.free()

    const rows = db.exec('SELECT a FROM t WHERE id = 1')
    expect(rows[0].values[0][0]).toBe('y')
  })

  it('prepare(INSERT OR IGNORE) 不抛（遗留事件迁移走这条）', () => {
    const db = memDb()
    db.run('CREATE TABLE events (id INTEGER PRIMARY KEY, channel TEXT)')

    const stmt = db.prepare('INSERT OR IGNORE INTO events (id, channel) VALUES (?, ?)')
    stmt.bind([1, 'c1'])
    stmt.step()
    stmt.reset()
    stmt.bind([1, 'c2']) // 同名主键，IGNORE 掉
    stmt.step()
    stmt.free()

    const rows = db.exec('SELECT COUNT(*) FROM events')
    expect(rows[0].values[0][0]).toBe(1)
  })

  it('reset 后再 step 不会把同一条写语句执行两遍', () => {
    const db = memDb()
    db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)')

    const stmt = db.prepare('INSERT INTO t (a) VALUES (?)')
    stmt.bind(['p'])
    stmt.step()
    stmt.reset()
    stmt.step() // 没有重新 bind：这只是"没有更多行了"，不该再插一条
    stmt.free()

    expect(db.exec('SELECT COUNT(*) FROM t')[0].values[0][0]).toBe(1)
  })

  it('读语句仍然拿得到列名（不能为了修写语句把读能力弄丢）', () => {
    const db = memDb()
    db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)')
    db.run("INSERT INTO t (a) VALUES ('x')")

    const rows = db.exec('SELECT id, a FROM t')
    expect(rows[0].columns).toEqual(['id', 'a'])
    expect(rows[0].values).toEqual([[1, 'x']])
  })
})
