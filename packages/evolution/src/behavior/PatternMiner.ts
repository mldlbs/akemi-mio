/**
 * PatternMiner — PrefixSpan 频繁序列模式挖掘
 *
 * ## PrefixSpan 算法
 * PrefixSpan（Prefix-projected Sequential pattern mining）是一种无需候选生成的
 * 序列模式挖掘算法。核心思想：递归地在投影数据库上增长前缀，避免显式生成候选集。
 *
 * 本项目中的实现：
 * 1. 从 ToolCallLogStore 读取原始工具调用记录
 * 2. 按 sessionId（工具调用链）分组为序列数据库
 * 3. 用 PrefixSpan 挖掘频繁子序列（长度 2 ~ maxPatternLength）
 * 4. 对每个频繁序列计算置信度、关联类别、参数模板
 * 5. 输出 BehaviorPattern 列表
 *
 * ## 与 BehaviorFeatureExtractor 的区别
 * - BehaviorFeatureExtractor: 2-3 阶 n-gram（仅相邻调用），轻量实时
 * - PatternMiner: PrefixSpan（任意子序列），完备但计算量大，适合后台离线挖掘
 *
 * @module behavior
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { toolCallChainStore } from '@akemi-mio/capabilities/tool/ToolCallChainStore'
import type { CompletedChain } from '@akemi-mio/capabilities/tool/ToolCallChainStore'
import type { MiningConfig, MiningResult, PatternStep, BehaviorPattern } from './types'
import { DEFAULT_MINING_CONFIG } from './types'

// ══════════════════════════════════════════
//  输入类型（PrefixSpan 内部使用）
// ══════════════════════════════════════════

/** 带 sessionID 标记的工具名 */
interface SequenceItem {
  toolName: string
  args: Record<string, any>
  success: boolean
  durationMs: number
}

/** 一条完整的序列（一个 session / 一个工具调用链） */
type Sequence = SequenceItem[]

/** 投影数据库 */
type ProjectedDB = Array<{ sequence: Sequence; offset: number }>

// ══════════════════════════════════════════
//  频繁模式（PrefixSpan 内部中间结果）
// ══════════════════════════════════════════

interface FrequentPattern {
  /** 工具名序列 */
  toolSequence: string[]
  /** 支持度计数 */
  support: number
  /** 原始序列样本（用于提取参数模板，取前 5 条） */
  samples: Array<{
    argsList: Record<string, any>[]
    success: boolean
    durationMs: number
  }>
}

// ══════════════════════════════════════════
//  PatternMiner 实现
// ══════════════════════════════════════════

export class PatternMiner {
  private config: MiningConfig
  private lastMinedAt = 0

  constructor(config?: Partial<MiningConfig>) {
    this.config = { ...DEFAULT_MINING_CONFIG, ...config }
  }

  /** 更新配置 */
  setConfig(partial: Partial<MiningConfig>): void {
    this.config = { ...this.config, ...partial }
  }

  /** 获取配置 */
  getConfig(): Readonly<MiningConfig> {
    return { ...this.config }
  }

  /**
   * 是否应该运行挖掘（检查时间间隔）。
   */
  shouldRun(): boolean {
    return Date.now() - this.lastMinedAt >= this.config.miningIntervalMs
  }

