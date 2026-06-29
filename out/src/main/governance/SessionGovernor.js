import { log } from '../logger/Logger';
import { eventBus, SubscriptionTracker } from '../core/EventBus';
import { SessionHealthScorer } from './SessionHealthScorer';
import { SessionStateMachine } from './SessionStateMachine';
import { RECOVERY_ACTIONS } from './SessionGovernorTypes';
export class SessionGovernor {
    constructor() {
        this.name = 'SessionGovernor';
        this.state = 'created';
        this.subs = new SubscriptionTracker();
        this.stateManager = null;
        this.tickTimer = null;
        this.recoveryInProgress = false;
        this.tickIntervalMs = 30000;
        this.callbacks = {};
        this.scorer = new SessionHealthScorer();
        this.stateMachine = new SessionStateMachine();
    }
    setStateManager(sm) {
        this.stateManager = sm;
    }
    setRecoveryCallbacks(cbs) {
        this.callbacks = cbs;
    }
    // ── ISubsystem ──
    async init() {
        if (this.state !== 'created')
            return;
        this.state = 'initializing';
        log('INFO', 'session_governor.init');
        this.state = 'ready';
    }
    async start() {
        if (this.state !== 'ready')
            return;
        this.state = 'running';
        this.subscribeEvents();
        this.startTickTimer();
        this.pushUIState();
        log('INFO', 'session_governor.started', {
            healthScore: this.scorer.getScore(),
            healthLevel: this.scorer.getLevel(),
            sessionState: this.stateMachine.state,
        });
    }
    async stop() {
        this.state = 'stopping';
        this.subs.dispose();
        if (this.tickTimer) {
            clearInterval(this.tickTimer);
            this.tickTimer = null;
        }
        this.state = 'stopped';
        log('INFO', 'session_governor.stopped');
    }
    async destroy() {
        this.subs.dispose();
        if (this.tickTimer) {
            clearInterval(this.tickTimer);
            this.tickTimer = null;
        }
        log('INFO', 'session_governor.destroyed');
    }
    async healthCheck() {
        const score = this.scorer.getScore();
        const level = this.scorer.getLevel();
        const state = this.stateMachine.state;
        const healthy = score >= 50 && state !== 'FATAL' && state !== 'REBUILDING';
        return {
            healthy,
            detail: healthy ? undefined : `Session unhealthly: score=${score}(${level}), state=${state}`,
            metrics: { healthScore: score, sessionState: state },
        };
    }
    // ── EventBus 订阅 ──
    subscribeEvents() {
        const track = (event, handler, label) => {
            eventBus.track(event, handler, this.subs, `sg:${label}`);
        };
        track('agent.tool.completed', () => {
            this.scorer.recordToolResult(true);
            this.evaluateAndAct();
        }, 'tool_completed');
        track('agent.tool.failed', () => {
            this.scorer.recordToolResult(false);
            this.evaluateAndAct();
        }, 'tool_failed');
        track('goal.guardrail.rejection', () => {
            this.scorer.recordGuardrailTrip();
        }, 'guardrail_rejection');
        track('goal.guardrail.tripped', () => {
            this.scorer.recordGuardrailTrip();
        }, 'guardrail_tripped');
        track('recovery.error.classified', (p) => {
            if (p.category === 'FATAL')
                this.scorer.recordToolResult(false);
        }, 'error_classified');
        track('budget.exhausted', () => {
            this.scorer.recordToolResult(false);
        }, 'budget_exhausted');
        track('budget.restored', () => {
            this.scorer.recordToolResult(true);
        }, 'budget_restored');
        track('recovery.recovery.started', () => {
            this.recoveryInProgress = true;
        }, 'recovery_started');
        track('recovery.recovery.completed', () => {
            this.recoveryInProgress = false;
        }, 'recovery_completed');
        // ── Guardrail 闭环事件 ──
        track('guardrail.readonly_stuck', () => {
            this.scorer.recordGuardrailTrip();
            this.scorer.recordToolResult(false);
            this.evaluateAndAct();
        }, 'guardrail_readonly');
        track('guardrail.tool_error', () => {
            this.scorer.recordGuardrailTrip();
            this.scorer.recordToolResult(false);
            this.evaluateAndAct();
        }, 'guardrail_tool_error');
        track('guardrail.context_corrupted', () => {
            this.scorer.recordToolResult(false);
            this.evaluateAndAct();
        }, 'guardrail_context_corrupted');
    }
    // ── 核心评估循环 ──
    evaluateAndAct() {
        const result = this.scorer.compute();
        const failures = this.scorer.getConsecutiveFailures();
        // 1. 检查状态迁移
        const transition = this.stateMachine.evaluateTransition(result.score, failures);
        let stateChanged = false;
        if (transition) {
            stateChanged = this.stateMachine.transitionTo(transition.to, transition.reason, result.score);
            if (stateChanged) {
                this.emitStateChange(transition.to, transition.reason);
            }
        }
        // 2. 触发恢复
        if (stateChanged) {
            this.triggerRecoveryIfNeeded();
        }
        // 3. 广播
        eventBus.emit('stability.score.updated', {
            score: result.score,
            trend: result.trend,
            status: result.level,
        });
        // 4. UI
        this.pushUIState();
    }
    // ── 恢复编排 ──
    triggerRecoveryIfNeeded() {
        if (this.recoveryInProgress)
            return;
        if (!this.stateMachine.canRecover())
            return;
        const actions = this.stateMachine.getRecommendedActions();
        if (actions.length === 0)
            return;
        this.recoveryInProgress = true;
        const state = this.stateMachine.state;
        const score = this.scorer.getScore();
        log('INFO', 'session_governor.recovery_triggered', {
            fromState: state,
            actions: actions.map((l) => RECOVERY_ACTIONS[l].name),
            healthScore: score,
        });
        eventBus.emit('recovery.recovery.started', {
            oldRunId: `session_gov_${Date.now()}`,
            error: `SessionGovernor recovery: state=${state}, score=${score}`,
        });
        this.executeActionsSequentially(actions)
            .then(() => {
            this.recoveryInProgress = false;
            eventBus.emit('recovery.recovery.completed', {
                newRunId: `session_gov_${Date.now()}`,
                success: true,
            });
        })
            .catch((err) => {
            this.recoveryInProgress = false;
            log('ERROR', 'session_governor.recovery_failed', { error: String(err) });
        });
    }
    async executeActionsSequentially(actions) {
        for (const level of actions) {
            const action = RECOVERY_ACTIONS[level];
            log('INFO', 'session_governor.executing_action', { action: action.name, level });
            try {
                await this.executeAction(level);
                const newScore = this.scorer.getScore();
                if (newScore > 70)
                    break;
            }
            catch (err) {
                log('WARN', 'session_governor.action_failed', {
                    action: action.name,
                    error: String(err),
                });
            }
        }
    }
    async executeAction(level) {
        const cb = this.callbacks;
        switch (level) {
            case 1:
                eventBus.emit('recovery.context.compress', { beforeTokens: 0, afterTokens: 0 });
                cb.onContextCompress?.();
                log('INFO', 'sg_action:context_compress');
                return true;
            case 2:
                cb.onInjectCorrection?.('[SessionGovernor] 检测到会话异常，已自动触发纠偏，请简化操作重试。');
                log('INFO', 'sg_action:inject_correction');
                return true;
            case 3:
                cb.onModelSwitch?.('deepseek-chat');
                log('INFO', 'sg_action:model_switch', { to: 'deepseek-chat' });
                return true;
            case 4:
                cb.onToolDowngrade?.(true);
                log('INFO', 'sg_action:tool_downgrade', { restricted: true });
                return true;
            case 5:
                cb.onClearContext?.();
                log('INFO', 'sg_action:clear_context');
                return true;
            case 6:
                this.scorer.resetFailures();
                this.stateMachine.reset();
                log('INFO', 'sg_action:rebuild_session');
                return true;
            case 7:
                this.stateMachine.transitionTo('SAFE_MODE', 'SessionGovernor initiated safe mode', this.scorer.getScore());
                this.pushUIState();
                log('INFO', 'sg_action:safe_mode');
                return true;
            case 8:
                log('INFO', 'sg_action:hibernation');
                return true;
            default:
                log('INFO', 'sg_action:not_implemented', { level, name: RECOVERY_ACTIONS[level].name });
                return true;
        }
    }
    // ── 定时评估 ──
    startTickTimer() {
        this.tickTimer = setInterval(() => {
            this.evaluateAndAct();
        }, this.tickIntervalMs);
    }
    // ── UI ──
    pushUIState() {
        if (!this.stateManager)
            return;
        const score = this.scorer.getScore();
        const level = this.scorer.getLevel();
        const state = this.stateMachine.state;
        this.stateManager.batch({
            error: score < 50 ? `会话健康度 ${score}/100 (${level})，状态: ${state}` : undefined,
            sessionHealth: `${score}:${level}:${state}`,
        });
    }
    emitStateChange(to, reason) {
        const last = this.stateMachine.getLastTransition();
        eventBus.emit('stability.status.changed', {
            previous: last?.from ?? 'RUNNING',
            current: to,
            score: this.scorer.getScore(),
        });
    }
    getDiagnostics() {
        return {
            scorer: this.scorer.getDiagnostics(),
            stateMachine: this.stateMachine.getDiagnostics(),
            recoveryInProgress: this.recoveryInProgress,
        };
    }
}
