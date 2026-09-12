/**
 * AsrVocabEvolutionExecutor — ASR 词表进化执行器（聚类 + 候补生成）
 *
 * 作为 FixExecutor 接入自动化管道：
 * 1. 接收 AsrLogCollector 生成的低置信度片段 Problem
 * 2. 对候补词汇进行聚类（编辑距离去重）
 * 3. 过滤已存在于热词管理器的词条
 * 4. 通过 AsrEvolutionManager 生成补丁
 * 5. （可选）发射事件供 UI 确认
 *
 * 与 AsrOptimizationExecutor 的区别：
 * - AsrOptimizationExecutor: 处理用户已纠正的确定错误 → 直接修复
 * - AsrVocabEvolutionExecutor: 处理低置信度片段 → 聚类 → 候补 → 进化
 *
 * 安全机制：
 * - 候补词长度限制（2–20 字）
 * - 停用词/纯数字/纯标点过滤
 * - 与现有长时词表去重
 * - 编辑距离聚类避免重复添加相似词
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { asrEvolutionManager } from '@akemi-mio/audio/AsrEvolutionManager'
import { asrHotwordManager } from '@akemi-mio/audio/AsrHotwordManager'
import type { AsrConfigPatch } from '@akemi-mio/audio/AsrEvolutionManager'
import type { FixExecutor, AssignedProblem, FixResult } from './types'

// =============================================================================
// 配置
// =============================================================================

/** 单次执行最大补丁数 */
const MAX_PATCHES_PER_EXECUTION = 3
/** 执行超时（毫秒） */
const EXECUTION_TIMEOUT_MS = 15000
/** 候补词汇最小长度 */
const MIN_CANDIDATE_LENGTH = 2
/** 候补词汇最大长度 */
const MAX_CANDIDATE_LENGTH = 20
/** 聚类编辑距离阈值（<= 此值视为相似词） */
const CLUSTER_EDIT_DISTANCE_THRESHOLD = 2
/** 幂等缓存 TTL（毫秒），避免同一候补在 1h 内重复执行 */
const IDEMPOTENCY_TTL_MS = 60 * 60 * 1000

// =============================================================================
// 停用词过滤
// =============================================================================

const CANDIDATE_STOPWORDS = new Set([
  '一个',
  '没有',
  '我们',
  '你们',
  '他们',
  '什么',
  '怎么',
  '为什么',
  '因为',
  '所以',
  '但是',
  '可是',
  '不过',
  '而且',
  '或者',
  '如果',
  '虽然',
  '然而',
  '于是',
  '因此',
  '可以',
  '可能',
  '应该',
  '必须',
  '需要',
  '能够',
  '已经',
  '曾经',
  '正在',
  '将要',
  '一直',
  '还是',
  '就是',
  '只是',
  '不是',
  '不用',
  '不能',
  '不会',
  '不行',
  '不要',
  '这个',
  '那个',
  '这些',
  '那些',
  '这里',
  '那里',
  '哪里',
  '自己',
  '大家',
  '别人',
  '所有',
  '一些',
  '一点',
  '很多',
  '时候',
  '时间',
  '地方',
  '东西',
  '事情',
  '问题',
  '方法',
  '今天',
  '昨天',
  '明天',
  '现在',
  '以前',
  '以后',
  '知道',
  '觉得',
  '认为',
  '希望',
  '喜欢',
  '想要',
  '告诉',
  '请问',
  '帮忙',
  '谢谢',
  '你好',
  '好的',
  '的',
  '了',
  '在',
  '是',
  '有',
  '和',
  '与',
  '或',
  '对',
])

// =============================================================================
// AsrVocabEvolutionExecutor
// =============================================================================

export class AsrVocabEvolutionExecutor implements FixExecutor {
  readonly name = 'AsrVocabEvolutionExecutor'
  readonly timeoutMs = EXECUTION_TIMEOUT_MS
  readonly supportedSources = ['log'] as const

  private isExecuting = false
  /** 最近已处理的候补 key（幂等缓存） */
  private recentCache = new Set<string>()

  isAvailable(): boolean {
    return !this.isExecuting
  }

