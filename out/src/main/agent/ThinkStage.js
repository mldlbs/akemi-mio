/**
 * ThinkStage — OTPAR Think 阶段
 *
 * 当 LLM 提出大量工具调用且无文本回复时，
 * 注入策略提示要求 LLM 先说明整体策略再执行。
 * 纯 prompt 注入，无额外 LLM 调用。
 */
import { eventBus } from '../core/EventBus';
const DEFAULT_CONFIG = {
    toolCallThreshold: 3,
    minReplyLength: 10,
    maxPerSession: 3,
};
export function runThink(toolCalls, reply, messages, ctx, config) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    // Fast path: too few tools -> no strategy needed
    if (!toolCalls?.length || toolCalls.length < cfg.toolCallThreshold) {
        return { injected: false };
    }
    // Only trigger when the LLM's reply is empty or very short
    const replyText = (reply || '').trim();
    if (replyText.length >= cfg.minReplyLength) {
        return { injected: false };
    }
    // Build strategy prompt
    const toolSummary = toolCalls.map((t) => `- ${t.name}(${summarizeArgs(t.arguments)})`).join('\n');
    const strategyText = `【思考】你准备连续调用 ${toolCalls.length} 个工具：
${toolSummary}

请先简要说明你的整体策略：你打算做什么，为什么要这么做，预期达到什么结果。然后再执行。`;
    messages.push({ role: 'user', content: strategyText });
    eventBus.emit('agent.think', {
        requestId: ctx.runId,
        step: ctx.step,
        toolCallCount: toolCalls.length,
        strategyPrompted: true,
    });
    return { injected: true };
}
function summarizeArgs(args) {
    try {
        if (typeof args === 'string') {
            const parsed = JSON.parse(args);
            const keys = Object.keys(parsed);
            return keys.length <= 2 ? keys.join(', ') : `${keys.slice(0, 2).join(', ')}, ...`;
        }
        if (args && typeof args === 'object') {
            const keys = Object.keys(args);
            return keys.length <= 2 ? keys.join(', ') : `${keys.slice(0, 2).join(', ')}, ...`;
        }
        return String(args).slice(0, 40);
    }
    catch {
        return String(args).slice(0, 40);
    }
}
