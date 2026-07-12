/**
 * VoiceFileOrganizerBridge — 语音辅助文件整理桥接器
 *
 * 核心职责：
 * 1. 在文件扫描循环中激活 ASR 语音监听
 * 2. 将 ASR 转写文本交给 FileOrganizationIntentExtractor 解析
 * 3. 将解析后的意图映射到文件整理执行器（FileOrganizerExecutor）
 * 4. 高风险操作触发语音确认流程
 * 5. 集成趋势信号辅助类别建议
 *
 * 设计原则：
 * - ASR 监听有超时保护（避免无限等待）
 * - 低置信度意图 → 语音确认闭环
 * - 不修改现有文件组织器的核心逻辑
 * - 所有语音处理都记录到 logger
 */

import { log } from '../../logger/Logger'
import type { AsrService } from '../../asr/AsrService'
import type { LlmService } from '../../llm/LlmService'
import { fileScanner } from './FileScanner'
import { fileOrganizationIntentExtractor } from './FileOrganizationIntentExtractor'
import type { VoiceFileIntent } from './FileOrganizationIntentExtractor'
import { genePool } from './GenePool'
import { minimatch } from 'minimatch'
import type { FileFeatures } from './types'

// =============================================================================
// 类型定义
// =============================================================================

/** 语音整理会话配置 */
export interface VoiceFileOrganizerConfig {
  /** ASR 监听超时（毫秒），默认 8000 */
  listenTimeoutMs: number
  /** 确认超时（毫秒），默认 10000 */
  confirmTimeoutMs: number
  /** 是否在每次扫描时启用语音监听 */
  enabled: boolean
  /** 只有当待整理文件数超过此阈值时才激活语音，默认 1 */
  minFilesToActivate: number
  /** 是否在语音命令后自动创建目录 */
  autoCreateDirectory: boolean
}

/** 语音整理会话结果 */
export interface VoiceFileOrganizerResult {
  /** 是否成功处理 */
  success: boolean
  /** 已处理的文件数 */
  filesOrganized: number
  /** 摘要信息 */
  summary: string
  /** 详细步骤记录 */
  steps: VoiceFileOrganizerStep[]
  /** 语音识别原始文本（如果有） */
  voiceText?: string
  /** 解析出的意图（如果有） */
  intent?: VoiceFileIntent
  /** 建议的分类标签（来自趋势信号） */
  suggestedCategories?: string[]
}

/** 单步操作记录 */
export interface VoiceFileOrganizerStep {
  /** 操作描述 */
  action: string
  /** 源文件路径 */
  sourceFile: string
  /** 目标路径 */
  targetPath: string
  /** 是否成功 */
  success: boolean
  /** 错误信息 */
  error?: string
}

// =============================================================================
// 趋势信号 → 类别建议
// =============================================================================

/** 内置常见类别建议 — 当趋势信号不可用时使用 */
const BUILTIN_CATEGORIES = [
  { keyword: '文档', related: ['document', 'doc', 'report', '报告', 'docx', 'pdf', '文件'] },
  { keyword: '图片', related: ['image', 'img', 'photo', '照片', '截图', 'png', 'jpg'] },
  { keyword: '资料', related: ['material', '参考', 'reference', 'info', '信息'] },
  { keyword: '归档', related: ['archive', 'backup', '备份', 'old', '旧'] },
  { keyword: '项目', related: ['project', '项目', 'work', '工作'] },
  { keyword: '学习', related: ['study', '学习', 'course', '课程', 'tutorial'] },
]

// =============================================================================
// VoiceFileOrganizerBridge
// =============================================================================

export class VoiceFileOrganizerBridge {
  private asrService: AsrService | null = null
  private llmService: LlmService | null = null

  /** 当前配置 */
  private config: VoiceFileOrganizerConfig = {
    listenTimeoutMs: 8000,
    confirmTimeoutMs: 10000,
    enabled: false,
    minFilesToActivate: 1,
    autoCreateDirectory: true,
  }

  /** 是否正在监听语音 */
  private _isListening = false

  /** 当前会话的扫描结果缓存 */
  private currentScanFiles: FileFeatures[] = []

  constructor() {
    // 初始化时连接意图提取器
    // LLM 服务稍后通过 setLlmService 设置
  }

  // ============================================================================
  // 配置
  // ============================================================================

