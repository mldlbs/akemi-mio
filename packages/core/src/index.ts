// ── Logger ──
export { log, initLogFile, getLogFilePath, sanitizeForLog } from "./logger/Logger"

// ── EventBus ──
export { EventBus, eventBus, SubscriptionTracker } from "./core/EventBus"
export type { Priority, OnOptions, EventMeta } from "./core/EventBusTypes"

// ── State ──
export { StateManager } from "./core/StateManager"
export { systemBus } from "./core/SystemBus"

// ── Process / Lifecycle ──
export { ProcessManager } from "./core/ProcessManager"
export { ResourceBudget } from "./core/ResourceBudget"
export { BudgetRebalancer } from "./core/BudgetRebalancer"
export { CircuitBreaker } from "./core/CircuitBreaker"
export { Kernel } from "./core/Kernel"
export { WorkerPool } from "./core/WorkerPool"
export { AgentModule, MemoryModule, EvolutionModule, McpModule } from "./core/kernel-modules"
export { SyscallBus, HealthChecker } from "./core/lifecycle/index"
export type { IModule, SubsystemState } from "./core/lifecycle/types"

// ── Lifecycle ──
export { setupStartupLogging, createWindow, setupWallpaperListener, getMainWindow } from "./core/Lifecycle"
export type { WallpaperDeps } from "./core/Lifecycle"

// ── Model Loader ──
export { loadEnvFile, setupTransformers } from "./core/ModelLoader"

// ── Task Runner ──
export { TaskRunner } from "./core/tasks/unified/TaskRunner"
export type { TaskExecutionResult } from "./core/tasks/unified/TaskTypes"

// ── Event Sourcing ──
export { EventStore } from "./core/event-sourcing/EventStore"

// ── Evaluation ──
export { EventArchiver } from "./core/evaluation/EventArchiver"
export { RetentionScheduler } from "./core/evaluation/RetentionScheduler"
export { EvaluationStore } from "./core/evaluation/EvaluationStore"
export { EvaluationEmitter } from "./core/evaluation/EvaluationEmitter"
export { RepositoryEventIterator } from "./core/evaluation/RepositoryEventIterator"
export { MetricsEngineImpl } from "./core/evaluation/MetricsEngine"
export { ToolEventBridge } from "./core/evaluation/ToolEventBridge"
export { GuardrailPipeline } from "./core/evaluation/GuardrailPipeline"
export { GuardrailProgressConsumer } from "./core/evaluation/progress-consumers/GuardrailProgressConsumer"
export { GuardrailConfigStore } from "./core/evaluation/GuardrailConfigStore"
export { GuardrailDecisionStore } from "./core/evaluation/GuardrailDecisionStore"
export { DEFAULT_GUARDRAIL_POLICY_CONFIG } from "./core/evaluation/GuardrailTypes"
export { ProgressObserver } from "./core/evaluation/ProgressObserver"
export { GuardrailProgressAnalyzer } from "./core/evaluation/GuardrailProgressAnalyzer"
export type { MetricSnapshot, TimeWindow } from "./core/evaluation/types"

// ── Config / Credentials ──
export { WORKSPACE, WORKSPACE_ROOT } from "./config/index"
export { credentialsManager } from "./credentials/CredentialsManager"
// ── Database ──
export { getRawDb, markDirty } from "./db/connection"
export * from "./db/schema"
