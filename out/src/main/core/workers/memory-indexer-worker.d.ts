/**
 * MemoryIndexer Worker — 在 worker_thread 中执行纯 CPU 匹配工作
 *
 * 从主进程接收 { entries, lastIndexed }，返回匹配结果。
 * 不调用 DB/KnowledgeGraph/EngineeringMemory — 主线程负责持久化。
 */
import './base-worker';
