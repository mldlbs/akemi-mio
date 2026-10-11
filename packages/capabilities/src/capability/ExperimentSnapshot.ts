/**
 * ExperimentSnapshot — 机制涌现 P0 (D3/A4) 环境快照。
 *
 * 快照内容（定案 D3）：
 * - 能力绑定表（capability + contractVersion + provider + tool）
 * - Guardrail policy 版本
 * - LLM 配置 hash（model + apiHost，不含密钥）
 * - mio-agent-runtime 版本
 * - git describe（可选，漂移检测）
 *
 * 纯函数：同一输入 → 同一短 id（sha256 前 12 hex）。
 * 不持久化、不读环境 — 调用方收集材料后传入。
 */
import { createHash } from 'crypto'

export interface SnapshotCapabilityBinding {
  capability: string
  contractVersion: string
  providerId: string
  tool: string
}

export interface ExperimentSnapshotInput {
  capabilityBindings: SnapshotCapabilityBinding[]
  policyVersion: string
  /** model + apiHost 的稳定 hash（调用方计算，本模块不接触密钥） */
  llmConfigHash: string
  runtimeVersion: string
  gitDescribe?: string
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}'
}

/** 排序 + 规范化后的绑定表，保证注册顺序不影响 id */
export function normalizeBindings(bindings: SnapshotCapabilityBinding[]): SnapshotCapabilityBinding[] {
  return [...bindings].sort((a, b) => {
    const ka = `${a.capability}|${a.providerId}|${a.tool}`
    const kb = `${b.capability}|${b.providerId}|${b.tool}`
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
}

/**
 * 计算快照短 id（sha256 前 12 hex）。
 * 空绑定表也产生合法 id（"环境无能力"本身是可区分状态）。
 */
export function computeSnapshotId(input: ExperimentSnapshotInput): string {
  const canonical = stableStringify({
    capabilityBindings: normalizeBindings(input.capabilityBindings),
    policyVersion: input.policyVersion,
    llmConfigHash: input.llmConfigHash,
    runtimeVersion: input.runtimeVersion,
    gitDescribe: input.gitDescribe ?? null,
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 12)
}

/** LLM 配置 hash（只吃公开字段，拒绝密钥字段名） */
export function hashLlmConfig(config: { model?: string; apiHost?: string; apiUrl?: string }): string {
  const model = config.model ?? ''
  const host = config.apiHost ?? config.apiUrl ?? ''
  return createHash('sha256').update(`${model}|${host}`, 'utf8').digest('hex').slice(0, 12)
}