  /**
   * 执行模式挖掘。
   * 步骤：
   * 1. 从 ToolCallLogStore 和 ToolCallChainStore 获取历史数据
   * 2. 构建序列数据库
   * 3. 运行 PrefixSpan
   * 4. 对每个频繁序列计算指标并生成 BehaviorPattern
   *
   * @param existing 已有的模式 ID 集合（用于判断新旧）
   * @returns 挖掘结果和新发现的模式列表
   */
  mine(existing: Set<string> = new Set()): { result: MiningResult; patterns: BehaviorPattern[] } {
    const startTime = Date.now()

    // 1. 构建序列数据库
    const sequences = this.buildSequenceDatabase()
    if (sequences.length < 3) {
      log('INFO', 'pattern_miner_insufficient_data', {
        sequences: sequences.length,
      })
      return {
        result: {
          newPatterns: 0,
          updatedPatterns: 0,
          totalPatterns: 0,
          processedRecords: sequences.reduce((s, seq) => s + seq.length, 0),
          durationMs: Date.now() - startTime,
          minedAt: Date.now(),
        },
        patterns: [],
      }
    }

    // 2. 运行 PrefixSpan
    const frequentPatterns = this.prefixSpan(sequences)

    log('INFO', 'pattern_miner_prefixspan_done', {
      frequentPatterns: frequentPatterns.length,
      sequences: sequences.length,
      durationMs: Date.now() - startTime,
    })

    // 3. 转换为 BehaviorPattern
    const patterns = this.convertToBehaviorPatterns(frequentPatterns, sequences)

    // 4. 统计数据
    let newPatterns = 0
    let updatedPatterns = 0
    for (const p of patterns) {
      if (existing.has(p.id)) {
        updatedPatterns++
      } else {
        newPatterns++
      }
    }

    this.lastMinedAt = Date.now()

    return {
      result: {
        newPatterns,
        updatedPatterns,
        totalPatterns: patterns.length,
        processedRecords: sequences.reduce((s, seq) => s + seq.length, 0),
        durationMs: Date.now() - startTime,
        minedAt: Date.now(),
      },
      patterns,
    }
  }

  // ══════════════════════════════════════════
  //  序列数据库构建
  // ══════════════════════════════════════════

  /**
   * 从 ToolCallChainStore 和 ToolCallLogStore 构建序列数据库。
   * 每个完成链是一条序列。
   */
  private buildSequenceDatabase(): Sequence[] {
    const sequences: Sequence[] = []

    // 从 ToolCallChainStore 获取已完成的链
    // 通过 searchSimilar 的副作用访问 completedChains
    // 这里我们通过全局单例获取已完成链的数据
    try {
      // 使用 ToolCallChainStore 的 searchSimilar 来触发加载
      // 但我们需要直接访问 completedChains 数据
      const chains = this.getCompletedChains()
      for (const chain of chains) {
        if (chain.toolCalls.length < 2) continue
        const seq: Sequence = chain.toolCalls.map((link) => ({
          toolName: link.toolName,
          args: link.args,
          success: link.success,
          durationMs: link.durationMs,
        }))
        sequences.push(seq)
      }
    } catch (err: any) {
      log('WARN', 'pattern_miner_chain_read_failed', { error: err.message })
    }

    // 限制窗口大小
    if (sequences.length > this.config.windowSize) {
      sequences.splice(0, sequences.length - this.config.windowSize)
    }

    return sequences
  }

  /**
   * 通过 ToolCallChainStore 获取已完成链。
   * 使用 searchSimilar 触发加载并读取其 completedChains。
   * 由于 completedChains 是私有属性，通过空查询获取所有链。
   */
  private getCompletedChains(): CompletedChain[] {
    // 使用空字符串查询，获取最相似的链（实际将返回最近链）
    return toolCallChainStore.searchSimilar(' ', 500)
  }

  // ══════════════════════════════════════════
  //  PrefixSpan 核心实现
  // ══════════════════════════════════════════

  /**
   * PrefixSpan 算法主入口。
   *
   * @param sequences 序列数据库
   * @returns 频繁模式列表（按支持度降序）
   */
  private prefixSpan(sequences: Sequence[]): FrequentPattern[] {
    const results: FrequentPattern[] = []

    // Step 1: 扫描数据库，找出所有频繁单项（长度为 1）
    const singleItems = this.scanFrequentItems(sequences)

    // Step 2: 对每个频繁单项递归增长前缀
    for (const [item, count] of singleItems) {
      const prefix: string[] = [item]
      // 收集样本
      const samples = this.collectSamples(item, sequences)
      results.push({
        toolSequence: [...prefix],
        support: count,
        samples,
      })
      // 递归增长
      this.growPrefix(prefix, sequences, results)
    }

    // 按支持度降序排列，只保留长度 >= 2 的模式
    const filtered = results.filter((p) => p.toolSequence.length >= 2).sort((a, b) => b.support - a.support)

    return filtered
  }

