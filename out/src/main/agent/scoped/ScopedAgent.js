import { LlmService } from '../../llm/LlmService';
import { ConversationContext } from '../context';
import { log } from '../../logger/Logger';
/**
 * ScopedAgent — 受控子 Agent
 *
 * 与 SubAgentInstance 的区别：
 * - 有固定的 system prompt（来自技能 SKILL.md）
 * - 只能调用白名单内的工具
 * - 强制结构化 JSON 输出
 * - 不自主决策，仅按参数执行
 */
export class ScopedAgent {
    constructor(id, skillName, agentDef, params, mcpManager, chatKey, codeKey) {
        this.status = 'pending';
        this.summary = '';
        this.startedAt = Date.now();
        this.abortController = new AbortController();
        this.id = id;
        this.skillName = skillName;
        this.agentDef = agentDef;
        this.params = params;
        this.mcpManager = mcpManager;
        this.llm = new LlmService(mcpManager);
        this.llm.setConfig(chatKey, codeKey);
        this.context = new ConversationContext();
    }
    async run() {
        this.status = 'running';
        log('INFO', 'scoped_agent_start', { id: this.id, skill: this.skillName });
        try {
            this.context = new ConversationContext(undefined, undefined, [this.agentDef.systemPrompt]);
            this.context.addUser(JSON.stringify(this.params));
            const reply = await this.toolLoop();
            this.summary = reply || '(无回复)';
            this.status = 'completed';
            log('INFO', 'scoped_agent_done', { id: this.id, skill: this.skillName });
        }
        catch (err) {
            if (err.name === 'AbortError') {
                this.status = 'interrupted';
                this.summary = '任务已被取消';
            }
            else {
                this.status = 'failed';
                this.error = err.message;
                this.summary = `任务失败: ${err.message}`;
            }
            log('WARN', 'scoped_agent_error', { id: this.id, skill: this.skillName, error: this.error });
        }
        this.completedAt = Date.now();
    }
    interrupt() {
        this.abortController.abort('manual');
    }
    async toolLoop() {
        const messages = this.context.getMessages();
        const maxTurns = 15;
        for (let i = 0; i < maxTurns; i++) {
            if (this.abortController.signal.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }
            const result = await this.llm.chatWithTools(messages, `scoped_${this.id}_${i}`, 30000);
            if (result.error === 'TIMEOUT') {
                log('WARN', 'scoped_agent_timeout', { id: this.id, step: i });
                continue;
            }
            if (result.error) {
                return JSON.stringify({ success: false, error: result.error });
            }
            if (result.toolCalls && result.toolCalls.length > 0) {
                await this.processToolCalls(result.toolCalls, messages);
                continue;
            }
            return this.tryExtractJson(result.reply || '');
        }
        return JSON.stringify({ success: false, error: '操作次数过多，已自动停止' });
    }
    async processToolCalls(toolCalls, messages) {
        for (const call of toolCalls) {
            if (this.abortController.signal.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }
            // 工具白名单检查
            if (!this.agentDef.allowedTools.includes(call.name)) {
                messages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: `Error: 不允许使用工具「${call.name}」。允许的工具: ${this.agentDef.allowedTools.join(', ')}`,
                });
                continue;
            }
            try {
                const output = await this.mcpManager.callTool(call.name, call.arguments);
                messages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: typeof output === 'string' ? output : JSON.stringify(output),
                });
            }
            catch (err) {
                messages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: `Error: ${err.message}`,
                });
            }
        }
    }
    tryExtractJson(reply) {
        const jsonMatch = reply.match(/\{[\s\S]*"success"[\s\S]*\}/);
        if (jsonMatch)
            return jsonMatch[0];
        return JSON.stringify({ success: true, data: reply });
    }
    toResult() {
        return {
            id: this.id,
            goal: `技能「${this.skillName}」执行`,
            status: this.status,
            summary: this.summary,
            error: this.error,
            startedAt: this.startedAt,
            completedAt: this.completedAt,
        };
    }
}
