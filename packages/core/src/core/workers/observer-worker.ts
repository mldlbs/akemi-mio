/**
 * Observer Worker — 在 worker_thread 中执行 ObserverService
 *
 * ObserverService 无 Electron 依赖，纯 Node.js (fetch + fs + setInterval)，
 * 可在 worker 中独立运行，不阻塞主线程。
 *
 * IPC 协议（通过 WorkerPool.sendTaskAndWait）：
 * - { method: 'init', data: { baseDir } } → 初始化 ObserverService
 * - { method: 'initLlm' } → 检查 Ollama + 初始化 LLM
 * - { method: 'start' } → 启动采集器 + pipeline 定时器
 * - { method: 'stop' } → 优雅关闭
 * - { method: 'collect' } → 强制采集一轮
 * - { method: 'pipeline', data: { mode } } → 强制运行一次 pipeline
 * - { method: 'ferment' } → 强制发酵
 */

import { parentPort } from 'worker_threads'

parentPort?.postMessage({ type: 'lifecycle', event: 'started', workerName: 'observer' })

parentPort?.on('message', async (msg) => {
  if (msg.type === 'task') {
    try {
      await handleTask(msg)
    } catch (err: any) {
      parentPort?.postMessage({ type: 'result', taskId: msg.taskId, success: false, data: null, error: err.message })
    }
  } else if (msg.type === 'shutdown') {
    parentPort?.postMessage({ type: 'lifecycle', event: 'stopped', workerName: 'observer' })
    process.exit(0)
  }
})

async function handleTask(msg: { taskId: string; name?: string; method?: string; data: any }): Promise<void> {
  const { taskId, data } = msg
  const method = msg.method || msg.name || ''

  if (method === 'init') {
    const { ObserverService } = await import('@akemi-mio/intelligence-observer/ObserverService')
    const service = new ObserverService(data?.baseDir)
    ;(globalThis as any).__observerService = service
    parentPort?.postMessage({ type: 'result', taskId, success: true, data: { initialized: true } })
    return
  }

  const service = (globalThis as any).__observerService
  if (!service) throw new Error('ObserverService not initialized')

  switch (method) {
    case 'initLlm': {
      const llm = service.getLlm()
      await llm.initialize()
      parentPort?.postMessage({ type: 'result', taskId, success: true, data: { loaded: llm.isLoaded } })
      break
    }
    case 'start': {
      await service.start()
      parentPort?.postMessage({ type: 'result', taskId, success: true, data: null })
      break
    }
    case 'stop': {
      service.stop()
      parentPort?.postMessage({ type: 'result', taskId, success: true, data: null })
      break
    }
    case 'collect': {
      await service.forceCollect()
      parentPort?.postMessage({ type: 'result', taskId, success: true, data: null })
      break
    }
    case 'pipeline': {
      const result = await service.forcePipeline(data?.mode || 'analytical')
      parentPort?.postMessage({ type: 'result', taskId, success: true, data: result })
      break
    }
    case 'ferment': {
      await service.forceFerment()
      parentPort?.postMessage({ type: 'result', taskId, success: true, data: null })
      break
    }
    default:
      throw new Error(`Unknown observer task method: ${method}`)
  }
}