  /**
   * 扫描序列数据库，找出所有频繁单项（支持度 >= minSupport）。
   */
  private scanFrequentItems(sequences: Sequence[]): Map<string, number> {
    const itemCounts = new Map<string, number>()

    for (const seq of sequences) {
      const seen = new Set<string>()
      for (const item of seq) {
        if (!seen.has(item.toolName)) {
          seen.add(item.toolName)
          itemCounts.set(item.toolName, (itemCounts.get(item.toolName) || 0) + 1)
        }
      }
    }

    // 过滤非频繁项
    const frequent = new Map<string, number>()
    for (const [item, count] of itemCounts) {
      if (count >= this.config.minSupport) {
        frequent.set(item, count)
      }
    }

    return frequent
  }

  /**
   * 递归增长前缀：对当前前缀构建投影数据库，扫描频繁项，继续递归。
   */
  private growPrefix(prefix: string[], sequences: Sequence[], results: FrequentPattern[]): void {
    if (prefix.length >= this.config.maxPatternLength) return

    // 构建投影数据库
    const projectedDB = this.buildProjectedDB(prefix, sequences)
    if (projectedDB.length === 0) return

    // 扫描投影数据库中的频繁项
    const itemCounts = new Map<string, number>()
    const itemSamples = new Map<string, Array<{ argsList: Record<string, any>[]; success: boolean; durationMs: number }>>()

    for (const { sequence, offset } of projectedDB) {
      const seen = new Set<string>()
      for (let i = offset + 1; i < sequence.length; i++) {
        const item = sequence[i]
        if (!seen.has(item.toolName)) {
          seen.add(item.toolName)
          itemCounts.set(item.toolName, (itemCounts.get(item.toolName) || 0) + 1)
          // 收集样本
          if (!itemSamples.has(item.toolName)) {
            itemSamples.set(item.toolName, [])
          }
          const samples = itemSamples.get(item.toolName)!
          if (samples.length < 5) {
            // 收集从 prefix 到当前项的完整 args 列表
            const argsList: Record<string, any>[] = []
            for (let j = Math.max(0, offset); j <= i; j++) {
              argsList.push(sequence[j].args)
            }
            samples.push({
              argsList,
              success: item.success,
              durationMs: item.durationMs,
            })
          }
        }
      }
    }

    // 对每个频繁项递归
    for (const [item, count] of itemCounts) {
      if (count < this.config.minSupport) continue

      const newPrefix = [...prefix, item]
      const samples = itemSamples.get(item) || []

      results.push({
        toolSequence: newPrefix,
        support: count,
        samples,
      })

      this.growPrefix(newPrefix, sequences, results)
    }
  }

  /**
   * 为给定前缀构建投影数据库。
   * 投影数据库包含每条序列中首次匹配到前缀后的剩余部分。
   */
  private buildProjectedDB(prefix: string[], sequences: Sequence[]): ProjectedDB {
    const db: ProjectedDB = []

    for (const seq of sequences) {
      let offset = -1
      let matched = true

      for (let i = 0; i < prefix.length; i++) {
        const targetTool = prefix[i]
        // 从前一个匹配位置之后查找
        const startIdx = i === 0 ? 0 : offset + 1
        let found = false
        for (let j = startIdx; j < seq.length; j++) {
          if (seq[j].toolName === targetTool) {
            offset = j
            found = true
            break
          }
        }
        if (!found) {
          matched = false
          break
        }
      }

      if (matched) {
        db.push({ sequence: seq, offset })
      }
    }

    return db
  }

  /**
   * 收集某工具的样本数据（用于参数模板提取）。
   */
  private collectSamples(toolName: string, sequences: Sequence[]): FrequentPattern['samples'] {
    const samples: FrequentPattern['samples'] = []

    for (const seq of sequences) {
      if (samples.length >= 5) break
      for (const item of seq) {
        if (item.toolName === toolName && samples.length < 5) {
          samples.push({
            argsList: [item.args],
            success: item.success,
            durationMs: item.durationMs,
          })
          break
        }
      }
    }

    return samples
  }

  // ══════════════════════════════════════════
  //  模式转换
  // ══════════════════════════════════════════

