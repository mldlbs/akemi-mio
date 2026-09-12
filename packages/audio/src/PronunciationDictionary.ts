/**
 * PronunciationDictionary — 用户纠错发音字典
 *
 * 存储用户历史纠正过的单词发音，并在 TTS 合成前对文本进行修正替换。
 * 数据持久化通过 MemoryService 的 user_profile（key 前缀 `pronunciation_correction:`）实现。
 *
 * 设计目标：
 * - 用户对某个词的发音不满意并纠正 → 记录到字典
 * - 后续 TTS 输出中自动替换为该修正发音
 * - 支持单字/多词替换，遵循最长匹配优先原则
 *
 * 风险控制：
 * - 所有数据操作 catch 内部异常，不传播到调用方
 * - 词典加载失败时回退为空词典（不影响 TTS 主流程）
 * - 替换操作不修改原始文本内容字符串引用（安全可回溯）
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { MemoryService } from '@akemi-mio/intelligence-memory/MemoryService'
import type { PronunciationCorrection } from './types'

/** Memory 用户画像 key 前缀 */
const PREF_KEY_PREFIX = 'pronunciation_correction:'

/** 默认置信度阈值：低于此值的修正不生效 */
const MIN_CONFIDENCE = 0.5

// ═══════════════════════════════════════════════
//  PronunciationDictionary
// ═══════════════════════════════════════════════

export class PronunciationDictionary {
  private memoryService: MemoryService | null = null

  /** 内存缓存：原始词 → 修正记录（按 confidence 降序，首个生效） */
  private corrections = new Map<string, PronunciationCorrection>()

  /** 编译后的正则（用于文本替换，最长匹配优先排序） */
  private compiledPattern: { pattern: RegExp; replaceFn: (match: string) => string } | null = null

  constructor() {
    log('INFO', 'pronunciation_dict_created')
  }

  /** 注入 MemoryService 引用（由 PreferenceEnhancer 设置） */
  setMemoryService(ms: MemoryService): void {
    this.memoryService = ms
    this.loadFromMemory()
    log('INFO', 'pronunciation_dict_memory_attached')
  }

  // ════════════════════════════════════════════
  //  数据加载
  // ════════════════════════════════════════════

  /**
   * 从 MemoryService 加载所有发音修正记录到内存缓存。
   * 在注入 MemoryService 后自动调用。
   */
  loadFromMemory(): void {
    if (!this.memoryService) return

    try {
      const ms = this.memoryService
      const prefs = ms.getUserPreferences()
      const loaded = new Map<string, PronunciationCorrection>()

      for (const pref of prefs) {
        if (!pref.key.startsWith(PREF_KEY_PREFIX)) continue

        const word = pref.key.slice(PREF_KEY_PREFIX.length)
        if (!word) continue

        const correction: PronunciationCorrection = {
          word,
          corrected: String(pref.value),
          createdAt: pref.updatedAt,
          confidence: pref.confidence,
        }

        // 如果有 context 信息，从 structuredData 解析
        loaded.set(word, correction)
      }

      this.corrections = loaded
      this.rebuildPattern()
      log('INFO', 'pronunciation_dict_loaded', { count: this.corrections.size })
    } catch (err) {
      log('WARN', 'pronunciation_dict_load_failed', { error: String(err) })
    }
  }

  // ════════════════════════════════════════════
  //  增删改
  // ════════════════════════════════════════════

  /**
   * 添加或更新一条发音修正记录。
   *
   * @param word 原始词（如 "行"）
   * @param corrected 修正后的发音读法（如 "型"）
   * @param confidence 置信度 0–1
   * @param context 可选上下文短语
   */
  addCorrection(word: string, corrected: string, confidence = 0.7, context?: string): void {
    if (!word || !corrected || word === corrected) return

    try {
      const correction: PronunciationCorrection = {
        word,
        corrected,
        context,
        createdAt: Date.now(),
        confidence,
      }

      this.corrections.set(word, correction)
      this.rebuildPattern()

      // 持久化到 Memory 用户画像
      if (this.memoryService) {
        this.memoryService.saveUserPreference({
          key: `${PREF_KEY_PREFIX}${word}`,
          value: corrected,
          confidence,
          category: 'language',
          source: 'pronunciation_correction',
          updatedAt: Date.now(),
        })
      }

      log('INFO', 'pronunciation_correction_added', { word, corrected, confidence })
    } catch (err) {
      log('WARN', 'pronunciation_correction_add_failed', { error: String(err) })
    }
  }

  /**
   * 移除一条发音修正记录。
   */
  removeCorrection(word: string): void {
    if (!word) return

    this.corrections.delete(word)
    this.rebuildPattern()
    log('INFO', 'pronunciation_correction_removed', { word })
  }

  /** 获取所有修正记录 */
  getAllCorrections(): PronunciationCorrection[] {
    return Array.from(this.corrections.values()).sort((a, b) => b.createdAt - a.createdAt)
  }

  /** 获取指定词的修正 */
  getCorrection(word: string): PronunciationCorrection | undefined {
    return this.corrections.get(word)
  }

  /** 修正记录数量 */
  get size(): number {
    return this.corrections.size
  }

  // ════════════════════════════════════════════
  //  文本替换
  // ════════════════════════════════════════════

  /**
   * 对输入文本应用所有发音修正。
   * 最长匹配优先，确保先匹配长词再匹配短词，避免"还行"被"行"部分替换。
   *
   * @param text 原始 TTS 输入文本
   * @returns 修正后的文本
   */
  applyToText(text: string): string {
    if (!text || this.corrections.size === 0) return text

    try {
      if (this.compiledPattern) {
        return text.replace(this.compiledPattern.pattern, this.compiledPattern.replaceFn)
      }
      return text
    } catch (err) {
      log('WARN', 'pronunciation_dict_apply_error', { error: String(err) })
      return text
    }
  }

  // ════════════════════════════════════════════
  //  内部
  // ════════════════════════════════════════════

  /**
   * 重建编译后的正则表达式模式字符串。
   *
   * 策略：
   * 1. 将所有待替换词按文本长度降序排列（最长匹配优先）
   * 2. 构建形如 /word1|word2|word3/g 的正则
   * 3. 替换函数返回对应的修正值
   */
  private rebuildPattern(): void {
    if (this.corrections.size === 0) {
      this.compiledPattern = null
      return
    }

    // 按文本长度降序排列（最长匹配优先）
    const sorted = Array.from(this.corrections.entries())
      .filter(([_, c]) => c.confidence >= MIN_CONFIDENCE)
      .sort(([aWord], [bWord]) => bWord.length - aWord.length)

    if (sorted.length === 0) {
      this.compiledPattern = null
      return
    }

    // 构建替换 map 和 pattern
    const replacementMap = new Map(sorted)
    const escapedWords = sorted.map(([word]) => this.escapeRegex(word))
    const pattern = new RegExp(escapedWords.join('|'), 'g')

    this.compiledPattern = {
      pattern,
      replaceFn: (match: string) => replacementMap.get(match)?.corrected ?? match,
    }
  }

  /** 转义正则特殊字符 */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  /** 重置（仅测试用） */
  reset(): void {
    this.corrections.clear()
    this.compiledPattern = null
    log('INFO', 'pronunciation_dict_reset')
  }
}

/** 模块级单例 */
export const pronunciationDictionary = new PronunciationDictionary()
