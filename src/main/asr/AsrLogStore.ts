/**
 * AsrLogStore — ASR 识别日志与用户纠正存储
 *
 * 功能：
 * 1. 记录每次 ASR 识别的原文、引擎、耗时
 * 2. 记录用户对识别结果的纠正（原文→修正文）
 * 3. 提供纠错统计（高频错误模式、纠错率变化）
 * 4. 持久化到磁盘，支持自动裁剪
 *
 * 集成点：
 * - AsrService.transcribe() 每次识别后调用 recordRecognition()
 * - AsrService.feedback() 用户修正后调用 recordCorrection()
 * - AsrLogCollector.collect() 读取日志并分析
 */

import { log } from '../logger/Logger'
import { WORKSPACE } from '../config'
import { join, dirname } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'

// =============================================================================
// 类型定义
// =============================================================================

export interface RecognitionRecord {
  /** 唯一标识 */
  id: string
  /** 识别时间戳 */
  timestamp: number
  /** ASR 引擎 */
  engine: 'whisper_gpu' | 'whisper_cpu' | 'baidu'
  /** 识别原文 */
  rawText: string
  /** 请求 ID */
  requestId: string
  /** 音频时长（秒） */
  audioDurationSec: number
  /** 识别耗时（毫秒） */
  inferenceMs: number
  /** 是否存在热词命中 */
  hasHotwordHit: boolean
}

export interface CorrectionRecord {
  /** 唯一标识 */
  id: string
  /** 关联的识别记录 ID */
  recognitionId: string
  /** 纠正时间戳 */
  timestamp: number
  /** ASR 识别错误原文 */
  original: string
  /** 用户/系统修正文 */
  corrected: string
  /** 是否来自用户手动修正（false = 系统后处理修正） */
  isUserCorrection: boolean
}

/**
 * 错误模式（供 LLM 分析使用）
 */
export interface AsrErrorPattern {
  /** ASR 识别错的原文 */
  original: string
  /** 正确文本 */
  corrected: string
  /** 出现次数 */
  frequency: number
  /** 分类：'homophone' | 'new_word' | 'domain_term' | 'noise' | 'unknown' */
  category: string
  /** 最近一次出现时间 */
  lastSeen: number
}

/**
 * ASR 进化评估快照（用于前后对比决定保留/回滚）
 */
export interface AsrEvalSnapshot {
  id: string
  timestamp: number
  /** 拍快照前 N 小时的纠错率 */
  beforeCorrectionRate: number
  /** 拍快照前 N 小时的识别总数 */
  beforeTotalRecognitions: number
  /** 拍快照前 N 小时的纠正数 */
  beforeCorrections: number
  /** 快照时已应用的热词变更描述 */
  appliedChanges: string[]
  /** 状态 */
  status: 'pending' | 'kept' | 'rolled_back'
}

// =============================================================================
// 持久化路径
// =============================================================================

const RECOGNITIONS_FILE = join(WORKSPACE.cache, 'asr-recognitions.json')
const CORRECTIONS_FILE = join(WORKSPACE.cache, 'asr-corrections.json')
const SNAPSHOTS_FILE = join(WORKSPACE.cache, 'asr-eval-snapshots.json')

/** 保留最近 N 条识别记录 */
const MAX_RECOGNITIONS = 5000
/** 保留最近 N 条纠正记录 */
const MAX_CORRECTIONS = 2000
/** 保留最近 N 个评估快照 */
const MAX_SNAPSHOTS = 50

// =============================================================================
// AsrLogStore
// =============================================================================

export class AsrLogStore {
  private recognitions: RecognitionRecord[] = []
  private corrections: CorrectionRecord[] = []
  private snapshots: AsrEvalSnapshot[] = []
  private loaded = false

  // ==================== 初始化 ====================

  load(): void {
    if (this.loaded) return
    this.loadRecognitions()
    this.loadCorrections()
    this.loadSnapshots()
    this.loaded = true
    log('INFO', 'asr_log_store_loaded', {
      recognitions: this.recognitions.length,
      corrections: this.corrections.length,
      snapshots: this.snapshots.length,
    })
  }

