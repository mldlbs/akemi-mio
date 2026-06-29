import { eventBus } from '../core/EventBus';
/** 只读工具集合 */
const READ_ONLY_TOOLS = new Set([
    'read_file',
    'list_files',
    'grep',
    'list_plans',
    'list_credentials',
    'list_mcp_servers',
    'list_plugins',
    'analyze_codebase',
    'analyze_task',
]);
/** 写工具集合（分析模式禁止调用） */
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'create_plugin', 'create_dev_plan']);
/** 执行模式禁止的工具 */
const EXECUTE_FORBIDDEN_TOOLS = new Set(['create_dev_plan']);
export class ResponseValidator {
    constructor(bus) {
        this.toolCallBuffer = [];
        this.listeners = [];
        this.hasSnapshot = false;
        this.eventBus = bus || eventBus;
    }
    setRollbackState(available) {
        this.hasSnapshot = available;
    }
    /**
     * 开始监听工具调用事件。
     * 在 tryRun / tryExecutePlan 开始时调用。
     */
    startListening() {
        this.toolCallBuffer = [];
        this.listeners = [];
        const onInvoked = (data) => {
            this.toolCallBuffer.push({
                name: data.tool,
                args: data.args,
                timestamp: Date.now(),
            });
        };
        const onCompleted = (data) => {
            const last = this.toolCallBuffer[this.toolCallBuffer.length - 1];
            if (last && last.name === data.tool && !last.result) {
                last.result = data.result;
            }
        };
        const onFailed = (data) => {
            const last = this.toolCallBuffer[this.toolCallBuffer.length - 1];
            if (last && last.name === data.tool && !last.error) {
                last.error = data.error;
            }
        };
        this.eventBus.on('agent.tool.invoked', onInvoked);
        this.eventBus.on('agent.tool.completed', onCompleted);
        this.eventBus.on('agent.tool.failed', onFailed);
        // 保存清理函数
        this.listeners.push(() => this.eventBus.off('agent.tool.invoked', onInvoked));
        this.listeners.push(() => this.eventBus.off('agent.tool.completed', onCompleted));
        this.listeners.push(() => this.eventBus.off('agent.tool.failed', onFailed));
    }
    /**
     * 停止监听并返回验证结果
     */
    stopAndValidate(mode) {
        const violations = [];
        const warnings = [];
        // 统计
        let readOnly = 0;
        let write = 0;
        let errors = 0;
        for (const call of this.toolCallBuffer) {
            if (READ_ONLY_TOOLS.has(call.name))
                readOnly++;
            if (WRITE_TOOLS.has(call.name))
                write++;
            if (call.error)
                errors++;
            // 模式合规检查
            if (mode === 'analyze' || mode === 'review') {
                if (call.name === 'write_file' || call.name === 'edit_file' || call.name === 'create_plugin') {
                    violations.push({
                        type: 'forbidden_tool',
                        toolName: call.name,
                        message: `分析模式禁止调用 ${call.name}`,
                        severity: 'error',
                    });
                }
            }
            if (mode === 'execute') {
                if (EXECUTE_FORBIDDEN_TOOLS.has(call.name)) {
                    violations.push({
                        type: 'forbidden_tool',
                        toolName: call.name,
                        message: `执行模式禁止调用 ${call.name}（应该 update_plan_progress 而不是创建新计划）`,
                        severity: 'error',
                    });
                }
            }
        }
        // 只读过多警告（分析模式除外：分析模式本身需要大量读取）
        if (mode === 'execute' && readOnly > 10 && write === 0) {
            violations.push({
                type: 'excessive_readonly',
                message: `执行模式下连续 ${readOnly} 次只读操作但无写操作，可能卡在读取阶段`,
                severity: 'warn',
            });
        }
        // 错误过多
        if (errors > 3) {
            violations.push({
                type: 'excessive_errors',
                message: `工具调用错误 ${errors} 次，超过阈值 3`,
                severity: 'warn',
            });
        }
        // 无工具调用
        if (this.toolCallBuffer.length === 0) {
            warnings.push('本次循环没有任何工具调用，LLM 可能未响应工具调用指令');
        }
        // 快照可用性信息
        if (this.hasSnapshot) {
            warnings.push('步骤已创建 Git 快照，支持回滚');
        }
        // 清理监听器
        this.cleanup();
        return {
            passed: violations.filter((v) => v.severity === 'error').length === 0,
            violations,
            warnings,
            stats: {
                total: this.toolCallBuffer.length,
                readOnly,
                write,
                errors,
            },
        };
    }
    /**
     * 丢弃当前缓冲的工具调用（用于退化模式重置）
     */
    reset() {
        this.toolCallBuffer = [];
    }
    /**
     * 获取当前缓冲的快照（用于日志记录）
     */
    getSnapshot() {
        return [...this.toolCallBuffer];
    }
    /**
     * 清理事件监听器
     */
    cleanup() {
        for (const cleanup of this.listeners) {
            try {
                cleanup();
            }
            catch {
                // 忽略清理错误
            }
        }
        this.listeners = [];
    }
}
/**
 * 创建合规摘要字符串（用于日志记录）
 */
export function formatValidationSummary(result) {
    const parts = [
        `工具调用统计: ${result.stats.total}次 (只读${result.stats.readOnly}, 写${result.stats.write}, 错误${result.stats.errors})`,
    ];
    if (result.passed) {
        parts.push('✅ 合规验证通过');
    }
    else {
        parts.push(`❌ 违规 ${result.violations.length} 项`);
    }
    for (const v of result.violations) {
        parts.push(`  [${v.severity}] ${v.type}: ${v.message}`);
    }
    for (const w of result.warnings) {
        parts.push(`  [警告] ${w}`);
    }
    return parts.join('\n');
}
