// ── Persona State Manager ──
export { PersonaStateManager } from './PersonaStateManager'

// ── Persona Drift Control ──
export { PersonaDriftControlSystem } from './PersonaDriftControlSystem'

// ── Content Classifier ──
export { classifyContent } from './ContentClassifier'
export type { MessageCategory } from './ContentClassifier'

// ── User Behavior Analyzer ──
export { UserBehaviorAnalyzer, userBehaviorAnalyzer } from './UserBehaviorAnalyzer'

// ── Writing Prompt ──
export * from './writing-prompt'

// ── Runtime / types ──
export { configureAgentPersonaRuntime, resetAgentPersonaRuntime } from './runtime'
export type { RuntimeLogger, RuntimeLogLevel, StoredMessage } from './runtime'