  private loadRecognitions(): void {
    try {
      if (!existsSync(RECOGNITIONS_FILE)) return
      const raw = readFileSync(RECOGNITIONS_FILE, 'utf-8')
      const data = JSON.parse(raw)
      if (Array.isArray(data)) {
        this.recognitions = data as RecognitionRecord[]
      }
    } catch (err) {
      log('WARN', 'asr_log_load_recognitions_failed', { error: String(err) })
    }
  }

  private loadCorrections(): void {
    try {
      if (!existsSync(CORRECTIONS_FILE)) return
      const raw = readFileSync(CORRECTIONS_FILE, 'utf-8')
      const data = JSON.parse(raw)
      if (Array.isArray(data)) {
        this.corrections = data as CorrectionRecord[]
      }
    } catch (err) {
      log('WARN', 'asr_log_load_corrections_failed', { error: String(err) })
    }
  }

  private loadSnapshots(): void {
    try {
      if (!existsSync(SNAPSHOTS_FILE)) return
      const raw = readFileSync(SNAPSHOTS_FILE, 'utf-8')
      const data = JSON.parse(raw)
      if (Array.isArray(data)) {
        this.snapshots = data as AsrEvalSnapshot[]
      }
    } catch (err) {
      log('WARN', 'asr_log_load_snapshots_failed', { error: String(err) })
    }
  }

  private saveRecognitions(): void {
    try {
      const dir = dirname(RECOGNITIONS_FILE)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(RECOGNITIONS_FILE, JSON.stringify(this.recognitions, null, 2), 'utf-8')
    } catch (err) {
      log('WARN', 'asr_log_save_recognitions_failed', { error: String(err) })
    }
  }

  private saveCorrections(): void {
    try {
      const dir = dirname(CORRECTIONS_FILE)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(CORRECTIONS_FILE, JSON.stringify(this.corrections, null, 2), 'utf-8')
    } catch (err) {
      log('WARN', 'asr_log_save_corrections_failed', { error: String(err) })
    }
  }

  private saveSnapshots(): void {
    try {
      const dir = dirname(SNAPSHOTS_FILE)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(SNAPSHOTS_FILE, JSON.stringify(this.snapshots, null, 2), 'utf-8')
    } catch (err) {
      log('WARN', 'asr_log_save_snapshots_failed', { error: String(err) })
    }
  }

  // ==================== 记录写入 ====================

  /**
   * 记录一次 ASR 识别结果。
   * 每次 AsrService.transcribe() 完成后调用。
   */
  recordRecognition(record: RecognitionRecord): void {
    this.load()
    this.recognitions.push(record)
    // 裁剪超过上限的旧记录
    if (this.recognitions.length > MAX_RECOGNITIONS) {
      this.recognitions = this.recognitions.slice(-MAX_RECOGNITIONS)
    }
    this.saveRecognitions()
  }

  /**
   * 记录一次用户/系统纠正。
   * 用户对识别结果不满意并修正时调用。
   */
  recordCorrection(correction: CorrectionRecord): void {
    this.load()
    this.corrections.push(correction)
    if (this.corrections.length > MAX_CORRECTIONS) {
      this.corrections = this.corrections.slice(-MAX_CORRECTIONS)
    }
    this.saveCorrections()
  }

  // ==================== 纠正记录工具 ====================

