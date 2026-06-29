/**
 * SelfEvolutionService — 进化调度编排器（薄层）
 *
 * 职责：
 * 1. 调度状态机（IDLE→ANALYZING→EXECUTING→VERIFYING→COOLDOWN）
 * 2. 编排 4 阶段流水线：Analyzer → Strategizer → Executor → Reviewer
 * 3. 系统状态持久化（冷却/失败计数跨重启）
 * 4. 安全模式管理、用户活跃保护、完整性检查
 *
 * 非职责（已下沉到各阶段）：
 * - LLM 分析/计划创建 → EvolutionAnalyzer
 * - 策略选择/评分 → EvolutionStrategizer
 * - 步骤执行/Git 回滚 → EvolutionExecutor
 * - 合规验证/回归检测 → EvolutionReviewer
 */
import { join, dirname } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { log } from '../logger/Logger';
import { scheduler } from '../core/Scheduler';
import { eventBus } from '../core/EventBus';
import { withTimeout } from '../utils/async';
import { AsyncLock } from '../utils/AsyncLock';
import { PlanIntegrityChecker } from './PlanIntegrityChecker';
import { EVOLUTION_SAFETY_MODE, WORKSPACE } from '../config';
import { EvolutionAnalyzer } from './pipeline/EvolutionAnalyzer';
import { EvolutionStrategizer } from './pipeline/EvolutionStrategizer';
import { EvolutionExecutor } from './pipeline/EvolutionExecutor';
import { EvolutionReviewer } from './pipeline/EvolutionReviewer';
import { ResponseValidator } from './ResponseValidator';
import { PromptEvolutionManager } from './PromptEvolutionManager';
import { EvolutionSelfEvaluator } from './EvolutionSelfEvaluator';
import { MetaLearner } from './MetaLearner';
import { EvaluatorCalibrator } from './EvaluatorCalibrator';
// =============================================================================
// 调度状态机状态枚举
// =============================================================================
export var EvolutionSchedulerState;
(function (EvolutionSchedulerState) {
    EvolutionSchedulerState["IDLE"] = "IDLE";
    EvolutionSchedulerState["ANALYZING"] = "ANALYZING";
    EvolutionSchedulerState["EXECUTING"] = "EXECUTING";
    EvolutionSchedulerState["VERIFYING"] = "VERIFYING";
    EvolutionSchedulerState["COOLDOWN"] = "COOLDOWN";
})(EvolutionSchedulerState || (EvolutionSchedulerState = {}));
const DEFAULT_HISTORY_PATH = join(WORKSPACE.evolution, 'history.json');
/**
 * SelfEvolutionService — 进化调度编排器
 *
 * 薄层协调器：维护调度状态机，编排 Analyzer→Strategizer→Executor→Reviewer 流水线。
 * 与外部系统（AgentService, PlanManager, CognitiveService）对接。
 */
