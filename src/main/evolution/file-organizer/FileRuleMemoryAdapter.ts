/**
 * FileRuleMemoryAdapter — 对话记忆驱动的文件归档规则适配器
 *
 * 职责：
 * 1. 将对话中提取的（文件模式, 目标路径）规则存入 MemoryService
 * 2. 检索所有已存储的归档规则
 * 3. 根据文件路径匹配适用的规则
 * 4. 跟踪规则执行的成功/失败记录
 *
 * 存储方式：
 * - 使用 'user_fact' 类型存入 MemoryService
 * - content 格式: "【文件归档规则】<description>"
 * - structuredData JSON: { filePattern, targetPath, description, sourceText, successCount, failCount, lastAppliedAt, disabled }
 */
import { minimatch } from 'minimatch'
import { getMemoryService } from '../../tool/deps'
import { log } from '../../logger/Logger'

// ===== 类型定义 =====

export interface FileRuleData {
  /** glob 模式，如 "*.pdf"、"reports/**\/*.ts" */
  filePattern: string
  /** 目标目录，如 "documents/reports/" */
  targetPath: string
  /** 人类可读的描述 */
  description: string
  /** 来源对话文本（用户的原话） */
  sourceText: string
  /** 成功执行次数 */
  successCount: number
  /** 失败次数 */
  failCount: number
  /** 最近一次执行的时间戳 */
  lastAppliedAt: number | null
  /** 是否已禁用（由用户主动删除或手动禁用） */
  disabled: boolean
}

export interface FileRuleEntry {
  /** Memory 条目 ID */
  memoryId: string
  /** 规则数据 */
  rule: FileRuleData
  /** 创建时间 */
  createdAt: number
}

/** content 前缀常量 */
const RULE_PREFIX = '【文件归档规则】'

// ===== 适配器 =====

export class FileRuleMemoryAdapter {
  /**
   * 保存一条文件归档规则到记忆系统。
   * 返回新创建的 MemoryEntry ID；重复内容会增强已有条目并返回其 ID。
   */
  saveRule(
    filePattern: string,
    targetPath: string,
    description: string,
    sourceText?: string,
  ): string | null {
    const ms = getMemoryService()
    if (!ms) {
      log('WARN', 'file_rule_memory_unavailable')
      return null
    }

    const content = `${RULE_PREFIX}${description}`
    const ruleData: FileRuleData = {
      filePattern,
      targetPath,
      description,
      sourceText: sourceText || description,
      successCount: 0,
      failCount: 0,
      lastAppliedAt: null,
      disabled: false,
    }

    // 通过 addEntry 的 structuredData 选项一次性写入
    ms.addEntry('user_fact', content, 0.85, {
      tier: 'semi',
      structuredData: JSON.stringify(ruleData),
    })

    // 获取已保存（可能已存在被强化）的条目 ID
    const saved = ms.getEntries().find(
      (e) => e.type === 'user_fact' && e.content === content,
    )
    if (saved) {
      log('INFO', 'file_rule_saved', {
        memoryId: saved.id,
        filePattern,
        targetPath,
        description: description.slice(0, 60),
      })
      return saved.id
    }

    log('WARN', 'file_rule_save_not_found')
    return null
  }

  /**
   * 获取所有已存储的文件归档规则。
   */
  getAllRules(): FileRuleEntry[] {
    const ms = getMemoryService()
    if (!ms) return []

    return ms
      .getEntries()
      .filter(
        (e) =>
          e.type === 'user_fact' &&
          e.content.startsWith(RULE_PREFIX) &&
          e.structuredData,
      )
      .map((e) => {
        try {
          const ruleData = JSON.parse(e.structuredData!) as FileRuleData
          return {
            memoryId: e.id,
            rule: ruleData,
            createdAt: e.createdAt,
          }
        } catch {
          return null
        }
      })
      .filter((r): r is FileRuleEntry => r !== null)
  }

  /**
   * 获取与文件路径匹配的所有非禁用规则。
   * @param filePath 相对于项目根目录的文件路径
   */
  getMatchingRules(filePath: string): FileRuleEntry[] {
    const allRules = this.getAllRules()
    return allRules.filter((entry) => {
      if (entry.rule.disabled) return false
      try {
        return minimatch(filePath, entry.rule.filePattern, { dot: true })
      } catch {
        return false
      }
    })
  }

  /**
   * 记录一次规则执行结果（成功/失败）。
   * 更新对应 MemoryEntry 的 structuredData 中的统计字段。
   */
  recordResult(memoryId: string, success: boolean): boolean {
    const ms = getMemoryService()
    if (!ms) return false

    const entry = ms.getEntries().find((e) => e.id === memoryId)
    if (!entry || !entry.structuredData) return false

    try {
      const ruleData = JSON.parse(entry.structuredData) as FileRuleData
      if (success) {
        ruleData.successCount++
      } else {
        ruleData.failCount++
      }
      ruleData.lastAppliedAt = Date.now()

      ms.setEntryStructuredData(memoryId, JSON.stringify(ruleData))
      log('INFO', 'file_rule_result_recorded', {
        memoryId,
        success,
        totalSuccess: ruleData.successCount,
        totalFail: ruleData.failCount,
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * 删除（软禁用）一条规则。
   * 将 disabled 设为 true，不会物理删除记忆条目。
   */
  deleteRule(memoryId: string): boolean {
    const ms = getMemoryService()
    if (!ms) return false

    const entry = ms.getEntries().find((e) => e.id === memoryId)
    if (!entry || !entry.structuredData) return false

    try {
      const ruleData = JSON.parse(entry.structuredData) as FileRuleData
      ruleData.disabled = true

      ms.setEntryStructuredData(memoryId, JSON.stringify(ruleData))
      log('INFO', 'file_rule_disabled', { memoryId })
      return true
    } catch {
      return false
    }
  }

  /**
   * 获取规则执行的统计摘要。
   */
  getStats(): {
    total: number
    active: number
    disabled: number
    totalSuccess: number
    totalFail: number
  } {
    const allRules = this.getAllRules()
    const active = allRules.filter((r) => !r.rule.disabled)
    const disabled = allRules.filter((r) => r.rule.disabled)

    return {
      total: allRules.length,
      active: active.length,
      disabled: disabled.length,
      totalSuccess: allRules.reduce((s, r) => s + r.rule.successCount, 0),
      totalFail: allRules.reduce((s, r) => s + r.rule.failCount, 0),
    }
  }
}

/** 全局单例 */
export const fileRuleMemoryAdapter = new FileRuleMemoryAdapter()
