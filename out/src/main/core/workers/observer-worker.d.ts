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
export {};