  /**
   * 记录用户对某次识别结果的纠正。
   * 封装 recordCorrection 的便捷方法。
   */
  recordUserFix(recognitionId: string, original: string, correctedText: string): void {
    this.recordCorrection({
      id: `corr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      recognitionId,
      timestamp: Date.now(),
      original,
      corrected: correctedText,
      isUserCorrection: true,
    })
  }

  // ==================== 查询接口 ====================

  /**
   * 获取最近 N 条识别记录。
   */
  getRecentRecognitions(limit = 100): RecognitionRecord[] {
    this.load()
    return this.recognitions.slice(-limit)
  }

  /**
   * 获取最近 N 条纠正记录。
   */
  getRecentCorrections(limit = 100): CorrectionRecord[] {
    this.load()
    return this.corrections.slice(-limit)
  }

  /**
   * 获取指定时间范围内的纠正记录。
   */
  getCorrectionsSince(timestamp: number): CorrectionRecord[] {
    this.load()
    return this.corrections.filter((c) => c.timestamp >= timestamp)
  }

  /**
   * 获取指定时间范围内的识别记录。
   */
  getRecognitionsSince(timestamp: number): RecognitionRecord[] {
    this.load()
    return this.recognitions.filter((r) => r.timestamp >= timestamp)
  }

  /**
   * 获取指定时间窗口内的纠错率。
   * @returns { rate: 纠错数/识别总数, corrections: 纠正数, total: 识别总数 }
   */
  getCorrectionRate(since: number): { rate: number; corrections: number; total: number } {
    this.load()
    const relevantRecognitions = this.recognitions.filter((r) => r.timestamp >= since)
    const relevantCorrections = this.corrections.filter((c) => c.timestamp >= since)
    const total = relevantRecognitions.length
    const corrections = relevantCorrections.length
    return {
      rate: total > 0 ? corrections / total : 0,
      corrections,
      total,
    }
  }

  /**
   * 获取高频错误模式（用于 LLM 分析）。
   * 基于纠正记录，按(original, corrected)分组统计频次。
   */
  getErrorPatterns(since?: number): AsrErrorPattern[] {
    this.load()
    const relevant = since
      ? this.corrections.filter((c) => c.timestamp >= since)
      : this.corrections

    // 按 (original, corrected) 分组
    const patternMap = new Map<string, { original: string; corrected: string; count: number; lastSeen: number }>()
    for (const c of relevant) {
      const key = `${c.original}|${c.corrected}`
      const existing = patternMap.get(key)
      if (existing) {
        existing.count++
        existing.lastSeen = Math.max(existing.lastSeen, c.timestamp)
      } else {
        patternMap.set(key, {
          original: c.original,
          corrected: c.corrected,
          count: 1,
          lastSeen: c.timestamp,
        })
      }
    }

    // 分类并返回
    const patterns: AsrErrorPattern[] = []
    for (const { original, corrected, count, lastSeen } of patternMap.values()) {
      patterns.push({
        original,
        corrected,
        frequency: count,
        category: classifyErrorPattern(original, corrected),
        lastSeen,
      })
    }

    // 按频次降序
    patterns.sort((a, b) => b.frequency - a.frequency)
    return patterns
  }

  // ==================== 评估快照管理 ====================

  /**
   * 创建一个评估快照，记录当前纠错率基线。
   * 在应用 ASR 配置变更前调用。
   */
  createEvalSnapshot(appliedChanges: string[], lookbackHours = 2): AsrEvalSnapshot {
    this.load()
    const since = Date.now() - lookbackHours * 60 * 60 * 1000
    const baseline = this.getCorrectionRate(since)

    const snapshot: AsrEvalSnapshot = {
      id: `eval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      beforeCorrectionRate: baseline.rate,
      beforeTotalRecognitions: baseline.total,
      beforeCorrections: baseline.corrections,
      appliedChanges,
      status: 'pending',
    }

    this.snapshots.push(snapshot)
    if (this.snapshots.length > MAX_SNAPSHOTS) {
      this.snapshots = this.snapshots.slice(-MAX_SNAPSHOTS)
    }
    this.saveSnapshots()

    log('INFO', 'asr_eval_snapshot_created', {
      snapshotId: snapshot.id,
      correctionRate: baseline.rate.toFixed(4),
      totalRecognitions: baseline.total,
      appliedChanges: appliedChanges.length,
    })

    return snapshot
  }

  /**
   * 评估快照：对比当前纠错率与快照基线。
   * @returns 'improved' | 'worsened' | 'unchanged'
   */
  evaluateSnapshot(snapshotId: string, lookbackHours = 2): 'improved' | 'worsened' | 'unchanged' | 'not_found' {
    this.load()
    const snapshot = this.snapshots.find((s) => s.id === snapshotId)
    if (!snapshot) return 'not_found'

    const since = Date.now() - lookbackHours * 60 * 60 * 1000
    const current = this.getCorrectionRate(since)

    // 数据不足则无法判断
    if (current.total < 5) return 'unchanged'

    const before = snapshot.beforeCorrectionRate
    const after = current.rate

    // 纠错率下降 → 改进
    if (after < before * 0.8) return 'improved'
    // 纠错率上升超过 20% → 恶化
    if (after > before * 1.2) return 'worsened'
    return 'unchanged'
  }

  /**
   * 标记快照为保留或回滚。
   */
  updateSnapshotStatus(snapshotId: string, status: 'kept' | 'rolled_back'): boolean {
    const snapshot = this.snapshots.find((s) => s.id === snapshotId)
    if (!snapshot) return false
    snapshot.status = status
    this.saveSnapshots()
    log('INFO', 'asr_eval_snapshot_status', { snapshotId, status })
    return true
  }

  /**
   * 获取所有快照。
   */
  getSnapshots(): AsrEvalSnapshot[] {
    this.load()
    return [...this.snapshots]
  }

  /**
   * 获取待评估的快照（pending 状态）。
   */
  getPendingSnapshots(): AsrEvalSnapshot[] {
    this.load()
    return this.snapshots.filter((s) => s.status === 'pending')
  }

  // ==================== 内部工具 ====================

  /** 清理超过保留期限的记录 */
  prune(maxAgeDays = 30): { removedRecognitions: number; removedCorrections: number } {
    this.load()
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000

    const recBefore = this.recognitions.length
    this.recognitions = this.recognitions.filter((r) => r.timestamp >= cutoff)
    const removedRec = recBefore - this.recognitions.length
    if (removedRec > 0) this.saveRecognitions()

    const corrBefore = this.corrections.length
    this.corrections = this.corrections.filter((c) => c.timestamp >= cutoff)
    const removedCorr = corrBefore - this.corrections.length
    if (removedCorr > 0) this.saveCorrections()

    if (removedRec > 0 || removedCorr > 0) {
      log('INFO', 'asr_log_pruned', { removedRecognitions: removedRec, removedCorrections: removedCorr })
    }
    return { removedRecognitions: removedRec, removedCorrections: removedCorr }
  }

  /** 获取日志统计摘要 */
  getStats(): { totalRecognitions: number; totalCorrections: number; activeSnapshots: number } {
    this.load()
    return {
      totalRecognitions: this.recognitions.length,
      totalCorrections: this.corrections.length,
      activeSnapshots: this.snapshots.filter((s) => s.status === 'pending').length,
    }
  }
}

// =============================================================================
// 错误模式分类（规则引擎，不依赖 LLM）
// =============================================================================

/**
 * 根据原文和修正文对错误模式进行分类。
 * 用于在 AsrErrorPattern 上标注类别。
 */
function classifyErrorPattern(original: string, corrected: string): string {
  if (!original || !corrected) return 'unknown'

  // 完全包含关系 → 可能是漏识别/多识别
  if (corrected.includes(original) || original.includes(corrected)) {
    return 'partial_match'
  }

  // 长度差异过大 → 可能是漏识别
  if (Math.abs(original.length - corrected.length) >= 4) {
    return 'incomplete'
  }

  // 单字差异 → 同音字
  if (original.length === corrected.length) {
    let diffCount = 0
    for (let i = 0; i < original.length; i++) {
      if (original[i] !== corrected[i]) diffCount++
    }
    if (diffCount <= Math.ceil(original.length / 3)) {
      // 检查是否为拼音相似的中文同音字
      if (/[一-鿿]/.test(original) && /[一-鿿]/.test(corrected)) {
        return 'homophone'
      }
    }
  }

  // 包含领域特有的词汇（英文或混合）
  if (/[a-zA-Z]/.test(corrected) && !/[a-zA-Z]/.test(original)) {
    return 'new_word'
  }

  // 修正文本更长或包含额外内容 → 可能是领域术语
  if (corrected.length > original.length + 1) {
    return 'domain_term'
  }

  return 'unknown'
}

// =============================================================================
// 单例
// =============================================================================

/** 全局单例，供 AsrService 和进化管道共享 */
export const asrLogStore = new AsrLogStore()
