/**
 * Verification Worker — 在 worker_thread 中执行编译/测试/lint 验证
 *
 * 从主进程接收 { config, changedFiles }，返回结构化检查结果。
 * execSync 在 worker 中不会阻塞主线程事件循环。
 */
import './base-worker';
