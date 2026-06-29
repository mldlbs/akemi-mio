/**
 * WorkingMemory — 认知工作记忆
 *
 * 封装当前轮次的 LLM 上下文 + 中间推理产物 + 注意力焦点。
 * 所有 LLM context 构建统一经过这里，消除 messages.push 注入 hack。
 *
 * P0 层级，每个 ChatExecutor/TaskExecutor 持有独立实例。
 */
import { ConversationContext } from './context';
export class Scratchpad {
    constructor() {
        this.entries = [];
    }
    /** 添加一条推理/观察记录到 scratchpad */
    add(type, content) {
        this.entries.push({ type, content, timestamp: Date.now() });
    }
    /** 获取所有未消费的条目并清空 */
    flush() {
        const copy = this.entries.splice(0);
        return copy;
    }
    /** 提取上次 flush 后的新条目 */
    flushNew(lastCount) {
        if (this.entries.length <= lastCount)
            return [];
        const newEntries = this.entries.splice(lastCount);
        return newEntries;
    }
    /** 将 scratchpad 条目渲染为 messages 注入对话 */
    injectInto(messages, asType = 'user') {
        const entries = this.flush();
        if (entries.length === 0)
            return 0;
        const parts = entries.map((e) => `[${e.type}] ${e.content}`);
        messages.push({ role: asType, content: parts.join('\n') });
        return parts.length;
    }
    /** 查看当前条目数（不消费） */
    get size() {
        return this.entries.length;
    }
    clear() {
        this.entries = [];
    }
}
export class AttentionSet {
    constructor() {
        this.entities = new Map();
        this.decayRate = 0.95;
    }
    /** 关注一个实体 */
    add(name, type, relevance = 1.0) {
        const existing = this.entities.get(name);
        if (existing) {
            existing.relevance = Math.max(existing.relevance, relevance);
            existing.lastMentioned = Date.now();
        }
        else {
            this.entities.set(name, { name, type, relevance, lastMentioned: Date.now() });
        }
    }
    /** 从文本中提取并关注实体 */
    extractFrom(text) {
        if (!text || text.length < 3)
            return;
        const fileMatches = text.match(/[\w-]+\/[\w./-]+\.\w+/g);
        if (fileMatches) {
            for (const f of fileMatches) {
                this.add(f, 'file', 0.6);
            }
        }
        const conceptMatches = text.match(/「(.+?)」|"(.+?)"/g);
        if (conceptMatches) {
            for (const c of conceptMatches) {
                const name = c.replace(/[「」""]/g, '').trim();
                if (name.length > 1)
                    this.add(name, 'concept', 0.4);
            }
        }
    }
    /** 获取当前注意力实体列表（按相关度排序） */
    getActive(threshold = 0.3) {
        const now = Date.now();
        const decayMs = 5 * 60 * 1000;
        return Array.from(this.entities.values())
            .map((e) => {
            const elapsed = now - e.lastMentioned;
            const decayedRel = e.relevance * Math.pow(this.decayRate, elapsed / decayMs);
            return { ...e, relevance: decayedRel };
        })
            .filter((e) => e.relevance >= threshold)
            .sort((a, b) => b.relevance - a.relevance);
    }
    /** 格式化注意力上下文，注入 system prompt 用 */
    getFormattedContext(limit = 5) {
        const active = this.getActive().slice(0, limit);
        if (active.length === 0)
            return '';
        const parts = ['---', '【当前关注】'];
        for (const e of active) {
            parts.push(`- ${e.name} (${e.type})`);
        }
        parts.push('---');
        return parts.join('\n');
    }
    /** 交互结束时衰减或移除旧实体 */
    tick() {
        const now = Date.now();
        const staleThreshold = 30 * 60 * 1000;
        for (const [name, entity] of this.entities) {
            if (now - entity.lastMentioned > staleThreshold) {
                this.entities.delete(name);
            }
        }
    }
}
// ─── WorkingMemory ───
export class WorkingMemory {
    constructor(mode, memoryContext, maxTokens = 2000, extraModules, customSystemPrompt, reflectionContext, identityContext) {
        this.tickCount = 0;
        this.mode = mode;
        this.scratchpad = new Scratchpad();
        this.attention = new AttentionSet();
        this.context = new ConversationContext(memoryContext, maxTokens, extraModules, customSystemPrompt, reflectionContext, identityContext);
    }
    /** 添加用户消息并记录注意力 */
    addUser(text) {
        this.context.addUser(text);
        this.attention.extractFrom(text);
        this.scratchpad.add('observe', `用户输入: ${text.slice(0, 80)}`);
    }
    /** 添加助手回复 */
    addAssistant(text, toolCalls) {
        this.context.addAssistant(text, toolCalls);
        if (toolCalls) {
            for (const tc of toolCalls) {
                this.attention.add(tc.name, 'concept', 0.5);
            }
        }
    }
    /** 添加工具结果 */
    addToolResult(toolCallId, content) {
        this.context.addToolCall({ id: toolCallId, type: 'function', function: { name: '', arguments: '' }, result: content });
    }
    /** 在 LLM 调用前，将 scratchpad 注入消息数组 */
    injectScratchpad(messages) {
        return this.scratchpad.injectInto(messages);
    }
    /** 交互结束回调 */
    tick(userText) {
        this.tickCount++;
        this.scratchpad.clear();
        this.attention.tick();
        if (this.tickCount % 5 === 0) {
            this.context.saveToShortTermMemory(5);
        }
        if (userText) {
            this.attention.extractFrom(userText);
        }
    }
    /** 刷新记忆上下文（保留对话历史，只重建 system prompt）
     *  @param clearHistory - 设为 true 时同时清除历史（workflow 激活等场景需要全刷新）
     */
    refreshMemory(memoryContext, reflectionContext, extraModules, identityContext, clearHistory) {
        if (clearHistory) {
            ;
            this.context = new ConversationContext(memoryContext, undefined, extraModules, undefined, reflectionContext, identityContext);
        }
        else {
            this.context.rebuildSystemPrompt(memoryContext, extraModules, reflectionContext, identityContext);
        }
    }
    /** 获取消息列表 */
    getMessages() {
        return this.context.getMessages();
    }
    /** 裁剪 token */
    trimToTokenBudget(maxTokens) {
        this.context.trimToTokenBudget(maxTokens);
    }
    /** 清空但不失上下文 */
    clear(keepShortTerm = true) {
        this.scratchpad.clear();
        this.attention = new AttentionSet();
        this.context.clear(keepShortTerm);
    }
    /** 当前累积的对话轮次 */
    get interactionCount() {
        return this.tickCount;
    }
}