  /** 设置 ASR 服务引用 */
  setAsrService(service: AsrService): void {
    this.asrService = service
  }

  /** 设置 LLM 服务引用 */
  setLlmService(service: LlmService): void {
    this.llmService = service
    fileOrganizationIntentExtractor.setLlmService(service)
  }

  /** 更新配置 */
  updateConfig(partial: Partial<VoiceFileOrganizerConfig>): void {
    this.config = { ...this.config, ...partial }
    log('INFO', 'voice_file_organizer_config_updated', { ...this.config })
  }

  /** 获取当前配置 */
  getConfig(): Readonly<VoiceFileOrganizerConfig> {
    return { ...this.config }
  }

  /** 是否正在监听语音 */
  get isListening(): boolean {
    return this._isListening
  }

  // ============================================================================
  // 核心接口：文件扫描时激活
  // ============================================================================

  /**
   * 在文件扫描后激活语音辅助整理。
   * 这是 FileOrganizerCollector 调用的主入口。
   *
   * @param scanResult 当前扫描结果（可选，不传则使用 fileScanner 的结果）
   * @returns 整理结果
   */
  async activateOnScan(scanResult?: FileFeatures[]): Promise<VoiceFileOrganizerResult> {
    const files = scanResult || fileScanner.getLastResult()
    this.currentScanFiles = files

    if (!this.config.enabled || !this.asrService) {
      return {
        success: true,
        filesOrganized: 0,
        summary: '语音文件整理已禁用或 ASR 未就绪',
        steps: [],
      }
    }

    if (files.length < this.config.minFilesToActivate) {
      return {
        success: true,
        filesOrganized: 0,
        summary: `文件数 (${files.length}) 未达到激活阈值 (${this.config.minFilesToActivate})`,
        steps: [],
      }
    }

    log('INFO', 'voice_file_organizer_activate', {
      filesScanned: files.length,
      listenTimeoutMs: this.config.listenTimeoutMs,
    })

    // 步骤 1: 获取趋势信号类别建议（异步，不阻塞）
    const suggestedCategories = await this.fetchTrendCategories()

    // 步骤 2: 激活 ASR 监听
    const voiceText = await this.listenForCommand()
    if (!voiceText) {
      return {
        success: true,
        filesOrganized: 0,
        summary: '未检测到语音命令',
        steps: [],
        suggestedCategories,
      }
    }

    // 步骤 3: 意图提取
    const intent = await fileOrganizationIntentExtractor.extract(voiceText)

    // 如果意图置信度过低，直接返回
    if (intent.action === 'unknown' || intent.confidence < 0.3) {
      return {
        success: false,
        filesOrganized: 0,
        summary: '无法理解语音命令，请重试',
        steps: [],
        voiceText,
        intent,
        suggestedCategories,
      }
    }

    // 步骤 4: 高风险操作 → 语音确认
    if (intent.riskLevel === 'high') {
      log('INFO', 'voice_file_organizer_high_risk_confirm', { intent: intent.action, confidence: intent.confidence })
      const confirmed = await this.confirmHighRiskOperation(intent)
      if (!confirmed) {
        return {
          success: false,
          filesOrganized: 0,
          summary: '高风险操作未获确认，已取消',
          steps: [],
          voiceText,
          intent,
          suggestedCategories,
        }
      }
    }

    // 步骤 5: 执行文件整理
    const result = await this.executeVoiceIntent(intent, files)

    return {
      ...result,
      voiceText,
      intent,
      suggestedCategories,
    }
  }

  // ============================================================================
  // ASR 语音监听
  // ============================================================================

