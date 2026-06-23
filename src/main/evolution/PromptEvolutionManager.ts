/**
 * PromptEvolutionManager — Prompt 版本管理与演化
 *
 * 管理三类 prompt 槽（analysis_prompt / system_prompt / execution_prompt），
 * 在退化检测时创建新版本（追加反模式指令），恢复时重置回基版本。
 * 纯本地操作，无额外 LLM 调用。
 */

import { log } from '../logger/Logger'
import { WORKSPACE } from '../config'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { withTimeout } from '../utils/async'

export type PromptSlot = 'analysis_prompt' | 'system_prompt' | 'execution_prompt'

export interface PromptVersion {
  name: string
  version: number
  promptOverlay: string
  applicableMode: PromptSlot
  createdAt: number
  appliedCycle?: string
  performanceStats?: {
    totalCycles: number
    successCount: number
    failCount: number
    avgScore: number
  }
  parentVersion: number
  evolutionReason: string
}

interface SlotInfo {
  latestVersion: number
  currentVersion: number
  baseVersion: number
}

interface PromptRegistry {
  version: number
  prompts: Record<string, SlotInfo>
}

const DEFAULT_PROMT_DIR = join(WORKSPACE.evolution, 'prompts')

export class PromptEvolutionManager {
  private promptsDir: string
  private registry!: PromptRegistry
  private versions: Map<string, PromptVersion> = new Map()
  private initialized = false
  private persistenceDirty = false

  constructor(promptsDir?: string) {
    this.promptsDir = promptsDir || DEFAULT_PROMT_DIR
    this.load()
  }

  // ====== 公共 API ======

  /** 获取指定槽位的当前 overlay 文本 */
  getOverlay(mode: PromptSlot): string {
    const slot = this.registry.prompts[mode]
    if (!slot) return ''
    const v = this.versions.get(`${mode}_v${slot.currentVersion}`)
    return v?.promptOverlay || ''
  }

  /** 获取当前版本号 */
  getCurrentVersion(mode: PromptSlot): number {
    return this.registry.prompts[mode]?.currentVersion || 1
  }

  /** 进化 prompt：以当前版本为 parent，追加反模式指令创建新版本 */
  evolvePrompt(mode: PromptSlot, reason: string, antiPatterns: string[]): PromptVersion | null {
    const slot = this.registry.prompts[mode]
    if (!slot) {
      log('WARN', 'prompt_evolve_unknown_slot', { mode })
      return null
    }

    const parentV = this.versions.get(`${mode}_v${slot.currentVersion}`)
    const newVersion = slot.latestVersion + 1
    const currentText = parentV?.promptOverlay || ''

    const newOverlay = currentText
      ? `${currentText}\n\n【进化修正 v${newVersion}】\n${reason}\n${antiPatterns.map((a) => `- ${a}`).join('\n')}`
      : `【进化修正 v${newVersion}】\n${reason}\n${antiPatterns.map((a) => `- ${a}`).join('\n')}`

    const pv: PromptVersion = {
      name: mode,
      version: newVersion,
      promptOverlay: newOverlay,
      applicableMode: mode,
      createdAt: Date.now(),
      parentVersion: parentV?.version || 0,
      evolutionReason: reason,
    }

    this.versions.set(`${mode}_v${newVersion}`, pv)
    slot.latestVersion = newVersion
    slot.currentVersion = newVersion

    this.save()
    log('INFO', 'prompt_evolved', { mode, newVersion, reason, antiPatternCount: antiPatterns.length })
    return pv
  }

  /** 重置到基版本（version 1） */
  resetToBase(mode: PromptSlot): PromptVersion | null {
    const slot = this.registry.prompts[mode]
    if (!slot || slot.currentVersion === slot.baseVersion) return null

    slot.currentVersion = slot.baseVersion
    const base = this.versions.get(`${mode}_v${slot.baseVersion}`)
    this.save()
    log('INFO', 'prompt_reset_to_base', { mode })
    return base || null
  }

