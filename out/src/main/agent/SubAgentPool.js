import { LlmService } from '../llm/LlmService';
import { ConversationContext } from './context';
import { eventBus } from '../core/EventBus';
import { log } from '../logger/Logger';
import { ScopedAgent } from './scoped/ScopedAgent';
// ── 单个子 Agent 实例 ──
class SubAgentInstance {
    constructor(task, mcpManager, chatKey, codeKey) {
        this.status = 'pending';
        this.summary = '';
        this.startedAt = Date.now();
        this.abortController = new AbortController();
        this.id = task.id;
        this.goal = task.goal;
        this.mcpManager = mcpManager;
        this.llm = new LlmService(mcpManager);
        this.llm.setConfig(chatKey, codeKey);
        this.context = new ConversationContext();
    }
    async run(agentGoal) {
        this.status = 'running';
        log('INFO', 'subagent_started', { id: this.id, goal: this.goal });
        try {
            // 注入目标作为第一条用户消息
            let prompt = this.goal;
            if (agentGoal) {
                prompt = `【上级任务】${agentGoal}\n\n【分配给你的任务】${this.goal}`;
            }
            this.context.addUser(prompt);
            const reply = await this.toolLoop();
            this.summary = reply || '(无回复)';
            this.status = 'completed';
            log('INFO', 'subagent_completed', { id: this.id, summary_len: this.summary.length });
        }
        catch (err) {
            if (err.name === 'AbortError') {
                this.status = 'interrupted';
                this.summary = '任务已被取消';
                log('INFO', 'subagent_interrupted', { id: this.id });
            }
            else {
                this.status = 'failed';
                this.error = err.message;
                this.summary = `任务失败: ${err.message}`;
                log('WARN', 'subagent_failed', { id: this.id, error: err.message });
            }
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
            const result = await this.llm.chatWithTools(messages, `sub_${this.id}_${i}`, 30000);
            if (result.error === 'TIMEOUT') {
                log('WARN', 'subagent_timeout', { id: this.id, step: i });
                continue;
            }
            if (result.error) {
                return `错误: ${result.error}`;
            }
            if (result.toolCalls && result.toolCalls.length > 0) {
                await this.processToolCalls(result.toolCalls, messages);
                continue;
            }
            // 纯文本回复 → 完成
            return result.reply || '';
        }
        return '操作次数过多，已自动停止';
    }
    async processToolCalls(toolCalls, messages) {
        for (const call of toolCalls) {
            if (this.abortController.signal.aborted) {
                throw new DOMException('Aborted', 'AbortError');
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
}
// ── 子 Agent 池 ──
const SUBAGENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟
const WATCHDOG_INTERVAL_MS = 30000; // 每 30 秒检查一次
export class SubAgentPool {
    constructor(mcpManager, bus, chatKey, codeKey) {
        this.agents = new Map();
        this.scopedAgents = new Map();
        /** 已完成但尚未被主 agent 消费的结果 */
        this.completedQueue = [];
        this.counter = 0;
        this.watchdogTimer = null;
        this.mcpManager = mcpManager;
        this.eventBus = bus || eventBus;
        this.chatKey = chatKey || '';
        this.codeKey = codeKey || '';
    }
    /** 派发一个子任务，立即返回 id */
    spawn(goal, parentGoal) {
        const id = `sub_${++this.counter}_${Date.now().toString(36)}`;
        const task = { id, goal };
        const instance = new SubAgentInstance(task, this.mcpManager, this.chatKey, this.codeKey);
        this.agents.set(id, instance);
        // 确保 watchdog 在首次 spawn 时启动
        this.ensureWatchdog();
        // 异步后台执行
        instance.run(parentGoal).then(() => this.onAgentDone(instance));
        log('INFO', 'subagent_spawned', { id, goal: goal.slice(0, 60) });
        return id;
    }
    /** 派发多个并行任务 */
    spawnBatch(tasks, parentGoal) {
        return tasks.map((t) => this.spawn(t.goal, parentGoal));
    }
    /**
     * 派发一个技能子 Agent（受控执行）
     * 返回 agentId，执行完成后结果会进入 completedQueue
     */
    spawnSkillAgent(skillName, agentDef, params) {
        const id = `sk_${++this.counter}_${Date.now().toString(36)}`;
        const agent = new ScopedAgent(id, skillName, agentDef, params, this.mcpManager, this.chatKey, this.codeKey);
        this.scopedAgents.set(id, agent);
        this.ensureWatchdog();
        agent.run().then(() => {
            this.scopedAgents.delete(id);
            this.completedQueue.push(agent.toResult());
            this.eventBus.emit('subagent.completed', {
                id,
                goal: `技能「${skillName}」执行`,
                status: agent.status,
            });
        });
        log('INFO', 'scoped_agent_spawned', { id, skill: skillName });
        return id;
    }
    /** 打断一个子任务 */
    interrupt(id) {
        const inst = this.agents.get(id);
        if (inst) {
            inst.interrupt();
            return true;
        }
        const scoped = this.scopedAgents.get(id);
        if (scoped) {
            scoped.interrupt();
            return true;
        }
        return false;
    }
    /** 打断全部运行中的子任务 */
    interruptAll() {
        let count = 0;
        for (const [, inst] of this.agents) {
            if (inst.status === 'running') {
                inst.interrupt();
                count++;
            }
        }
        for (const [, inst] of this.scopedAgents) {
            if (inst.status === 'running') {
                inst.interrupt();
                count++;
            }
        }
        return count;
    }
    /** 收集所有已完成但尚未被消费的结果 */
    collectCompleted() {
        const results = [...this.completedQueue];
        this.completedQueue = [];
        return results;
    }
    /** 当前运行中的任务列表 */
    listRunning() {
        const running = [];
        for (const [, inst] of this.agents) {
            if (inst.status === 'running')
                running.push({ id: inst.id, goal: inst.goal.slice(0, 60), elapsed: Date.now() - inst.startedAt });
        }
        for (const [, inst] of this.scopedAgents) {
            if (inst.status === 'running')
                running.push({ id: inst.id, goal: `技能【${inst.skillName}】`, elapsed: Date.now() - inst.startedAt });
        }
        return running;
    }
    onAgentDone(instance) {
        this.agents.delete(instance.id);
        this.completedQueue.push({
            id: instance.id,
            goal: instance.goal,
            status: instance.status,
            summary: instance.summary,
            error: instance.error,
            startedAt: instance.startedAt,
            completedAt: instance.completedAt,
        });
        this.eventBus.emit('subagent.completed', {
            id: instance.id,
            goal: instance.goal,
            status: instance.status,
        });
    }
    ensureWatchdog() {
        if (this.watchdogTimer)
            return;
        this.watchdogTimer = setInterval(() => {
            const now = Date.now();
            for (const [id, inst] of this.agents) {
                if (inst.status === 'running' && now - inst.startedAt > SUBAGENT_TIMEOUT_MS) {
                    log('WARN', 'subagent_timeout_kill', { id, elapsed: now - inst.startedAt });
                    inst.interrupt();
                    this.onAgentDone(inst);
                }
            }
            for (const [id, inst] of this.scopedAgents) {
                if (inst.status === 'running' && now - inst.startedAt > SUBAGENT_TIMEOUT_MS) {
                    log('WARN', 'scoped_agent_timeout_kill', { id, skill: inst.skillName, elapsed: now - inst.startedAt });
                    inst.interrupt();
                    this.completedQueue.push(inst.toResult());
                    this.scopedAgents.delete(id);
                }
            }
        }, WATCHDOG_INTERVAL_MS);
        this.watchdogTimer.unref?.();
    }
    /** 销毁池子（清理定时器） */
    dispose() {
        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = null;
        }
        this.interruptAll();
        this.agents.clear();
        this.scopedAgents.clear();
        this.completedQueue = [];
    }
}