  async execute(problem: AssignedProblem): Promise<FixResult> {
    const startedAt = Date.now()
    this.isExecuting = true

    try {
      // 校验问题类型
      if (problem.source !== 'log') {
        return {
          problemId: problem.id,
          success: true,
          summary: '不是日志问题，跳过',
          durationMs: Date.now() - startedAt,
        }
      }

      // 提取候补词
      const candidateWord = this.extractCandidateWord(problem)
      if (!candidateWord) {
        return {
          problemId: problem.id,
          success: true,
          summary: '无效候补词汇，跳过',
          durationMs: Date.now() - startedAt,
        }
      }

      // 基本校验
      if (candidateWord.length < MIN_CANDIDATE_LENGTH || candidateWord.length > MAX_CANDIDATE_LENGTH) {
        return {
          problemId: problem.id,
          success: true,
          summary: `候补词长度不合法: "${candidateWord}" (${candidateWord.length} 字)`,
          durationMs: Date.now() - startedAt,
        }
      }

      if (CANDIDATE_STOPWORDS.has(candidateWord)) {
        return {
          problemId: problem.id,
          success: true,
          summary: `候补词为停用词: "${candidateWord}"`,
          durationMs: Date.now() - startedAt,
        }
      }

      if (/^\d+$/.test(candidateWord) || /^[\p{P}\p{S}\s]+$/u.test(candidateWord)) {
        return {
          problemId: problem.id,
          success: true,
          summary: `候补词为纯数字或标点: "${candidateWord}"`,
          durationMs: Date.now() - startedAt,
        }
      }

      // 幂等性检查
      const cacheKey = candidateWord.toLowerCase()
      if (this.recentCache.has(cacheKey)) {
        return {
          problemId: problem.id,
          success: true,
          summary: `"${candidateWord}" 已处理过，跳过重复执行`,
          durationMs: Date.now() - startedAt,
        }
      }

      // 检查是否已存在于热词管理器
      const existingVocab = asrHotwordManager.exportVocabulary()
      const alreadyExists = existingVocab.some((v) => v.word.toLowerCase() === cacheKey)
      if (alreadyExists) {
        return {
          problemId: problem.id,
          success: true,
          summary: `"${candidateWord}" 已存在于热词词表，跳过`,
          durationMs: Date.now() - startedAt,
        }
      }

      // 聚类去重：与现有词表检查编辑距离
      const similarWord = existingVocab.find((v) => levenshteinDistance(v.word.toLowerCase(), cacheKey) <= CLUSTER_EDIT_DISTANCE_THRESHOLD)
      if (similarWord) {
        return {
          problemId: problem.id,
          success: true,
          summary: `"${candidateWord}" 与现有词 "${similarWord.word}" 相似（编辑距离 <= ${CLUSTER_EDIT_DISTANCE_THRESHOLD}），跳过`,
          durationMs: Date.now() - startedAt,
        }
      }

      // 生成补丁
      const patches = this.buildPatches(candidateWord)
      if (patches.length === 0) {
        return {
          problemId: problem.id,
          success: true,
          summary: `无需为 "${candidateWord}" 生成补丁`,
          durationMs: Date.now() - startedAt,
        }
      }

      // 应用补丁
      const result = asrEvolutionManager.applyPatches(patches)
      if (!result) {
        return {
          problemId: problem.id,
          success: false,
          summary: '应用 ASR 词表进化补丁失败（进化管理器不可用）',
          durationMs: Date.now() - startedAt,
          error: 'apply_failed',
        }
      }

      // 记录幂等缓存
      this.recentCache.add(cacheKey)
      setTimeout(() => this.recentCache.delete(cacheKey), IDEMPOTENCY_TTL_MS)

      log('INFO', 'asr_vocab_evolution_executed', {
        problemId: problem.id,
        candidate: candidateWord,
        snapshotId: result.snapshotId,
        patches: patches.length,
      })

      return {
        problemId: problem.id,
        success: true,
        summary: `【ASR 词表进化】\n  将 "${candidateWord}" 添加为热词\n  评估快照: ${result.snapshotId}\n  将在下一周期评估效果。`,
        durationMs: Date.now() - startedAt,
        output: JSON.stringify({ snapshotId: result.snapshotId, candidate: candidateWord }),
      }
    } catch (err) {
      log('ERROR', 'asr_vocab_evolution_error', {
        problemId: problem.id,
        error: String(err),
      })
      return {
        problemId: problem.id,
        success: false,
        summary: `ASR 词表进化异常: ${String(err)}`,
        durationMs: Date.now() - startedAt,
        error: String(err),
      }
    } finally {
      this.isExecuting = false
    }
  }

  /**
   * 从 Problem 中提取候补词文本。
   */
  private extractCandidateWord(problem: AssignedProblem): string | null {
    const metadata = problem.context.metadata

    // 从 asr_original 元数据提取（低置信度片段的主文本）
    if (metadata?.asr_original) {
      return metadata.asr_original.trim()
    }

    // 兜底：从标题提取（"ASR 低置信度: \"xxx\""）
    const titleMatch = problem.title.match(/"([^"]+)"/)
    if (titleMatch) {
      return titleMatch[1].trim()
    }

    return null
  }

  /**
   * 根据候补词生成 ASR 配置补丁。
   * 策略：仅添加为热词（低置信片段不需要同音字修正）。
   */
  private buildPatches(candidate: string): AsrConfigPatch[] {
    const patches: AsrConfigPatch[] = []

    patches.push({
      type: 'hotword_add',
      description: `ASR 词表进化: 添加 "${candidate}" 为热词（来自低置信度片段分析）`,
      value: candidate,
    })

    return patches.slice(0, MAX_PATCHES_PER_EXECUTION)
  }
}

// =============================================================================
// 工具函数
// =============================================================================

/**
 * 计算字符串间的莱文斯坦编辑距离。
 */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = []
  for (let i = 0; i <= m; i++) {
    dp[i] = [i]
  }
  for (let j = 0; j <= n; j++) {
    dp[0][j] = j
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return dp[m][n]
}