  /** LLM 驱动的 prompt 进化：分析近期失败并生成针对性反模式指令 */
  async llmEvolvePrompt(
    mode: PromptSlot,
    reason: string,
    failureSummary: string,
    agentRunner: { runSelfTask: (prompt: string, system?: string) => Promise<{ success: boolean; summary: string }> },
  ): Promise<PromptVersion | null> {
    // Lightweight LLM call to generate targeted anti-patterns
    const llmPrompt = [
      '你是秋山澪自进化系统的 prompt 优化器。',
      '',
      '【当前退化场景】',
      reason,
      '',
      '【近期失败摘要】',
      failureSummary || '（无详细数据）',
      '',
      '请生成 2-3 条具体的、可操作的反模式指令，用于修正进化分析 prompt。',
      '要求：',
      '- 每条指令必须是具体行为约束，而非笼统建议',
      '- 引用具体的分析方向、代码区域或重复模式',
      '- 用中文，每条约 20-40 字',
      '- 格式：每条一行，以 "- " 开头',
      '',
      '例如：',
      '- 如果连续两次分析了相同的模块，第三次必须选择项目根目录下未被分析的子目录',
      '- 避免在每次分析中都检查 config 文件，除非有明确错误日志指向配置问题',
    ].join('\n')

    try {
      const result = await withTimeout(
        () => agentRunner.runSelfTask(llmPrompt, '你是 prompt 优化器。只输出反模式指令列表。'),
        5000,
        'prompt_llm_evolve_timeout',
      )

      if (result.success && result.summary.trim()) {
        // Parse LLM output as anti-pattern lines
        const antiPatterns = result.summary
          .split('\n')
          .map((l) => l.replace(/^-\s*/, '').trim())
          .filter((l) => l.length > 10 && l.length < 200)

        if (antiPatterns.length >= 1) {
          return this.evolvePrompt(mode, `LLM优化: ${reason}`, antiPatterns)
        }
      }
    } catch {
      log('WARN', 'prompt_llm_evolve_fallback', { mode, reason })
    }

    // Fallback: use hard-coded patterns
    return this.evolvePrompt(mode, reason, [
      '避免在超过 2 次分析后继续得出相同的结论',
      '如果连续 3 次得出相同结论，必须选择至少一个新的代码区域进行分析',
      '不要重复分析之前已分析过的模块',
    ])
  }
  recordCycleResult(mode: PromptSlot, version: number, success: boolean, score?: number): void {
    const v = this.versions.get(`${mode}_v${version}`)
    if (!v) return

    if (!v.performanceStats) {
      v.performanceStats = { totalCycles: 0, successCount: 0, failCount: 0, avgScore: 0 }
    }

    const stats = v.performanceStats
    stats.totalCycles++
    if (success) stats.successCount++
    else stats.failCount++
    if (score !== undefined) {
      stats.avgScore = stats.totalCycles === 1 ? score : (stats.avgScore * (stats.totalCycles - 1) + score) / stats.totalCycles
    }

    this.persistenceDirty = true
    this.save()
  }

  /** 将版本链中所有 overlays 总结为简洁规则，创建新版本 */
  summarizeOverlays(mode: PromptSlot): PromptVersion | null {
    const slot = this.registry.prompts[mode]
    if (!slot || slot.latestVersion <= 1) return null

    const rules = new Set<string>()
    for (let v = slot.baseVersion; v <= slot.latestVersion; v++) {
      const pv = this.versions.get(`${mode}_v${v}`)
      if (!pv || !pv.promptOverlay) continue
      for (const line of pv.promptOverlay.split('\n')) {
        const trimmed = line
          .replace(/^-\s*/, '')
          .replace(/^\d+[\.\)]\s*/, '')
          .trim()
        if (trimmed.length > 10 && trimmed.length < 200 && !trimmed.startsWith('【')) {
          rules.add(trimmed)
        }
      }
    }

    if (rules.size === 0) return null

    const merged = Array.from(rules).join('\n')

    const newVersion = slot.latestVersion + 1
    const pv: PromptVersion = {
      name: mode,
      version: newVersion,
      promptOverlay: `【总结 v${newVersion}】\n${merged}`,
      applicableMode: mode,
      createdAt: Date.now(),
      parentVersion: slot.latestVersion,
      evolutionReason: `summarize: ${rules.size} rules from ${slot.latestVersion} versions`,
    }

    this.versions.set(`${mode}_v${newVersion}`, pv)
    slot.latestVersion = newVersion
    slot.currentVersion = newVersion

