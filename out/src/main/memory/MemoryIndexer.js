import { log } from '../logger/Logger';
// 正则模式：匹配常见的工程知识模式
const PATTERNS = [
    { type: 'architecture_pattern', regex: /(?:架构|体系|分层|模块|服务|architecture|system|layer|module|service)[：:]\s*(.+?)[。\n.!?]/ },
    { type: 'design_decision', regex: /(?:决定|选择|采用|改为|弃用|decided|chose|switched|adopted|migrated)[：:]\s*(.+?)[。\n.!?]/ },
    {
        type: 'failure_pattern',
        regex: /(?:错误|失败|异常|崩溃|超时|挂起|卡死|error|failed|exception|crash|timeout|hang)[：:]\s*(.+?)[。\n.!?]/,
    },
    { type: 'test_pattern', regex: /(?:测试|测试用例|集成测试|单元测试|test|spec|integration|unit test)[：:]\s*(.+?)[。\n.!?]/ },
    { type: 'coding_convention', regex: /(?:约定|规范|命名|风格|格式|convention|standard|naming|style|pattern)[：:]\s*(.+?)[。\n.!?]/ },
];
export class MemoryIndexer {
    constructor(intervalMinutes = 30) {
        this.memoryService = null;
        this.engineering = null;
        this.knowledgeGraph = null;
        this.timer = null;
        this.lastIndexed = 0;
        this.lastEntryCount = 0;
        this.workerPool = null;
        this.intervalMs = intervalMinutes * 60 * 1000;
    }
    setWorkerPool(wp) {
        this.workerPool = wp;
    }
    setMemoryService(ms) {
        this.memoryService = ms;
    }
    setEngineering(eng) {
        this.engineering = eng;
    }
    setKnowledgeGraph(kg) {
        this.knowledgeGraph = kg;
    }
    start() {
        if (this.timer)
            return;
        this.timer = setInterval(() => this.tick(), this.intervalMs);
        log('INFO', 'memory_indexer_started', { intervalMs: this.intervalMs });
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    async tick() {
        log('INFO', 'memory_indexer_tick', { lastIndexed: this.lastIndexed });
        if (!this.memoryService)
            return;
        const entries = this.memoryService.getEntries();
        const lastIndexed = this.lastIndexed;
        const lastCount = this.lastEntryCount;
        this.lastEntryCount = entries.length;
        this.lastIndexed = Date.now();
        // Try worker path first
        const workerAvailable = this.workerPool?.isActive('memory-indexer') && !this.workerPool.isBusy('memory-indexer');
        let result = null;
        if (workerAvailable && this.workerPool) {
            try {
                result = await this.workerPool.sendTaskAndWait('memory-indexer', 'index', { entries, lastIndexed }, 10000);
            }
            catch {
                log('WARN', 'memory_indexer_worker_failed_falling_back');
            }
        }
        // Fall back to inline execution
        if (!result) {
            result = this.runIndex(entries, lastIndexed);
        }
        // Apply results on main thread (DB calls need main-process modules)
        if (this.knowledgeGraph) {
            for (const ke of result.knowledgeEntries) {
                this.knowledgeGraph.ingest(ke.content, ke.confidence);
            }
        }
        if (this.engineering) {
            for (const ee of result.engineeringEntries) {
                this.engineering.store(ee);
            }
        }
        if (result.engineeringEntries.length > 0) {
            log('INFO', 'memory_indexer_stored', {
                knowledge: result.knowledgeEntries.length,
                engineering: result.engineeringEntries.length,
                worker: !!result,
            });
        }
    }
    /** 纯函数：对条目执行匹配逻辑（供 worker 和 inline fallback 共享） */
    runIndex(entries, lastIndexed) {
        const knowledgeEntries = [];
        const engineeringEntries = [];
        for (const entry of entries) {
            if (entry.type === 'user_fact' && entry.confidence >= 0.6) {
                knowledgeEntries.push({ content: entry.content, confidence: entry.confidence });
            }
            if (entry.updatedAt <= lastIndexed)
                continue;
            for (const p of PATTERNS) {
                const match = entry.content.match(p.regex);
                if (match) {
                    const now = Date.now();
                    engineeringEntries.push({
                        id: `idx_${now}_${engineeringEntries.length}`,
                        type: p.type,
                        content: match[1].trim(),
                        source: `memory:${entry.id || 'unknown'}`,
                        confidence: entry.confidence * 0.8,
                        relatedFiles: [],
                        tags: this.inferTags(p.type, match[1]),
                        createdAt: now,
                        updatedAt: now,
                    });
                }
            }
        }
        return { knowledgeEntries, engineeringEntries };
    }
    /** 根据类型和内容推断标签 */
    inferTags(type, content) {
        const tags = [type.replace('_', ':')];
        // 提取关键词（3+ 英文单词）
        const keywords = content.match(/[a-zA-Z]{3,}/g) || [];
        for (const kw of keywords.slice(0, 3)) {
            tags.push(kw.toLowerCase());
        }
        return tags;
    }
}
