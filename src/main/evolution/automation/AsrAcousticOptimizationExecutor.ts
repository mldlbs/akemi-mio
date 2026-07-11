/**
 * AsrAcousticOptimizationExecutor — 声学环境自适应 + A/B 测试执行器
 *
 * 作为 FixExecutor 接入自动化管道：
 * 1. 读取近期识别记录中的环境分类分布
 * 2. 分析主导环境类型 + 该环境下的纠错率
 * 3. 与当前 ASR 提示词配置对比，判断是否需要调整
 * 4. 如果检测到环境变化，生成新的 prompt 配置补丁
 * 5. 通过 AsrEvolutionManager 创建 A/B 测试快照
 *
 * A/B 测试流程：
 * - 变更前：创建快照记录当前纠错率基线
 * - 变更后：应用新的 prompt 配置
 * - 评估：下一周期检查纠错率变化 → 保留/回滚
 *
 * 安全机制：
 * - 仅在采集到足够识别数据时触发（>= MIN_RECORDS_FOR_ENV_ANALYSIS）
 * - 同一环境类型的配置变更间隔 >= COOLDOWN_MS
 * - 纠错率低于基线时不保留变更
 */

import { log } from '../../logger/Logger'
import { asrLogStore } from '../../asr/AsrLogStore'
import { acousticEnvClassifier, type AcousticEnvironment, ENV_LABELS } from '../../asr/AsrAcousticEnvironmentClassifier'
import { asrEvolutionManager } from '../../asr/AsrEvolutionManager'
import type { AsrConfigPatch } from '../../asr/AsrEvolutionManager'
import type { FixExecutor, AssignedProblem, FixResult } from './types'

// =============================================================================
// 配置
// =============================================================================

/** 单次执行最大补丁数 */
const MAX_PATCHES_PER_EXECUTION = 2
/** 执行超时（毫秒） */
const EXECUTION_TIMEOUT_MS = 10000
/** 环境分析所需的最小识别记录数 */
const MIN_RECORDS_FOR_ENV_ANALYSIS = 5
/** 同一环境类型的配置变更冷却时间（毫秒）— 默认 2 小时 */
const COOLDOWN_MS = 2 * 60 * 60 * 1000
/** 分析窗口（毫秒）— 默认 30 分钟 */
const ANALYSIS_WINDOW_MS = 30 * 60 * 1000
/** 纠错率恶化阈值：变更后纠错率超过基线此倍数视为恶化 */
const REGRESSION_RATIO = 1.2

// =============================================================================
// 环境配置变体 — A/B 测试的候选配置
// =============================================================================

/**
 * 不同环境类型的 prompt 变体配置。
 * 每个环境可以有多个变体，Evolution 会轮流测试并择优。
 */
interface EnvPromptVariant {
  /** 变体名称 */
  name: string
  /** initial_prompt 前缀 */
  promptPrefix: string
  /** 描述 */
  description: string
}

const PROMPT_VARIANTS: Record<AcousticEnvironment, EnvPromptVariant[]> = {
  quiet: [
    {
      name: 'standard',
      promptPrefix: '',
      description: '标准配置（无环境修饰）',
    },
  ],
  noisy: [
    {
      name: 'noise_v1',
      promptPrefix: '（背景有噪声，请忽略杂音，专注识别清晰的人声）',
      description: '噪声环境 v1：强提示忽略杂音',
    },
    {
      name: 'noise_v2',
      promptPrefix: '（背景有干扰噪声，请尽量排除杂音，专注于用户语音内容）',
      description: '噪声环境 v2：排除干扰描述',
    },
  ],
  far_field: [
    {
      name: 'far_v1',
      promptPrefix: '（说话人在远处或声音很小，请尽量捕捉微弱人声）',
      description: '远场 v1：捕捉微弱声音',
    },
    {
      name: 'far_v2',
      promptPrefix: '（音量较低，请提高灵敏度，识别小声说话的内容）',
      description: '远场 v2：提高灵敏度描述',
    },
  ],
  music_bg: [
    {
      name: 'music_v1',
      promptPrefix: '（背景有音乐，请区分人声和音乐，只识别说话内容）',
      description: '音乐背景 v1：区分人声',
    },
    {
      name: 'music_v2',
      promptPrefix: '（背景音乐播放中，请忽略伴奏旋律，仅识别语音对话内容）',
      description: '音乐背景 v2：忽略伴奏',
    },
  ],
  reverberant: [
    {
      name: 'reverb_v1',
      promptPrefix: '（环境有回音，请忽略重叠的回声，识别主要语音）',
      description: '混响 v1：忽略回声',
    },
  ],
  unknown: [
    {
      name: 'default',
      promptPrefix: '',
      description: '默认配置',
    },
  ],
}

