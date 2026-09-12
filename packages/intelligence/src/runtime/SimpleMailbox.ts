import type { RuntimeCommand } from './RuntimeMessage'
import type { Mailbox } from './WorkerContract'

/**
 * SimpleMailbox — FIFO 队列实现的 Mailbox。
 * 无界队列，v1 不做上限。
 */
export class SimpleMailbox implements Mailbox {
  private queue: RuntimeCommand[] = []

  push(command: RuntimeCommand): void {
    this.queue.push(command)
  }

  drain(): RuntimeCommand[] {
    const batch = this.queue.splice(0)
    return batch
  }

  hasPending(): boolean {
    return this.queue.length > 0
  }

  get size(): number {
    return this.queue.length
  }

  clear(): void {
    this.queue = []
  }
}
