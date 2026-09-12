/**
 * Worker 线程封装 — 用于 Evolution、Insight、Creativity 等后台服务。
 *
 * 在主进程中，使用 WorkerPool 来创建和管理这些 Worker。
 * 每个 Worker 通过 postMessage/on('message') 与主进程通信。
 *
 * 此文件定义了 Worker 的通用启动脚本。
 * 具体的 Worker 实现在对应的模块目录下（evolution/worker.ts 等）。
 */

import { parentPort, workerData } from 'worker_threads'

const workerName = workerData?.workerName || 'unknown'

// 通知主进程 Worker 已启动
parentPort?.postMessage({
  type: 'lifecycle',
  event: 'started',
  workerName,
})

// 处理来自主进程的消息
parentPort?.on('message', async (msg) => {
  if (msg.type === 'task') {
    try {
      await handleTask(msg)
    } catch (err: any) {
      parentPort?.postMessage({
        type: 'result',
        taskId: msg.taskId,
        success: false,
        data: null,
        error: err.message,
      })
    }
  } else if (msg.type === 'shutdown') {
    parentPort?.postMessage({
      type: 'lifecycle',
      event: 'stopped',
      workerName,
    })
    process.exit(0)
  }
})

async function handleTask(msg: { taskId: string; name: string; data: any }): Promise<void> {
  const { taskId, data } = msg

  // 具体的 Worker 实现会通过 import 注册到 globalThis
  const workerImpl = (globalThis as any).__workerHandler
  if (!workerImpl) {
    throw new Error(`Worker "${workerName}" has no handler registered`)
  }

  const result = await workerImpl(data)

  parentPort?.postMessage({
    type: 'result',
    taskId,
    success: true,
    data: result,
  })
}