// =============================================================================
// AsrAcousticOptimizationExecutor
// =============================================================================

export class AsrAcousticOptimizationExecutor implements FixExecutor {
  readonly name = 'AsrAcousticOptimizationExecutor'
  readonly timeoutMs = EXECUTION_TIMEOUT_MS
  readonly supportedSources = ['log'] as const

  private isExecuting = false
  /** 各环境类型的冷却时间戳 */
  private cooldowns = new Map<AcousticEnvironment, number>()
  /** 当前各环境正在测试的变体索引 */
  private variantIndex = new Map<AcousticEnvironment, number>()

  isAvailable(): boolean {
    return !this.isExecuting
  }

  async execute(problem: AssignedProblem): Promise<FixResult> {
    const startedAt = Date.now()
    this.isExecuting = true

    try {
      // 1. 收集近期识别记录中的环境分布
      const since = Date.now() - ANALYSIS_WINDOW_MS
      const recentRecognitions = asrLogStore.getRecognitionsSince(since)

      if (recentRecognitions.length < MIN_RECORDS_FOR_ENV_ANALYSIS) {
        return {
          problemId: problem.id,
          success: true,
          summary: `识别记录不足 ${MIN_RECORDS_FOR_ENV_ANALYSIS} 条（当前 ${recentRecognitions.length}），跳过声学环境分析`,
          durationMs: Date.now() - startedAt,
        }
      }

      // 2. 提取环境分布
      const envDistribution = this.analyzeEnvironmentDistribution(recentRecognitions)
      const dominantEnv = this.findDominantEnvironment(envDistribution)

      if (!dominantEnv || dominantEnv === 'unknown') {
        return {
          problemId: problem.id,
          success: true,
          summary: '未能识别出主导声学环境，跳过优化',
          durationMs: Date.now() - startedAt,
        }
      }

      const envCount = envDistribution.get(dominantEnv) || 0
      const envPct = Math.round((envCount / recentRecognitions.length) * 100)

      // 3. 检查冷却期
      const lastChange = this.cooldowns.get(dominantEnv) || 0
      if (Date.now() - lastChange < COOLDOWN_MS) {
        const remainingMin = Math.round((COOLDOWN_MS - (Date.now() - lastChange)) / 60000)
        return {
          problemId: problem.id,
          success: true,
          summary: `"${ENV_LABELS[dominantEnv]}" 还在冷却中（剩余约 ${remainingMin} 分钟），跳过`,
          durationMs: Date.now() - startedAt,
        }
      }

      // 4. 获取该环境的候选变体
      const variants = PROMPT_VARIANTS[dominantEnv]
      if (!variants || variants.length <= 1) {
        return {
          problemId: problem.id,
          success: true,
          summary: `"${ENV_LABELS[dominantEnv]}" 无可用变体配置（仅有默认），跳过`,
          durationMs: Date.now() - startedAt,
        }
      }

      // 5. 轮转选择下一个变体（Round-robin A/B 测试）
      const currentIdx = this.variantIndex.get(dominantEnv) || 0
      const nextIdx = (currentIdx + 1) % variants.length
      this.variantIndex.set(dominantEnv, nextIdx)

      const selectedVariant = variants[nextIdx]

      // 6. 生成 prompt 配置补丁
      const patches = this.buildPromptPatches(dominantEnv, selectedVariant)
      if (patches.length === 0) {
        return {
          problemId: problem.id,
          success: true,
          summary: '无需生成 prompt 配置补丁',
          durationMs: Date.now() - startedAt,
        }
      }

      // 7. 应用补丁（内部包含创建评估快照）
      const result = asrEvolutionManager.applyPatches(patches)
      if (!result) {
        return {
          problemId: problem.id,
          success: false,
          summary: '应用声学环境优化补丁失败',
          durationMs: Date.now() - startedAt,
          error: 'apply_failed',
        }
      }

      // 记录冷却
      this.cooldowns.set(dominantEnv, Date.now())

      const summary = [
        `【ASR 声学环境自适应 — A/B 测试】`,
        `  主导环境: ${ENV_LABELS[dominantEnv]} (${envPct}%, ${envCount} 条记录)`,
        `  变体: ${selectedVariant.name} — ${selectedVariant.description}`,
        `  评估快照: ${result.snapshotId}`,
        `  将在下一周期评估效果并与基线对比。`,
      ].join('\n')

      log('INFO', 'asr_acoustic_optimization_executed', {
        problemId: problem.id,
        dominantEnv,
        envPct,
        variant: selectedVariant.name,
        snapshotId: result.snapshotId,
        patches: patches.length,
      })

      return {
        problemId: problem.id,
        success: true,
        summary,
        durationMs: Date.now() - startedAt,
        output: JSON.stringify({
          snapshotId: result.snapshotId,
          environment: dominantEnv,
          variant: selectedVariant.name,
        }),
      }
    } catch (err) {
      log('ERROR', 'asr_acoustic_optimization_error', {
        problemId: problem.id,
        error: String(err),
      })
      return {
        problemId: problem.id,
        success: false,
        summary: `声学环境优化异常: ${String(err)}`,
        durationMs: Date.now() - startedAt,
        error: String(err),
      }
    } finally {
      this.isExecuting = false
    }
  }

