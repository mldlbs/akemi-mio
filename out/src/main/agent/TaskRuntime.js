import { log } from '../logger/Logger';
import { RunState } from './runstate';
import { eventBus } from '../core/EventBus';
export const EVOLUTION_RUNTIME_CONFIG = {
    maxTurns: 30,
    budgetContext: 'evolution',
};
export const CHAT_RUNTIME_CONFIG = {
    maxTurns: 300,
};
export class TaskRuntime {
    constructor(services, hooks, config) {
        this.options = {};
        this.services = services;
        this.hooks = hooks;
        this.config = { ...CHAT_RUNTIME_CONFIG, ...config };
    }
    updateOptions(opts) {
        this.options = { ...this.options, ...opts };
    }
    async run(messages, ctx, abortSignal) {
        ctx.transition(RunState.RUNNING);
        const { llmService, toolScheduler, guardrail, planManager } = this.services;
        const { onToken, onIntermediateReply, swapSystemPrompt, refreshMemory } = this.hooks;
        const sessionPlanIds = this.options.sessionPlanIds ?? new Set();
        try {
            for (let i = 0; i < this.config.maxTurns; i++) {
                ctx.step = i;
                if (ctx.interruptFlag || abortSignal?.aborted) {
                    log('INFO', 'task_runtime_interrupted', { step: i, reason: ctx.interruptReason });
                    return '';
                }
                if (i > 0 && i % 5 === 0 && refreshMemory) {
                    await refreshMemory(i);
                }
                if (i > 0 && i % 5 === 0 && swapSystemPrompt) {
                    swapSystemPrompt(messages);
                }
                const onChunk = (t) => {
                    if (!ctx.interruptFlag && onToken)
                        onToken(t);
                };
                const result = await llmService.chatWithTools(messages, ctx.runId, 120000, onChunk);
                if (result.error) {
                    if (result.error === 'TIMEOUT') {
                        ctx.consecutiveTimeouts++;
                        if (ctx.consecutiveTimeouts >= 3)
                            break;
                        messages.push({ role: 'user', content: '【系统提示】超时，请缩短输出从断点继续。' });
                        continue;
                    }
                    log('WARN', 'task_runtime_llm_error', { error: result.error, step: i });
                    continue;
                }
                if (result.toolCalls && result.toolCalls.length > 0) {
                    ctx.consecutiveTimeouts = 0;
                    if (ctx.interruptFlag)
                        return '';
                    if (result.reply) {
                        if (onIntermediateReply)
                            onIntermediateReply(result.reply, 'electron');
                    }
                    ctx.transition(RunState.WAIT_TOOL);
                    eventBus.emit('agent.progress', { requestId: ctx.runId, step: i + 1, toolNames: result.toolCalls.map((t) => t.name) });
                    result.toolCalls.forEach((tc) => eventBus.emit('agent.tool.invoked', { tool: tc.name, args: tc.arguments }));
                    const toolResults = await toolScheduler.executeAll(result.toolCalls, ctx.abortController.signal);
                    for (const tr of toolResults) {
                        if (tr.success)
                            eventBus.emit('agent.tool.completed', { tool: tr.name, result: tr.content });
                        else
                            eventBus.emit('agent.tool.failed', { tool: tr.name, error: tr.error || '' });
                        let c = tr.content || tr.error || '';
                        if (c.length > 8000)
                            c = c.slice(0, 8000) + `\n... [已截断，原长 ${c.length} 字符]`;
                        messages.push({ role: 'tool', tool_call_id: tr.id, content: c });
                    }
                    const gr = guardrail.apply(toolResults, result.toolCalls, messages, ctx);
                    if (gr.workflowActivation && this.hooks.onWorkflowActivation) {
                        await this.hooks.onWorkflowActivation(gr.workflowActivation.moduleContent);
                    }
                    if (this.hooks.onCheckpoint) {
                        await this.hooks.onCheckpoint(i, ctx.runId).catch(() => { });
                    }
                    ctx.transition(RunState.RUNNING);
                    continue;
                }
                if (this.hooks.onPlanForceContinue) {
                    const pc = await this.hooks.onPlanForceContinue(result.reply || '', messages, ctx);
                    if (pc === 'continue')
                        continue;
                }
                if (this.hooks.onSubAgentCheck) {
                    const hasDone = await this.hooks.onSubAgentCheck(result.reply || '', messages);
                    if (hasDone)
                        continue;
                }
                ctx.transition(RunState.COMPLETED);
                return result.reply || '';
            }
        }
        finally {
            ctx.transition(RunState.COMPLETED);
        }
        return '操作次数过多，请重新尝试';
    }
}
