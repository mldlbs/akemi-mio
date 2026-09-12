/**
 * Piper TTS 推理链 — 模块入口
 *
 * 反向应用 Experiment 43 (ASR 推理链) 的中断恢复流程模式，
 * 使 PiperTTS 的故障恢复具备与 ASR 同等的分步推理 + 中断恢复能力。
 *
 * 导出所有推理链相关的类型、执行器单例。
 */

export { PiperReasoningChainExecutor, piperReasoningChainExecutor } from './PiperReasoningChainExecutor'

export type {
  PiperReasoningChain,
  PiperReasoningStep,
  PiperReasoningContext,
  PiperStepResult,
  PiperChainSummary,
  PiperFailureCategory,
  PiperFailureSeverity,
  PiperRecoveryOption,
} from './types'
