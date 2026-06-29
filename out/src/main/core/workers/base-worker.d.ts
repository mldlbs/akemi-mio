/**
 * Worker 线程封装 — 用于 Evolution、Insight、Creativity 等后台服务。
 *
 * 在主进程中，使用 WorkerPool 来创建和管理这些 Worker。
 * 每个 Worker 通过 postMessage/on('message') 与主进程通信。
 *
 * 此文件定义了 Worker 的通用启动脚本。
 * 具体的 Worker 实现在对应的模块目录下（evolution/worker.ts 等）。
 */
export {};