  /**
   * 将 PrefixSpan 输出的频繁模式转换为 BehaviorPattern。
   * 计算每个模式：
   * - 参数模板（从样本中提取常见参数值）
   * - 置信度（成功率）
   * - 关联类别（从 ToolCallChainStore 的链数据推导）
   * - 关联关键词
   */
  private convertToBehaviorPatterns(frequentPatterns: FrequentPattern[], sequences: Sequence[]): BehaviorPattern[] {
    // 获取关联类别映射（工具序列 → 类别列表）
    const categoryMap = this.buildCategoryMap()

    const patterns: BehaviorPattern[] = []

    for (const fp of frequentPatterns) {
      const triggerTool = fp.toolSequence[0]
      const toolSignature = fp.toolSequence
      const patternId = this.generatePatternId(fp.toolSequence)

      // 计算置信度（成功率）
      const successCount = fp.samples.filter((s) => s.success).length
      const confidence = fp.samples.length > 0 ? successCount / fp.samples.length : 0

      // 提取参数模板
      const steps = this.extractStepsWithTemplates(fp)

      // 查找关联类别
      const associatedCategories = this.findAssociatedCategories(fp.toolSequence, categoryMap)

      // 查找关联关键词
      const associatedKeywords = this.extractKeywords(fp.toolSequence, sequences)

      // 计算平均耗时
      const totalDuration = fp.samples.reduce((s, sample) => s + sample.durationMs, 0)
      const avgDurationMs = fp.samples.length > 0 ? Math.round(totalDuration / fp.samples.length) : 0

      patterns.push({
        id: patternId,
        name: `${triggerTool} → ${fp.toolSequence.slice(1).join(' → ')}`,
        steps,
        toolSignature,
        triggerTool,
        frequency: fp.support,
        support: sequences.length > 0 ? fp.support / sequences.length : 0,
        confidence,
        avgDurationMs,
        associatedCategories,
        associatedKeywords,
        enabled: true,
        confirmationThreshold: 0.7,
        createdAt: Date.now(),
        lastMatchedAt: 0,
        notes: '',
      })
    }

    return patterns
  }

  /**
   * 将频繁模式转换为 PatternStep 列表。
   * 从样本中提取最常见参数值作为模板。
   */
  private extractStepsWithTemplates(fp: FrequentPattern): PatternStep[] {
    const steps: PatternStep[] = []

    for (let i = 0; i < fp.toolSequence.length; i++) {
      const toolName = fp.toolSequence[i]
      const paramTemplate: Record<string, string> = {}

      // 从样本中提取最常见的参数值
      const paramValueCounts = new Map<string, Map<string, number>>()

      for (const sample of fp.samples) {
        const argsList = sample.argsList
        const args = argsList[i] || {}
        for (const [key, value] of Object.entries(args)) {
          if (key.startsWith('_')) continue
          if (typeof value !== 'string' || value.length > 200) continue
          if (!paramValueCounts.has(key)) {
            paramValueCounts.set(key, new Map())
          }
          const valueCounts = paramValueCounts.get(key)!
          valueCounts.set(value, (valueCounts.get(value) || 0) + 1)
        }
      }

      for (const [param, valueCounts] of paramValueCounts) {
        let bestValue = ''
        let bestCount = 0
        for (const [value, count] of valueCounts) {
          if (count > bestCount) {
            bestValue = value
            bestCount = count
          }
        }
        if (bestValue && bestCount >= Math.max(2, fp.support * 0.5)) {
          paramTemplate[param] = bestValue
        }
      }

      const stepDescription = this.inferStepDescription(toolName, paramTemplate)

      steps.push({
        toolName,
        paramTemplate,
        description: stepDescription,
        optional: false,
      })
    }

    // 最后几步如果是 readonly 工具，设为 optional
    for (let i = steps.length - 1; i >= Math.max(0, steps.length - 2); i--) {
      const readOnlyTools = ['read_file', 'list_files', 'grep', 'search']
      if (readOnlyTools.includes(steps[i].toolName)) {
        steps[i].optional = true
      }
    }

    return steps
  }