  // ── 环境分布分析 ──

  /**
   * 从识别记录中统计各环境类型的出现次数。
   */
  private analyzeEnvironmentDistribution(
    records: Array<{ environment?: string }>,
  ): Map<AcousticEnvironment, number> {
    const distribution = new Map<AcousticEnvironment, number>()

    for (const rec of records) {
      const env = (rec.environment || 'unknown') as AcousticEnvironment
      distribution.set(env, (distribution.get(env) || 0) + 1)
    }

    // 如果没有记录带环境标签，整体视为 unknown
    if (distribution.size === 0) {
      distribution.set('unknown', records.length)
    }

    return distribution
  }

  /**
   * 找出现频次最高的环境类型。
   */
  private findDominantEnvironment(distribution: Map<AcousticEnvironment, number>): AcousticEnvironment | null {
    let maxCount = 0
    let dominant: AcousticEnvironment | null = null

    for (const [env, count] of distribution.entries()) {
      if (count > maxCount) {
        maxCount = count
        dominant = env
      }
    }

    return dominant
  }

  // ── 补丁生成 ──

  /**
   * 根据环境类型和选中的变体生成 prompt 配置补丁。
   *
   * 当前实现：
   * - 将 prompt 修饰符作为 "homophone_fix" 类补丁注入，
   *   因为现有 AsrEvolutionManager 的 applySinglePatch 通过 feedUserTextToHotwords 处理。
   *   这不够精确，但在没有独立的 "set_prompt" 补丁类型时是最佳近似。
   *
   * 未来扩展：
   * - 在 AsrConfigPatch 中添加 set_prompt 类型
   * - 让 AsrService.setConversationContext() 响应此变更
   */
  private buildPromptPatches(env: AcousticEnvironment, variant: EnvPromptVariant): AsrConfigPatch[] {
    const patches: AsrConfigPatch[] = []

    if (variant.promptPrefix) {
      patches.push({
        type: 'homophone_fix',
        description: `ASR 声学环境自适应 [${env}]: "${variant.description}"`,
        value: variant.promptPrefix,
      })
    }

    return patches.slice(0, MAX_PATCHES_PER_EXECUTION)
  }
}
