import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { log } from '@akemi-mio/core/logger/Logger'

/**
 * PipelineLock — 跨进程的单实例运行锁。
 *
 * 研究管道只能有一个实例在跑：`mio observe` 守护、`mio observer serve` 与手动
 * `mio observer pipeline --run` 可以同时存在，而 ObserverService 里的
 * `pipelineRunning` 只覆盖**本进程**。没有这把锁时，两个进程会同时推进同一个
 * DAG（各自从内存里的旧 state 起跳），产生重复的 timeline 与重复的 LLM 调用。
 *
 * 语义：`O_EXCL` 建文件（NTFS 上原子），失败则读文件判断持有者是否已失效
 * —— pid 已死或超过 TTL 视为陈旧锁，抢占一次。**建锁失败（非 EEXIST）时
 * 放行**：宁可偶尔并发，也不能让管道因为文件系统抖动永远不跑。
 */
export class PipelineLock {
  private readonly file: string
  private readonly ttlMs: number
  private held = false

  constructor(file: string, ttlMs: number = 2 * 60 * 60 * 1000) {
    this.file = file
    this.ttlMs = ttlMs
  }

  acquire(): boolean {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(this.file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' })
        this.held = true
        return true
      } catch (err: any) {
        if (err && err.code !== 'EEXIST') {
          log('WARN', 'pipeline_lock_unavailable', { error: err && err.message })
          this.held = false
          return true
        }
        if (!this.ownerGone()) return false
        try {
          unlinkSync(this.file)
        } catch {}
      }
    }
    this.held = false
    return false
  }

  release(): void {
    if (!this.held) return
    this.held = false
    try {
      unlinkSync(this.file)
    } catch {}
  }

  /** 持有者是否已经不在了：pid 不存在，或锁文件超过 TTL（进程被强杀没来得及清）。 */
  private ownerGone(): boolean {
    try {
      if (!existsSync(this.file)) return true
      if (Date.now() - statSync(this.file).mtimeMs > this.ttlMs) return true
      const owner = JSON.parse(readFileSync(this.file, 'utf-8'))
      if (!owner || typeof owner.pid !== 'number') return true
      return !pidAlive(owner.pid)
    } catch {
      return true
    }
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    // EPERM 存在但不属于当前用户 —— 仍算存活；ESRCH 才是真的没了。
    return Boolean(err && err.code === 'EPERM')
  }
}