  /**
   * 根据工具名和参数推断步骤说明。
   */
  private inferStepDescription(toolName: string, params: Record<string, string>): string {
    const descriptions: Record<string, string> = {
      grep: '搜索代码',
      read_file: '读取文件',
      write_file: '写入文件',
      edit_file: '编辑文件',
      list_files: '列出文件',
      run_command: '执行命令',
      search: '搜索内容',
      analyze_codebase: '分析代码库',
      remember_fact: '记住信息',
      generate_image: '生成图片',
    }

    const base = descriptions[toolName] || `调用 ${toolName}`
    const paramHint = Object.values(params)
      .filter((v) => v.length < 40)
      .slice(0, 1)
      .join(', ')
    return paramHint ? `${base}: ${paramHint}` : base
  }

  /**
   * 构建工具序列 → 类别映射。
   * 从 ToolCallChainStore 的已存储链中提取。
   */
  private buildCategoryMap(): Map<string, string[]> {
    const map = new Map<string, string[]>()
    try {
      const chains = this.getCompletedChains()
      for (const chain of chains) {
        const sig = chain.toolSequence.join('→')
        if (!map.has(sig)) {
          map.set(sig, [])
        }
        const categories = map.get(sig)!
        if (!categories.includes(chain.category)) {
          categories.push(chain.category)
        }
      }
    } catch {
      // 静默处理
    }
    return map
  }

  /**
   * 查找与工具序列关联的类别。
   */
  private findAssociatedCategories(toolSequence: string[], categoryMap: Map<string, string[]>): string[] {
    const sig = toolSequence.join('→')
    const exact = categoryMap.get(sig)
    if (exact) return exact

    // 模糊匹配：找包含该序列的类别
    const categories = new Set<string>()
    for (const [key, cats] of categoryMap) {
      // 检查 key 是否包含 toolSequence 的全部元素
      let matchIdx = 0
      for (const tool of key.split('→')) {
        if (tool === toolSequence[matchIdx]) {
          matchIdx++
          if (matchIdx >= toolSequence.length) {
            for (const c of cats) categories.add(c)
            break
          }
        }
      }
    }

    return [...categories]
  }

  /**
   * 从序列样本中提取关键词（用于上下文匹配）。
   */
  private extractKeywords(toolSequence: string[], sequences: Sequence[]): string[] {
    const keywordScores = new Map<string, number>()

    for (const seq of sequences) {
      // 检查该序列是否包含 toolSequence
      if (
        !this.containsSubsequence(
          seq.map((s) => s.toolName),
          toolSequence,
        )
      )
        continue

      // 从参数中提取关键词
      for (const item of seq) {
        for (const [, value] of Object.entries(item.args)) {
          if (typeof value !== 'string') continue
          const words = value
            .toLowerCase()
            .split(/[\s,，。、；：！？\n\r\t/\\()（）[\]【\]{}"'「」_]+/)
            .filter((w) => w.length >= 3 && w.length <= 30)
          for (const w of words) {
            keywordScores.set(w, (keywordScores.get(w) || 0) + 1)
          }
        }
      }
    }

    return Array.from(keywordScores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word)
  }

  /**
   * 检查序列 A 是否包含子序列 B（有序、不一定连续）。
   */
  private containsSubsequence(seq: string[], sub: string[]): boolean {
    let si = 0
    for (const tool of seq) {
      if (tool === sub[si]) si++
      if (si >= sub.length) return true
    }
    return false
  }

  /**
   * 生成模式唯一 ID。
   */
  private generatePatternId(toolSequence: string[]): string {
    const sig = toolSequence.join('_')
    const hash = this.simpleHash(sig)
    return `bp_${hash}`
  }

  /**
   * 简单字符串哈希。
   */
  private simpleHash(str: string): string {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const chr = str.charCodeAt(i)
      hash = (hash << 5) - hash + chr
      hash |= 0
    }
    return Math.abs(hash).toString(36).slice(0, 8)
  }
}

// ══════════════════════════════════════════
//  全局单例
// ══════════════════════════════════════════

export const patternMiner = new PatternMiner()