    this.save()
    log('INFO', 'prompt_overlays_summarized', { mode, version: newVersion, rulesCount: rules.size })
    return pv
  }

  /** 移除低分版本的 overlay 规则，返回清理数 */
  pruneStaleRules(mode: PromptSlot): number {
    const slot = this.registry.prompts[mode]
    if (!slot) return 0

    const current = this.versions.get(`${mode}_v${slot.currentVersion}`)
    if (!current || !current.promptOverlay) return 0

    let removedCount = 0
    for (let v = slot.baseVersion; v <= slot.latestVersion; v++) {
      const pv = this.versions.get(`${mode}_v${v}`)
      if (!pv || v === slot.currentVersion) continue
      const avg = pv.performanceStats?.avgScore
      if (avg !== undefined && avg < 40) {
        const reasonWords = pv.evolutionReason.split(/[\s,，]+/).filter((w: string) => w.length > 2)
        for (const word of reasonWords) {
          const re = new RegExp(`[\\s\\S]*?${word}[\\s\\S]*?(\\n|$)`, 'gi')
          const before = current.promptOverlay.length
          current.promptOverlay = current.promptOverlay.replace(re, '')
          if (current.promptOverlay.length < before) removedCount++
        }
      }
    }

    if (removedCount > 0) {
      this.persistenceDirty = true
      this.save()
      log('INFO', 'prompt_stale_rules_pruned', { mode, removedCount })
    }
    return removedCount
  }

  /** 判断是否需要总结或清理 */
  shouldCompact(mode: PromptSlot): { needSummarize: boolean; needPrune: boolean } {
    const slot = this.registry.prompts[mode]
    if (!slot) return { needSummarize: false, needPrune: false }

    const current = this.versions.get(`${mode}_v${slot.currentVersion}`)
    const overlayLen = current?.promptOverlay?.length || 0

    return {
      needSummarize: overlayLen > 1200 || slot.latestVersion >= 5,
      needPrune: slot.latestVersion > 3,
    }
  }

  /** 状态摘要（日志用） */
  getRegistrySummary(): string {
    const parts: string[] = ['【Prompt 版本状态】']
    for (const [mode, slot] of Object.entries(this.registry.prompts)) {
      const current = this.versions.get(`${mode}_v${slot.currentVersion}`)
      const stats = current?.performanceStats
      const statsStr = stats ? ` | ${stats.successCount}/${stats.totalCycles} 成功 | avgScore=${stats.avgScore?.toFixed(0) || '-'}` : ''
      parts.push(`- ${mode}: v${slot.currentVersion}/${slot.latestVersion}${statsStr}`)
    }
    return parts.join('\n')
  }

  // ====== 持久化 ======

  private load(): void {
    try {
      const idxFile = join(this.promptsDir, 'index.json')
      if (!existsSync(idxFile)) {
        this.seedDefaults()
        return
      }
      const raw = JSON.parse(readFileSync(idxFile, 'utf-8')) as { version: number; prompts: Record<string, SlotInfo> }
      this.registry = { version: raw.version, prompts: raw.prompts || {} }

      for (const [mode, slot] of Object.entries(this.registry.prompts)) {
        for (let v = slot.baseVersion; v <= slot.latestVersion; v++) {
          const vf = join(this.promptsDir, `${mode}_v${v}.json`)
          if (existsSync(vf)) {
            this.versions.set(`${mode}_v${v}`, JSON.parse(readFileSync(vf, 'utf-8')) as PromptVersion)
          }
        }
      }
      this.initialized = true
    } catch {
      log('WARN', 'prompt_registry_load_failed_seeding_defaults')
      this.seedDefaults()
    }
  }

  private save(): void {
    if (!this.persistenceDirty && this.initialized) return
    try {
      if (!existsSync(this.promptsDir)) mkdirSync(this.promptsDir, { recursive: true })

      writeFileSync(
        join(this.promptsDir, 'index.json'),
        JSON.stringify({ version: this.registry.version, prompts: this.registry.prompts }, null, 2),
        'utf-8',
      )

      for (const [key, pv] of this.versions) {
        writeFileSync(join(this.promptsDir, `${pv.name}_v${pv.version}.json`), JSON.stringify(pv, null, 2), 'utf-8')
      }

      this.persistenceDirty = false
    } catch {
      log('WARN', 'prompt_registry_save_failed')
    }
  }

  private seedDefaults(): void {
    this.registry = {
      version: 1,
      prompts: {
        analysis_prompt: { latestVersion: 1, currentVersion: 1, baseVersion: 1 },
        system_prompt: { latestVersion: 1, currentVersion: 1, baseVersion: 1 },
        execution_prompt: { latestVersion: 1, currentVersion: 1, baseVersion: 1 },
      },
    }

    for (const mode of ['analysis_prompt', 'system_prompt', 'execution_prompt'] as PromptSlot[]) {
      this.versions.set(`${mode}_v1`, {
        name: mode,
        version: 1,
        promptOverlay: '',
        applicableMode: mode,
        createdAt: Date.now(),
        parentVersion: 0,
        evolutionReason: 'base',
      })
    }

    this.persistenceDirty = true
    this.initialized = true
    this.save()
  }
}