export class SelfEvolutionService {
    constructor(agentService, sched, bus, planManager, options) {
        this.name = 'SelfEvolutionService';
        this.state = 'created';
        this.planManager = null;
        this.cognitiveService = null;
        // ==================== 调度状态机 ====================
        this.schedulerState = EvolutionSchedulerState.IDLE;
        this.schedulerTickId = null;
        /** 后备心跳间隔（30 分钟），事件驱动是主触发方式 */
        this.schedulerTickMs = 30 * 60 * 1000;
        this.lastAnalysisTime = 0;
        this.lastExecutionTime = 0;
        this.lastRun = 0;
        // ==================== 用户活跃保护 ====================
        this.mioActive = false;
        this.mioActiveSince = 0;
        this.lastUserInputTime = 0;
        // ==================== 安全 & 冷却 ====================
        this.safetyMode = EVOLUTION_SAFETY_MODE;
        this.safetyModeAutoPromoted = false;
        this.tryRunFailures = 0;
        this.executeFailures = 0;
        this.maxFailures = 3;
        this.recoveryCooldownUntil = 0;
        this.lastSuccessTime = 0;
        this.intervalMs = 2 * 60 * 60 * 1000;
        this.evolutionLock = new AsyncLock();
        // ==================== 自适应参数 ====================
        this.firstRunComplete = false;
        this.analysisStuckTimeoutMs = 180000;
        this.consecutiveCleanCycles = 0;
        this.consecutiveDegenerateDetections = 0;
        // ==================== 事件订阅清理 ====================
        this.eventSubscriptions = [];
        // ==================== 创造力建议缓存 ====================
        /** 最近一次来自创造力系统的优质假设，注入到下一次分析 prompt 中 */
        this.creativityHypothesis = null;
        this.eventCooldownUntil = 0;
        this.agentService = agentService;
        this.scheduler = sched || scheduler;
        this.eventBus = bus || eventBus;
        this.planManager = planManager || null;
        this.historyPath = options?.historyPath || DEFAULT_HISTORY_PATH;
        this.analysisStuckTimeoutMs = options?.analysisStuckTimeoutMs ?? 180000;
        this.stateFilePath = options?.stateFilePath ?? join(dirname(this.historyPath), 'living_plan', 'evolution_state.json');
        this.analyzer = new EvolutionAnalyzer(agentService, this.planManager, {
            historyPath: this.historyPath,
            maxLivingPlanBytes: options?.maxLivingPlanBytes ?? 4096,
            analysisTimeoutMs: options?.analysisTimeoutMs ?? 120000,
            degenerationThreshold: options?.degenerationThreshold ?? 3,
        });
        this.strategizer = new EvolutionStrategizer({
            scoreFilePath: join(WORKSPACE.evolution, 'strategy_scores.json'),
        });
        this.executor = new EvolutionExecutor(agentService, this.planManager, {
            planExecTimeoutMs: options?.planExecTimeoutMs ?? 300000,
            stepRetryBaseMs: options?.stepRetryBaseMs ?? 1000,
        });
        this.reviewer = new EvolutionReviewer(this.createResponseValidator(), {
            gitOps: null,
        });
        // Phase 3: Meta Evolution
        this.promptEvolutionManager = new PromptEvolutionManager();
        this.selfEvaluator = new EvolutionSelfEvaluator();
        this.metaLearner = new MetaLearner();
        this.evaluatorCalibrator = new EvaluatorCalibrator();
        this.loadState();
        // 用户活跃保护
        this.eventBus.on('agent.input.received', () => {
            this.lastUserInputTime = Date.now();
            this.mioActive = true;
            this.mioActiveSince = Date.now();
        });
        this.eventBus.on('agent.response.generated', () => {
            this.mioActive = false;
            this.mioActiveSince = 0;
        });
        // 事件驱动触发订阅（事件冷却 5min，避免风暴）
        this.eventSubscriptions.push(this.eventBus.on('stability.score.updated', (p) => {
            if (p.status === 'unstable' || p.status === 'critical' || p.trend === 'declining') {
                this.onTriggerEvent('stability.score.updated', p);
            }
        }), this.eventBus.on('budget.exhausted', (p) => this.onTriggerEvent('budget.exhausted', p)), this.eventBus.on('evolution.cycle.completed', (p) => {
            if (!p.success)
                this.onTriggerEvent('evolution.cycle.completed', p);
        }), 
        // Phase 2: 接收创造力系统的高分假设
        this.eventBus.on('creativity.hypothesis.selected', (p) => {
            this.creativityHypothesis = {
                title: p.title,
                idea: p.idea,
                novelty: p.novelty,
                feasibility: p.feasibility,
                impact: p.impact,
                expectedBenefit: p.expectedBenefit,
                risk: p.risk,
            };
            log('INFO', 'evolution_received_creativity_hypothesis', {
                title: p.title,
                score: p.novelty + p.feasibility + p.impact,
            });
        }));
    }
    /**
     * 事件触发入口：带冷却保护，防止事件风暴导致频繁分析
     */
    onTriggerEvent(event, payload) {
        if (Date.now() < this.eventCooldownUntil) {
            log('INFO', 'evolution_trigger_event_cooldown', { event, remainingMs: this.eventCooldownUntil - Date.now() });
            return;
        }
        // 状态机保护：只在 IDLE 时触发
        if (this.schedulerState !== EvolutionSchedulerState.IDLE) {
            log('INFO', 'evolution_trigger_event_busy', { event, state: this.schedulerState });
            return;
        }
        this.eventCooldownUntil = Date.now() + SelfEvolutionService.EVENT_COOLDOWN_MS;
        log('INFO', 'evolution_trigger_event', { event, payload });
        this.runAnalysisCycle();
    }
    createResponseValidator() {
        return new ResponseValidator(this.eventBus);
    }
    // ==================== ISubsystem ====================
    async init() {
        this.state = 'initializing';
        await Promise.all([this.analyzer.init(), this.strategizer.init(), this.executor.init(), this.reviewer.init()]);
        this.state = 'ready';
    }
    async start() {
        this.state = 'running';
        await Promise.all([this.analyzer.start(), this.strategizer.start(), this.executor.start(), this.reviewer.start()]);
    }
    async stop() {
        this.state = 'stopping';
        this.stopExistingTick();
        this.disposeEventSubscriptions();
        await Promise.all([this.analyzer.stop(), this.strategizer.stop(), this.executor.stop(), this.reviewer.stop()]);
        this.state = 'stopped';
    }
    async destroy() {
        this.disposeEventSubscriptions();
        await Promise.all([this.analyzer.destroy(), this.strategizer.destroy(), this.executor.destroy(), this.reviewer.destroy()]);
    }
    disposeEventSubscriptions() {
        for (const dispose of this.eventSubscriptions)
            dispose();
        this.eventSubscriptions = [];
    }
    async healthCheck() {
        return {
            healthy: true,
            metrics: {
                state: this.schedulerState,
                tryRunFailures: this.tryRunFailures,
                executeFailures: this.executeFailures,
            },
        };
    }
    // ==================== 公共 API ====================
    scheduleEvolution(intervalHours = 2) {
        this.stopExistingTick();
        const intervalMs = Math.max(intervalHours, 1) * 60 * 60 * 1000;
        this.intervalMs = intervalMs;
        this.schedulerTickId = this.scheduler.interval(this.schedulerTickMs, async () => {
            await this.schedulerTick();
            return '';
        }, '@evolution');
        log('INFO', 'evolution_started', { interval_hours: intervalHours, fallback_heartbeat_min: this.schedulerTickMs / 60000 });
    }
    stopExistingTick() {
        if (this.schedulerTickId) {
            this.scheduler.cancel(this.schedulerTickId);
            this.schedulerTickId = null;
        }
    }
    async triggerNow() {
        if (!this.firstRunComplete) {
            log('INFO', 'evolution_warmup_first_run');
            await this.warmupFirstRun();
        }
        await this.runAnalysisCycle();
    }
    getSchedulerState() {
        return this.schedulerState;
    }
    getSafetyMode() {
        return this.safetyMode;
    }
    getLastRun() {
        return this.lastRun;
    }
    getConsecutiveFailures() {
        return this.tryRunFailures;
    }
    getExecuteFailures() {
        return this.executeFailures;
    }
    getRecoveryCooldown() {
        if (this.recoveryCooldownUntil === 0 || Date.now() > this.recoveryCooldownUntil) {
            return { active: false, remainingMs: 0 };
        }
        return { active: true, remainingMs: this.recoveryCooldownUntil - Date.now() };
    }
    setSafetyMode(mode) {
        this.safetyMode = mode;
        this.executor.setSafetyMode(mode);
        log('INFO', 'evolution_safety_mode', { mode });
    }
    setVerificationRunner(runner, verifyAfter) {
        this.reviewer.setVerificationRunner(runner, verifyAfter);
    }
    setRegressionDetector(detector) {
        this.reviewer.setRegressionDetector(detector);
    }
    setCognitiveService(cs) {
        this.cognitiveService = cs;
    }
    setProposalValidator(v) {
        this.executor.setProposalValidator(v);
        this.reviewer.setProposalValidator(v);
    }
    setGitOps(gitOps) {
        this.executor.setGitOps(gitOps);
        this.reviewer.setGitOps(gitOps);
    }
    // ==================== 调度 tick ====================
    async schedulerTick() {
        // 用户活跃保护
        if (this.mioActive) {
            if (this.mioActiveSince > 0 && Date.now() - this.mioActiveSince > SelfEvolutionService.MIO_ACTIVE_TIMEOUT_MS) {
                log('WARN', 'scheduler_tick_mio_active_timeout_clear', { activeMs: Date.now() - this.mioActiveSince });
                this.mioActive = false;
                this.mioActiveSince = 0;
            }
            else {
                return;
            }
        }
        if (Date.now() - this.lastUserInputTime < SelfEvolutionService.USER_COOLDOWN_MS)
            return;
        if (this.agentService.isBusy()) {
            if (this.lastRun > 0 &&
                Date.now() - this.lastRun > this.analyzer.getAnalysisTimeout() &&
                this.schedulerState === EvolutionSchedulerState.ANALYZING) {
                log('WARN', 'scheduler_tick_stale_abort', { state: this.schedulerState, ageMs: Date.now() - this.lastRun });
                this.agentService.abortSelfTask?.();
                await new Promise((r) => setTimeout(r, 300));
                if (!this.agentService.isBusy())
                    this.transitionState(EvolutionSchedulerState.IDLE, '残留分析任务已中止');
                else
                    return;
            }
            else
                return;
        }
        // 冷却恢复
        if (this.recoveryCooldownUntil > 0) {
            if (Date.now() > this.recoveryCooldownUntil) {
                this.tryRunFailures = 0;
                this.executeFailures = 0;
                this.executor.resetFailures();
                this.recoveryCooldownUntil = 0;
                this.transitionState(EvolutionSchedulerState.IDLE, '冷却期结束');
            }
            else
                return;
        }
        switch (this.schedulerState) {
            case EvolutionSchedulerState.IDLE: {
                const hoursSinceLastAnalysis = (Date.now() - this.lastAnalysisTime) / (1000 * 60 * 60);
                if (this.lastAnalysisTime === 0 || hoursSinceLastAnalysis >= Math.max(this.intervalMs / (1000 * 60 * 60), 1)) {
                    if (!this.firstRunComplete) {
                        log('INFO', 'scheduler_tick_warmup_before_first_analysis');
                        await this.warmupFirstRun();
                    }
                    this.transitionState(EvolutionSchedulerState.ANALYZING, `距上次分析 ${hoursSinceLastAnalysis.toFixed(1)}h`);
                    await this.runAnalysisCycle();
                }
                else if (this.safetyMode !== 'review' && this.executor.hasPendingStep() && this.executeFailures < this.maxFailures) {
                    this.transitionState(EvolutionSchedulerState.EXECUTING, '有待执行步骤');
                    await this.runExecutionCycle();
                }
                break;
            }
            case EvolutionSchedulerState.ANALYZING: {
                if (Date.now() - this.lastAnalysisTime > this.analysisStuckTimeoutMs) {
                    log('WARN', 'scheduler_tick_analysis_stuck_timeout', {
                        ageMs: Date.now() - this.lastAnalysisTime,
                        timeoutMs: this.analysisStuckTimeoutMs,
                    });
                    this.agentService.abortSelfTask?.();
                    this.transitionState(EvolutionSchedulerState.IDLE, '分析任务被强制中止（合并超时）');
                }
                break;
            }
            case EvolutionSchedulerState.EXECUTING: {
                if (Date.now() - this.lastExecutionTime > 600000) {
                    log('WARN', 'scheduler_tick_executing_stuck', { lastExecAgeMs: Date.now() - this.lastExecutionTime });
                    this.agentService.abortSelfTask?.();
                    this.transitionState(EvolutionSchedulerState.IDLE, '执行任务被强制中止');
                }
                break;
            }
            case EvolutionSchedulerState.VERIFYING: {
                if (Date.now() - this.lastExecutionTime > 900000)
                    this.transitionState(EvolutionSchedulerState.IDLE, '验证阶段超时');
                break;
            }
            case EvolutionSchedulerState.COOLDOWN:
                break;
        }
    }
    // ==================== 分析循环 ====================
    async runAnalysisCycle() {
        this.transitionState(EvolutionSchedulerState.ANALYZING, '开始分析循环');
        this.lastAnalysisTime = Date.now();
        this.reviewer.startListen();
        await this.evolutionLock.run(async () => {
            if (this.agentService.isBusy()) {
                if (this.lastRun > 0 && Date.now() - this.lastRun > this.analyzer.getAnalysisTimeout()) {
                    this.agentService.abortSelfTask?.();
                    await new Promise((r) => setTimeout(r, 300));
                    if (this.agentService.isBusy()) {
                        this.transitionState(EvolutionSchedulerState.IDLE, '残留任务无法清除');
                        return;
                    }
                }
                else {
                    this.transitionState(EvolutionSchedulerState.IDLE, 'agent 正忙');
                    return;
                }
            }
            if (this.recoveryCooldownUntil > 0 && Date.now() > this.recoveryCooldownUntil) {
                this.tryRunFailures = 0;
                this.executeFailures = 0;
                this.executor.resetFailures();
                this.recoveryCooldownUntil = 0;
            }
            // 退化检测与恢复 — 渐进式降级 + 自愈
            if (this.analyzer.isDegenerate()) {
                this.consecutiveDegenerateDetections++;
                // 1. 切换到 review 安全模式
                if (this.safetyMode !== 'review') {
                    this.safetyMode = 'review';
                    this.executor.setSafetyMode('review');
                    this.safetyModeAutoPromoted = false; // 不允许自动回到 auto
                    log('WARN', 'evolution_degenerate_safety_review', { safetyMode: this.safetyMode });
                }
                // Phase 3: 严重退化 → 演化 prompt（LLM 驱动）
                if (this.consecutiveDegenerateDetections >= 2) {
                    const fp = this.analyzer.getFingerprints();
                    const failureSummary = this.analyzer
                        .loadRecentFailures()
                        .slice(-3)
                        .map((f) => `${f.task}: ${f.error}`)
                        .join('\n');
                    this.promptEvolutionManager.llmEvolvePrompt('analysis_prompt', '退化检测：连续产生相同分析结论', `指纹: ${fp.slice(-3).join(' → ')}\n${failureSummary}`, this.agentService);
                    this.promptEvolutionManager.llmEvolvePrompt('system_prompt', '退化检测：连续产生相同分析结论', `指纹: ${fp.slice(-3).join(' → ')}\n${failureSummary}`, this.agentService);
                }
                // 2. 检查最后一次非退化输出年龄（>12h 强制降级清空指纹历史）
                const fingerprintAgeMs = this.analyzer.getFingerprintAgeMs();
                if (fingerprintAgeMs > 12 * 60 * 60 * 1000) {
                    log('WARN', 'evolution_degenerate_recovery_timeout', { fingerprintAgeMs });
                    this.analyzer.resetFingerprints();
                    this.analyzer.resetDegenerationCount();
                    this.consecutiveDegenerateDetections = 0;
                    if (this.safetyMode === 'review' && this.tryRunFailures < this.maxFailures) {
                        this.safetyMode = 'auto';
                        this.executor.setSafetyMode('auto');
                        log('INFO', 'evolution_degenerate_recovery_auto_promoted');
                    }
                }
                else {
                    // 3. 渐进式 backoff：连续退化次数越多，跳过越久
                    const backoffMs = Math.min(this.consecutiveDegenerateDetections * 30 * 60 * 1000, 4 * 60 * 60 * 1000);
                    log('WARN', 'evolution_skip_degenerate', {
                        consecutiveDegenerateDetections: this.consecutiveDegenerateDetections,
                        backoffMinutes: Math.round(backoffMs / 60000),
                    });
                    this.transitionState(EvolutionSchedulerState.COOLDOWN, `退化检测跳过 (backoff ${Math.round(backoffMs / 60000)}min)`);
                    if (this.recoveryCooldownUntil === 0 || this.recoveryCooldownUntil < Date.now() + backoffMs) {
                        this.recoveryCooldownUntil = Date.now() + backoffMs;
                    }
                    return;
                }
            }
            else {
                // 连续健康运行 → 逐步降低退化计数
                if (this.consecutiveDegenerateDetections > 0) {
                    this.consecutiveDegenerateDetections = Math.max(0, this.consecutiveDegenerateDetections - 1);
                }
            }
            let degradedMode = false;
            if (this.tryRunFailures >= this.maxFailures) {
                if (this.recoveryCooldownUntil > 0 && Date.now() <= this.recoveryCooldownUntil)
                    return;
                degradedMode = true;
            }
            this.lastRun = Date.now();
            this.eventBus.emit('evolution.cycle.started', { timestamp: this.lastRun, failures: this.tryRunFailures });
            this.performIntegrityCheck();
            const strategy = this.strategizer.select({
                consecutiveFailures: this.tryRunFailures,
                isFirstRun: this.lastRun === 0,
                isRecovering: this.recoveryCooldownUntil > 0 && Date.now() <= this.recoveryCooldownUntil,
                hoursSinceLastRun: this.lastRun > 0 ? (Date.now() - this.lastRun) / (1000 * 60 * 60) : 0,
                isDegenerate: this.analyzer.isDegenerate(),
            });
            this.analyzer.setAnalysisTimeout(strategy.timeoutMs);
            this.analyzer.setPromptTrimMode(strategy.trimMode);
            this.analyzer.setHistoryMaxEntries(strategy.maxHistoryEntries);
            // Phase 3: 注入 prompt overlay
            this.analyzer.setPromptOverlay(this.promptEvolutionManager.getOverlay('analysis_prompt'));
            const planDetection = this.analyzer.detectPlanMode();
            const effectiveMode = degradedMode ? 'review_only' : planDetection.mode;
            const effectiveSafety = degradedMode ? 'review' : this.safetyMode;
            const input = {
                mode: effectiveMode,
                planContext: planDetection.planContext,
                historySummary: this.analyzer.getHistorySummary(),
                safetyMode: effectiveSafety,
                validationSummary: this.reviewer.getLastValidationSummary(),
                livingPlanCtx: this.analyzer.buildLivingPlanContext(),
                cognitiveCtx: this.cognitiveService?.getFormattedContext() || '',
                strategyCtx: this.strategizer.getFormattedContext(),
                creativityCtx: this.creativityHypothesis
                    ? [
                        '【创造力系统建议】',
                        `标题: ${this.creativityHypothesis.title}`,
                        `描述: ${this.creativityHypothesis.idea}`,
                        `评分: 新颖=${this.creativityHypothesis.novelty} 可行=${this.creativityHypothesis.feasibility} 影响=${this.creativityHypothesis.impact}`,
                        `预期收益: ${this.creativityHypothesis.expectedBenefit}`,
                        `风险: ${this.creativityHypothesis.risk}`,
                        '以上是创造力系统产出的改进建议。请评估是否值得纳入本次分析/计划，',
                        '如果是则作为计划的一部分执行，如果不是则说明理由。',
                    ].join('\n')
                    : undefined,
                promptMode: strategy.promptMode,
            };
            try {
                // 廉价预过滤：检查是否有必要运行 LLM 分析
                const preCheck = this.analyzer.shouldAnalyze();
                if (!preCheck.shouldRun) {
                    log('INFO', 'evolution_skip_prefilter', { reason: preCheck.reason });
                    this.eventBus.emit('evolution.cycle.completed', {
                        success: true,
                        summary: `预过滤跳过: ${preCheck.reason}`,
                        timestamp: Date.now(),
                        durationMs: 0,
                    });
                    this.saveState();
                    return;
                }
                const result = await this.analyzer.analyze(input);
                this.analyzer.recordFingerprint(result.summary);
                // Phase 3: 自评估结果（在多个 if 块中共享）
                let selfEval = null;
                if (result.success) {
                    this.tryRunFailures = 0;
                    this.lastSuccessTime = Date.now();
                    this.recoveryCooldownUntil = 0;
                    this.handleRecoveryParam();
                    if (this.safetyMode === 'review' && !this.safetyModeAutoPromoted) {
                        this.safetyMode = 'auto';
                        this.safetyModeAutoPromoted = true;
                    }
                    if (this.cognitiveService) {
                        try {
                            await this.cognitiveService.adjustByToken(this.analyzer.loadRecentFailures());
                        }
                        catch {
                            log('WARN', 'cognitive_adjust_skipped');
                        }
                    }
                    // Phase 3: 自评估 + prompt 性能记录
                    if (result.success) {
                        try {
                            const activePlan = this.planManager?.getActivePlan();
                            selfEval = this.selfEvaluator.evaluate({
                                strategyName: strategy.name,
                                promptMode: strategy.promptMode,
                                analysisSummary: result.summary,
                                planCreated: result.planCreated,
                                planSteps: activePlan?.steps.map((s) => s.description) || [],
                                recentHistory: this.analyzer.getFingerprints(),
                                analysisMode: effectiveMode,
                            });
                            this.eventBus.emit('evolution.self.evaluated', {
                                cycleTimestamp: this.lastRun,
                                strategyName: strategy.name,
                                score: selfEval.score,
                                dimensions: selfEval.dimensions,
                                feedback: selfEval.feedback,
                            });
                            // 持久化 self-evaluator 到 EngineeringMemory
                            if (this.agentService['memoryService']?.engineering) {
                                this.selfEvaluator.injectEngineering(this.agentService['memoryService'].engineering);
                            }
                            // 微调策略分
                            this.strategizer.getLearner().applySelfEvaluation(strategy.name, selfEval.score);
                            // Phase 3: 自评估 → 元学习引导定向策略变异闭环
                            const trend = this.selfEvaluator.getTrend();
                            const recommendation = this.selfEvaluator.getStrategyRecommendation();
                            if (trend === 'stagnant' || trend === 'downward') {
                                try {
                                    // 元学习检查是否应抑制变异
                                    if (this.metaLearner.shouldSuppressMutation()) {
                                        log('INFO', 'strategy_mutation_suppressed_by_metalearner');
                                    }
                                    else {
                                        // MetaLearner 推荐变异参数（比随机选择更智能）
                                        const metaRec = this.metaLearner.recommendMutationParam({
                                            strategyName: strategy.name,
                                            currentScore: selfEval.score,
                                        });
                                        const targetDim = recommendation.targetDimension || undefined;
                                        const mutation = this.strategizer
                                            .getLearner()
                                            .getMutator()
                                            .mutate(this.strategizer.getLearner().getCycleHistory(), targetDim);
                                        if (mutation) {
                                            // Track in MetaLearner
                                            this.metaLearner.recordMutation({
                                                parentStrategy: mutation.parent,
                                                childStrategy: mutation.child,
                                                paramName: metaRec.paramName || mutation.reason,
                                                oldValue: 'parent',
                                                newValue: mutation.child,
                                                operation: mutation.operation,
                                            });
                                            log('INFO', 'strategy_mutated_from_selfeval', {
                                                parent: mutation.parent,
                                                child: mutation.child,
                                                operation: mutation.operation,
                                                trend,
                                                metaInsight: metaRec.insight,
                                            });
                                        }
                                    }
                                }
                                catch {
                                    log('WARN', 'strategy_mutation_skipped');
                                }
                            }
                            // 记录到 prompt 版本
                            this.promptEvolutionManager.recordCycleResult('analysis_prompt', this.promptEvolutionManager.getCurrentVersion('analysis_prompt'), true, selfEval.score);
                        }
                        catch {
                            log('WARN', 'self_evaluation_skipped');
                        }
                    }
                    else {
                        this.promptEvolutionManager.recordCycleResult('analysis_prompt', this.promptEvolutionManager.getCurrentVersion('analysis_prompt'), false);
                    }
                }
                else {
                    this.tryRunFailures++;
                    if (this.tryRunFailures >= this.maxFailures && this.recoveryCooldownUntil === 0)
                        this.recoveryCooldownUntil = Date.now() + this.intervalMs;
                }
                this.strategizer.evaluate(strategy.name, {
                    success: result.success,
                    durationMs: Date.now() - this.lastRun,
                    planCreated: result.planCreated,
                    stepsPlanned: 0,
                    hadTimeout: result.hadTimeout,
                    hadRetry: result.hadRetry,
                    promptTrimmed: strategy.trimMode,
                });
                // Phase 3: 参数调优 — 应用 tuneParameters 结果
                if (result.success) {
                    const tuningResult = this.strategizer.getLearner().tuneParameters();
                    for (const adj of tuningResult) {
                        if (adj.parameter === 'timeoutMs')
                            this.analyzer.setAnalysisTimeout(adj.newValue);
                        if (adj.parameter === 'trimMode')
                            this.analyzer.setPromptTrimMode(adj.newValue);
                    }
                    if (tuningResult.length > 0) {
                        log('INFO', 'strategy_params_tuned', { adjustments: tuningResult });
                    }
                    // Phase 3: 记录 outcome（演化结果）
                    if (selfEval) {
                        this.selfEvaluator.recordOutcome(selfEval.score, result.planCreated);
                        // Phase 3: 评估器自校准（每轮记录，每 5 轮实际校准一次）
                        this.evaluatorCalibrator.recordSample(selfEval.dimensions, selfEval.score, result.planCreated);
                    }
                    if (this.evaluatorCalibrator.getCalibrationStats().sampleCount % 5 === 0) {
                        const calResult = this.evaluatorCalibrator.calibrate();
                        if (calResult.sampleSize >= 5) {
                            log('INFO', 'evaluator_weights_adjusted', { delta: calResult.delta });
                        }
                    }
                    // Phase 3: 元学习周期增长
                    this.metaLearner.incrementCycle();
                    if (this.metaLearner.getCycleCount() % 5 === 0) {
                        const metaSummary = this.metaLearner.getMetaSummary();
                        if (metaSummary) {
                            log('INFO', 'meta_learning_summary', { insight: metaSummary.insight });
                        }
                    }
                    // Phase 3: prompt 总结/清理
                    for (const slot of ['analysis_prompt', 'system_prompt']) {
                        try {
                            const compact = this.promptEvolutionManager.shouldCompact(slot);
                            if (compact.needSummarize) {
                                this.promptEvolutionManager.summarizeOverlays(slot);
                            }
                            if (compact.needPrune) {
                                this.promptEvolutionManager.pruneStaleRules(slot);
                            }
                        }
                        catch { }
                    }
                }
                this.saveState();
                this.eventBus.emit('evolution.cycle.completed', {
                    success: result.success,
                    summary: result.summary,
                    timestamp: Date.now(),
                    durationMs: Date.now() - this.lastRun,
                });
                // Phase 3: 通知创造力系统本次分析结果
                this.eventBus.emit('evolution.plan.outcome', {
                    success: result.success,
                    summary: result.summary.slice(0, 500),
                    planTitle: result.planSummary?.title,
                    stepsCompleted: result.stepsCompleted ?? 0,
                    stepsTotal: result.stepsTotal ?? 0,
                    hadTimeout: result.hadTimeout,
                    hadRetry: result.hadRetry,
                    durationMs: Date.now() - this.lastRun,
                });
            }
            catch (err) {
                this.tryRunFailures++;
                this.analyzer.setAnalysisTimeout(Math.min(Math.round(this.analyzer.getAnalysisTimeout() * 1.25), 300000));
                this.analyzer.setPromptTrimMode(true);
                this.analyzer.setHistoryMaxEntries(2);
                this.agentService.abortSelfTask?.();
                if (this.tryRunFailures >= this.maxFailures && this.recoveryCooldownUntil === 0)
                    this.recoveryCooldownUntil = Date.now() + Math.min(this.intervalMs, 30 * 60 * 1000);
                this.saveState();
                log('ERROR', 'evolution_cycle_error', { error: String(err), failures: this.tryRunFailures });
                // 即使在 evolution 失败时也尝试执行 cognitive 反馈
                // 使 cognitive 的"暂停目标"建议在超时/失败场景下也能生效
                if (this.cognitiveService) {
                    try {
                        await this.cognitiveService.adjustByToken(this.analyzer.loadRecentFailures());
                    }
                    catch {
                        log('WARN', 'cognitive_adjust_skipped_on_error');
                    }
                }
                this.eventBus.emit('evolution.cycle.completed', {
                    success: false,
                    summary: `Error: ${err.message}`,
                    timestamp: Date.now(),
                    durationMs: Date.now() - this.lastRun,
                });
                this.strategizer.evaluate(strategy.name, {
                    success: false,
                    durationMs: Date.now() - this.lastRun,
                    planCreated: false,
                    stepsPlanned: 0,
                    hadTimeout: true,
                    hadRetry: true,
                    promptTrimmed: strategy.trimMode,
                });
            }
        });
        this.transitionState(EvolutionSchedulerState.IDLE, '分析循环结束');
        // 分析完成后自动触发执行：如果分析创建了计划且有 pending 步骤，立即执行（不等下次心跳）
        if (this.planManager?.getActivePlan() && this.executor.hasPendingStep() && this.safetyMode !== 'review') {
            log('INFO', 'evolution_auto_trigger_execution', { plan_title: this.planManager.getActivePlan()?.title });
            await this.runExecutionCycle();
        }
    }
    // ==================== 执行循环 ====================
    async runExecutionCycle() {
        this.transitionState(EvolutionSchedulerState.EXECUTING, '开始执行步骤');
        this.lastExecutionTime = Date.now();
        this.reviewer.startListen();
        const result = await this.executor.executeNextStep({
            planId: '',
            stepIndex: 0,
            stepDescription: '',
            planCtx: this.planManager?.getFormattedContext() || '',
            cognitiveCtx: this.cognitiveService?.getFormattedContext() || '',
        });
        if (result.success) {
            this.executeFailures = 0;
            this.transitionState(EvolutionSchedulerState.VERIFYING, '步骤完成，开始验证');
            const changedFiles = await this.collectChangedFiles();
            await this.reviewer.verify(changedFiles);
            await this.reviewer.detectRegression(changedFiles);
        }
        else {
            this.executeFailures++;
            if (this.executeFailures >= this.maxFailures && this.recoveryCooldownUntil === 0)
                this.recoveryCooldownUntil = Date.now() + Math.min(this.intervalMs, 30 * 60 * 1000);
            log('WARN', 'evolution_execution_failure', { executeFailures: this.executeFailures });
        }
        this.reviewer.stopAndValidate('execute');
        this.transitionState(EvolutionSchedulerState.IDLE, '执行循环结束');
    }
    // ==================== 首次预热 ====================
    async warmupFirstRun() {
        log('INFO', 'evolution_warmup_start');
        try {
            const result = await withTimeout(() => this.agentService.runSelfTask('【预热测试】请调用 analyze_codebase 快速检查项目状态，然后回复"预热完成"。不要创建计划。', '你是秋山澪的自进化系统。当前是预热模式。请调用 analyze_codebase(quick=true) 然后回复。'), 30000, 'warmup_timeout');
            if (result.success) {
                this.firstRunComplete = true;
                log('INFO', 'evolution_warmup_done');
            }
        }
        catch (err) {
            log('WARN', 'evolution_warmup_failed', { error: String(err) });
        }
    }
    // ==================== 完整性检查 ====================
    performIntegrityCheck() {
        const pm = this.planManager;
        if (!pm)
            return;
        // 自动清理：删除 7 天前完成的计划 + 30 天前放弃的计划
        try {
            const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
            const abandonedCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
            const removed = pm.cleanupOldPlans?.(cutoff, abandonedCutoff) ?? 0;
            if (removed > 0)
                log('INFO', 'evolution_plan_cleanup', { removed });
        }
        catch (err) {
            log('WARN', 'evolution_plan_cleanup_error', { error: String(err) });
        }
        try {
            const checker = new PlanIntegrityChecker();
            const allPlans = pm.listPlans();
            const result = checker.checkAllPlans(allPlans);
            if (!result.passed) {
                log('WARN', 'evolution_integrity_check_failed', { error_count: result.issues.filter((i) => i.severity === 'error').length });
                for (const p of allPlans) {
                    if (p.status === 'active') {
                        const fixResult = checker.autoFix(p);
                        if (fixResult.fixed > 0)
                            for (let i = 0; i < p.steps.length; i++)
                                pm.updateStep(p.id, i, p.steps[i].status, p.steps[i].result);
                    }
                }
            }
        }
        catch (err) {
            log('ERROR', 'evolution_integrity_check_error', { error: String(err) });
        }
    }
    // ==================== 自适应参数恢复 ====================
    handleRecoveryParam() {
        if (this.analyzer.getPromptTrimMode()) {
            this.analyzer.setPromptTrimMode(false);
            log('INFO', 'evolution_param_recovery_promptTrimMode_reset');
        }
        if (this.analyzer.getHistoryMaxEntries() < 5)
            this.analyzer.setHistoryMaxEntries(Math.min(this.analyzer.getHistoryMaxEntries() + 1, 5));
        const timeout = this.analyzer.getAnalysisTimeout();
        if (timeout < 300000 && timeout > 120000)
            this.analyzer.setAnalysisTimeout(Math.max(120000, Math.round(timeout * 0.9)));
        // Phase 3: 连续健康 → 重置 prompt 到基版本
        if (this.consecutiveDegenerateDetections === 0 && this.tryRunFailures === 0) {
            this.consecutiveCleanCycles++;
            if (this.consecutiveCleanCycles >= 2) {
                this.promptEvolutionManager.resetToBase('analysis_prompt');
                this.promptEvolutionManager.resetToBase('system_prompt');
                this.consecutiveCleanCycles = 0;
                log('INFO', 'prompt_reset_clean_cycles');
            }
        }
        else {
            this.consecutiveCleanCycles = 0;
        }
    }
    // ==================== 状态转换 ====================
    transitionState(newState, reason) {
        const oldState = this.schedulerState;
        this.schedulerState = newState;
        log('INFO', 'scheduler_state_transition', { from: oldState, to: newState, reason });
        this.eventBus.emit('evolution.scheduler.state', { from: oldState, to: newState, reason, timestamp: Date.now() });
    }
    // ==================== 辅助方法 ====================
    async collectChangedFiles() {
        try {
            const { EvolutionGitOps } = require('./EvolutionGitOps');
            return await new EvolutionGitOps().collectChangedFiles();
        }
        catch {
            return { newFiles: [], modifiedFiles: [] };
        }
    }
    // ==================== 状态持久化 ====================
    loadState() {
        try {
            if (!existsSync(this.stateFilePath))
                return;
            const state = JSON.parse(readFileSync(this.stateFilePath, 'utf-8'));
            if (typeof state.tryRunFailures === 'number')
                this.tryRunFailures = state.tryRunFailures;
            if (typeof state.executeFailures === 'number')
                this.executeFailures = state.executeFailures;
            if (typeof state.recoveryCooldownUntil === 'number')
                this.recoveryCooldownUntil = state.recoveryCooldownUntil;
            if (typeof state.lastSuccessTime === 'number')
                this.lastSuccessTime = state.lastSuccessTime;
            if (typeof state.analysisTimeoutMs === 'number')
                this.analyzer.setAnalysisTimeout(state.analysisTimeoutMs);
            if (typeof state.promptTrimMode === 'boolean')
                this.analyzer.setPromptTrimMode(state.promptTrimMode);
            if (typeof state.historyMaxEntries === 'number')
                this.analyzer.setHistoryMaxEntries(Math.max(state.historyMaxEntries, 3));
            const fps = state.recentAnalysisFingerprints ?? state.fingerprints;
            if (Array.isArray(fps))
                fps.forEach((fp) => this.analyzer.recordFingerprint(fp));
            log('INFO', 'evolution_state_loaded', {
                tryRunFailures: this.tryRunFailures,
                cooldownActive: this.recoveryCooldownUntil > 0 && Date.now() < this.recoveryCooldownUntil,
            });
        }
        catch {
            log('WARN', 'evolution_state_load_failed');
        }
    }
    saveState() {
        try {
            const state = {
                tryRunFailures: this.tryRunFailures,
                executeFailures: this.executeFailures,
                recoveryCooldownUntil: this.recoveryCooldownUntil,
                lastSuccessTime: this.lastSuccessTime,
                analysisTimeoutMs: this.analyzer.getAnalysisTimeout(),
                promptTrimMode: this.analyzer.getPromptTrimMode(),
                historyMaxEntries: this.analyzer.getHistoryMaxEntries(),
                fingerprints: this.analyzer.getFingerprints(),
                savedAt: Date.now(),
            };
            const dir = dirname(this.stateFilePath);
            if (!existsSync(dir))
                mkdirSync(dir, { recursive: true });
            writeFileSync(this.stateFilePath, JSON.stringify(state, null, 2), 'utf-8');
        }
        catch {
            log('WARN', 'evolution_state_save_failed');
        }
    }
}
SelfEvolutionService.USER_COOLDOWN_MS = 5 * 60 * 1000;
SelfEvolutionService.MIO_ACTIVE_TIMEOUT_MS = 10 * 60 * 1000;
SelfEvolutionService.EVENT_COOLDOWN_MS = 5 * 60 * 1000;