  /**
   * 激活 ASR 语音监听，等待用户语音输入。
   * 有超时保护，超时返回空字符串。
   *
   * 实际实现中，ASR 监听由 AudioService 从麦克风采集音频，
   * 然后调用 AsrService.transcribe() 进行识别。
   * 这里使用 setTimeout 模拟超时保护。
   */
  private async listenForCommand(): Promise<string> {
    if (!this.asrService) return ''

    this._isListening = true
    log('INFO', 'voice_file_organizer_listening_start', {
      timeoutMs: this.config.listenTimeoutMs,
    })

    try {
      // 实际集成需要从麦克风获取音频数据。
      // 这里通过 Promise.race 实现超时保护：
      // 1. waitForVoiceCommand() 等待外部语音事件（由 AudioService 触发）
      // 2. 超时后返回空字符串
      const text = await Promise.race([
        this.waitForVoiceCommand(),
        this.timeout(this.config.listenTimeoutMs, '语音监听超时'),
      ])

      if (text) {
        log('INFO', 'voice_file_organizer_transcribed', {
          text: text.slice(0, 100),
          length: text.length,
        })
      }

      return text
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === '语音监听超时') {
        log('INFO', 'voice_file_organizer_timeout')
      } else {
        log('WARN', 'voice_file_organizer_listen_error', { error: msg })
      }
      return ''
    } finally {
      this._isListening = false
    }
  }

  /**
   * 等待外部语音输入事件。
   * 当前为桩实现，返回空字符串（表示"无语音输入"）。
   *
   * TODO: 集成 AudioService 麦克风采集 + AsrService.transcribe()。
   * 实际流程：
   * 1. AudioService.startCapture() 开始从麦克风采集音频
   * 2. 采集到足够的音频后调用 AsrService.transcribe(buffer)
   * 3. 返回识别文本
   */
  private async waitForVoiceCommand(): Promise<string> {
    // 桩实现：当前返回空字符串（无语音输入）
    // 实际集成时需对接 AudioService 和麦克风采集
    //
    // 临时方案：可以使用一个 "永不 resolve" 的 Promise
    // 让超时机制接管（即跳过语音监听）
    return new Promise<string>((resolve) => {
      // 设置一个极短的延迟，允许外部通过事件机制注入语音文本。
      // 在实际集成前，这个 Promise 不会被 resolve。
      // 超时机制会先触发并返回空字符串。
      setTimeout(() => resolve(''), 100)
    })
  }

  // ============================================================================
  // 高风险确认
  // ============================================================================

  /**
   * 高风险操作语音确认。
   * 向用户播报待确认的操作，等待用户语音确认或拒绝。
   */
  private async confirmHighRiskOperation(intent: VoiceFileIntent): Promise<boolean> {
    log('INFO', 'voice_file_organizer_confirm_required', {
      operation: intent.action,
      category: intent.targetCategory,
    })

    // 模拟语音确认流程：
    // 1. TTS 播报："你确定要将文件移动到 [类别] 吗？请说是或否"
    // 2. ASR 监听用户回答
    // 3. 关键词匹配（是/否/确定/取消）
    //
    // 当前实现：默认确认（先假设用户确认）
    // TODO: 集成 TTS 播报 + ASR 二次监听

    // 确认超时保护
    try {
      const response = await Promise.race([
        this.waitForVoiceConfirmation(),
        this.timeout(this.config.confirmTimeoutMs, '确认超时'),
      ])

      const normalized = response.trim().toLowerCase()
      const isConfirmed = /^(是|确|好|行|对|嗯|yes|ok|y|sure|confirm)$/i.test(normalized)

      log('INFO', 'voice_file_organizer_confirm_result', {
        response: response.slice(0, 50),
        confirmed: isConfirmed,
      })

      return isConfirmed
    } catch {
      log('INFO', 'voice_file_organizer_confirm_timeout')
      return false
    }
  }

  /**
   * 等待用户语音确认。
   * 当前为桩实现。
   *
   * TODO: 集成 ASR 二次监听 + 关键词匹配
   */
  private async waitForVoiceConfirmation(): Promise<string> {
    return new Promise<string>((resolve) => {
      setTimeout(() => resolve(''), 100)
    })
  }

  // ============================================================================
  // 意图执行
  // ============================================================================

  /**
   * 根据语音意图执行文件整理。
   * 将解析出的意图映射到具体的文件操作。
   */
  private async executeVoiceIntent(
    intent: VoiceFileIntent,
    files: FileFeatures[],
  ): Promise<VoiceFileOrganizerResult> {
    const steps: VoiceFileOrganizerStep[] = []
    const targetDir = this.normalizeCategoryPath(intent.targetCategory)

    // 匹配文件：先用 inferredFileName 精确匹配，再用 targetFileDescription 模糊匹配
    const matchedFiles = this.matchFiles(intent, files)

    if (matchedFiles.length === 0) {
      return {
        success: false,
        filesOrganized: 0,
        summary: `未找到匹配 "${intent.targetFileDescription}" 的文件`,
        steps: [],
      }
    }

    let successCount = 0
    let failCount = 0

    for (const file of matchedFiles) {
      try {
        // 获取基因池规则的最佳匹配（用于验证类别建议）
        const bestRule = genePool.findBestRule(file)
        const ruleTarget = bestRule
          ? genePool.expandTargetTemplate(bestRule.action.target, file)
          : null

        // 如果规则建议的目录与语音指定的不同，记录日志但不阻止
        if (ruleTarget && ruleTarget.replace(/\/+$/, '') !== targetDir.replace(/\/+$/, '')) {
          log('INFO', 'voice_file_organizer_rule_mismatch', {
            file: file.path,
            voiceCategory: targetDir,
            ruleSuggestion: ruleTarget,
          })
        }

        // 构造目标路径
        const targetPath = targetDir.replace(/\/+$/, '') + '/' + file.name

        // TODO: 实际文件移动由 FileOrganizerExecutor 执行
        // 当前记录结果但不实际执行移动（避免开发环境误操作）
        // 在实际部署时取消注释以下代码：
        // const execResult = await fileOrganizerExecutor.execute({
        //   id: `voice_${Date.now()}`,
        //   file: file.path,
        //   context: {
        //     raw: `语音整理: ${intent.rawText}`,
        //     metadata: {
        //       ruleId: `voice:${Date.now()}`,
        //       ruleSource: 'voice',
        //       targetDir,
        //     },
        //   },
        // } as any)

        steps.push({
          action: `${intent.action} → ${targetDir}`,
          sourceFile: file.path,
          targetPath,
          success: true,
        })
        successCount++
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        steps.push({
          action: `${intent.action} → ${targetDir}`,
          sourceFile: file.path,
          targetPath: '',
          success: false,
          error: errorMsg,
        })
        failCount++
      }
    }

    const summary = failCount > 0
      ? `已整理 ${successCount} 个文件，${failCount} 个失败`
      : `已成功整理 ${successCount} 个文件到 ${targetDir}`

    log('INFO', 'voice_file_organizer_exec_done', {
      successCount,
      failCount,
      targetDir,
      action: intent.action,
    })

    return {
      success: failCount === 0,
      filesOrganized: successCount,
      summary,
      steps,
    }
  }

  // ============================================================================
  // 文件匹配
  // ============================================================================

  /**
   * 根据意图匹配扫描到的文件。
   * 匹配优先级：inferredFileName 精确匹配 > 描述词模糊匹配 > 扩展名匹配
   */
  private matchFiles(intent: VoiceFileIntent, files: FileFeatures[]): FileFeatures[] {
    if (files.length === 0) return []

    const desc = intent.targetFileDescription.toLowerCase()
    const inferred = intent.inferredFileName?.toLowerCase()

    // 1. 优先精确匹配 inferredFileName
    if (inferred) {
      const exact = files.filter((f) => f.name.toLowerCase() === inferred)
      if (exact.length > 0) {
        return exact
      }
      // glob 匹配
      try {
        const globMatch = files.filter((f) => {
          try { return minimatch(f.name, inferred, { dot: true }) } catch { return false }
        })
        if (globMatch.length > 0) return globMatch
      } catch { /* ignore */ }
    }

    // 2. 描述词模糊匹配
    const descWords = desc.split(/[\s,，、和与及/_\-]+/).filter(Boolean)
    if (descWords.length > 0) {
      const fuzzy = files.filter((f) => {
        const lowerName = f.name.toLowerCase()
        const lowerStem = f.stem.toLowerCase()
        return descWords.some(
          (w) => lowerName.includes(w) || lowerStem.includes(w) || f.extension.includes(w),
        )
      })
      if (fuzzy.length > 0) return fuzzy
    }

    // 3. 扩展名匹配
    if (desc.includes('.')) {
      const ext = '.' + desc.split('.').pop()?.replace(/[^a-zA-Z0-9]/g, '')
      if (ext.length > 1) {
        const extMatch = files.filter((f) => f.extension === ext.toLowerCase())
        if (extMatch.length > 0) return extMatch
      }
    }

    // 4. 如果描述词含有常见文件类型关键词，按扩展名匹配
    const extMap: Record<string, string[]> = {
      '图片|照片|截图|image|photo|picture|img': ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico'],
      '文档|doc|document|报告|report|txt|文字': ['.md', '.txt', '.doc', '.docx', '.pdf', '.rtf'],
      '代码|code|source|src|脚本|script': ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java'],
      '音频|audio|音乐|music|sound|录音': ['.mp3', '.wav', '.ogg', '.flac', '.aac'],
      '视频|video|movie|film|录像': ['.mp4', '.avi', '.mkv', '.mov', '.webm'],
      '压缩|zip|archive|压缩包': ['.zip', '.tar', '.gz', '.7z', '.rar'],
    }
    for (const [key, exts] of Object.entries(extMap)) {
      if (new RegExp(key, 'i').test(desc)) {
        const extMatch = files.filter((f) => exts.includes(f.extension))
        if (extMatch.length > 0) return extMatch
      }
    }

    // 5. 返回第一个未归类的大文件（兜底）
    const uncategorized = files.filter((f) => f.depth <= 1)
    if (uncategorized.length > 0) return [uncategorized[0]]

    return [files[0]]
  }

  // ============================================================================
  // 类别路径处理
  // ============================================================================

  /**
   * 将用户口语化的类别名标准化为目录路径。
   * 例: "文档" → "documents/", "图片" → "assets/images/"
   */
  private normalizeCategoryPath(category: string): string {
    const map: Record<string, string> = {
      '文档': 'documents/',
      'documents': 'documents/',
      'docs': 'documents/',
      'document': 'documents/',
      '报告': 'reports/',
      'reports': 'reports/',
      'report': 'reports/',
      '图片': 'assets/images/',
      'images': 'assets/images/',
      'image': 'assets/images/',
      '照片': 'assets/images/',
      'img': 'assets/images/',
      '音频': 'assets/audio/',
      'audio': 'assets/audio/',
      '音乐': 'assets/audio/',
      '视频': 'assets/video/',
      'video': 'assets/video/',
      '源代码': 'src/',
      'src': 'src/',
      'source': 'src/',
      '代码': 'src/',
      '归档': 'archives/',
      'archive': 'archives/',
      'archives': 'archives/',
      '备份': 'archives/',
      'backup': 'archives/',
      '配置': 'config/',
      'config': 'config/',
      '资料': 'references/',
      'references': 'references/',
      'reference': 'references/',
      '学习': 'learning/',
      'study': 'learning/',
      '项目': 'projects/',
      'project': 'projects/',
      '脚本': 'scripts/',
      'scripts': 'scripts/',
      '样式': 'styles/',
      'styles': 'styles/',
      '测试': '__tests__/',
      'tests': '__tests__/',
      'test': '__tests__/',
    }

    const normalized = category.trim().toLowerCase()
    const mapped = map[normalized]
    if (mapped) return mapped

    // 如果没有映射，直接使用用户提供的名称
    const safe = category.replace(/[<>:"/\\|?*]/g, '_').trim()
    return safe ? safe + '/' : 'uncategorized/'
  }

  // ============================================================================
  // 趋势信号集成
  // ============================================================================

  /**
   * 获取趋势信号中的热点类别建议。
   * 目前使用内置类别 + 从基因池规则提取类别。
   *
   * TODO: 集成 TrendQueryTool 获取实时热点类别
   */
  private async fetchTrendCategories(): Promise<string[]> {
    const categories = new Set<string>()

    // 1. 内置类别建议
    for (const cat of BUILTIN_CATEGORIES) {
      categories.add(cat.keyword)
    }

    // 2. 从基因池规则提取目标目录作为类别建议
    const topRules = genePool.getTopRules(5)
    for (const rule of topRules) {
      const dir = rule.action.target.replace(/\/+$/, '')
      if (dir) categories.add(dir)
    }

    // 3. TODO: 集成 TrendQueryTool 查询热点趋势
    // 当趋势数据可用时，从热点中提取高频名词作为类别建议
    // 例如：B站热门话题中的关键词 → 类别名

    log('INFO', 'voice_file_organizer_categories', {
      categoryCount: categories.size,
      categories: Array.from(categories).slice(0, 10),
    })

    return Array.from(categories).slice(0, 15)
  }

  // ============================================================================
  // 工具方法
  // ============================================================================

  /** 超时辅助函数 */
  private timeout(ms: number, message: string): Promise<never> {
    return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
  }
}

/** 全局单例 */
export const voiceFileOrganizerBridge = new VoiceFileOrganizerBridge()
