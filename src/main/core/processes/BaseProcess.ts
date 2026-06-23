/**
 * BaseProcess — Agent OS 子进程基类入口。
 *
 * 所有通过 ProcessManager.fork() 启动的子进程使用此入口。
 * 提供标准 IPC 协议：request/response、ping/pong、lifecycle 事件、shutdown。
 */

interface BaseRequestMessage {
  type: 'request'
  requestId: string
  method: string
  data: unknown
}

interface PingMessage {
  type: 'ping'
  id: number
}

interface ShutdownMessage {
  type: 'shutdown'
}

type ParentMessage = BaseRequestMessage | PingMessage | ShutdownMessage

export type ProcessHandler = (method: string, data: unknown) => Promise<unknown> | unknown

let _handler: ProcessHandler | null = null
let _shuttingDown = false

export function setProcessHandler(handler: ProcessHandler): void {
  _handler = handler
}

function send(msg: Record<string, unknown>): void {
  if (process.send) process.send(msg)
}

/** 报告内存使用（供 processManager 做预算检查） */
function reportMemory(): void {
  const usage = process.memoryUsage()
  send({ type: 'memory_usage', heapMb: Math.round((usage.heapUsed / 1024 / 1024) * 10) / 10 })
}

/** 标记进程已就绪 */
export function markReady(): void {
  send({ type: 'lifecycle', event: 'started' })
}

// 每 30s 报告内存
const memTimer = setInterval(reportMemory, 30_000)
memTimer.unref?.()

process.on('message', async (msg: ParentMessage) => {
  if (msg.type === 'ping') {
    send({ type: 'pong', id: msg.id })
    return
  }

  if (msg.type === 'shutdown') {
    _shuttingDown = true
    clearInterval(memTimer)
    send({ type: 'shutdown_ack' })
    process.exit(0)
  }

  if (msg.type === 'request') {
    if (!_handler) {
      send({ type: 'result', requestId: msg.requestId, success: false, error: 'No handler registered' })
      return
    }

    try {
      const result = await _handler(msg.method, msg.data)
      send({ type: 'result', requestId: msg.requestId, success: true, data: result })
    } catch (err: any) {
      send({ type: 'result', requestId: msg.requestId, success: false, error: err.message })
    }
  }
})

process.on('uncaughtException', (err) => {
  send({ type: 'lifecycle', event: 'error', error: err.message })
  if (!_shuttingDown) process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason)
  send({ type: 'lifecycle', event: 'error', error: `UnhandledRejection: ${msg}` })
})
