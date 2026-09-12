/**
 * FileOrganizationIntentExtractor — 语音文件整理意图提取器
 *
 * 使用 LLM 解析用户语音命令（如 "把这份报告移到文档"），
 * 提取目标文件、目标类别和操作类型。
 *
 * 设计原则：
 * - 不依赖关键词匹配，使用 LLM NLU 处理同义词/口语化表达
 * - 输出结构化 JSON，后续直接由 VoiceFileOrganizerBridge 消费
 * - 支持中英文混合输入
 * - 低置信度时返回 fallback 供下游处理
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { LlmService } from '@akemi-mio/intelligence/llm/LlmService'

// =============================================================================
// 类型定义
// =============================================================================

/** 语音文件整理意图 — LLM 解析输出 */
export interface VoiceFileIntent {
  /** 操作类型 */
  action: 'move' | 'organize' | 'categorize' | 'archive' | 'unknown'
  /** 目标文件描述（用户口语化名称，如 "这个报告"、"那个 PDF"） */
  targetFileDescription: string
  /** 可能的具体文件名（LLM 推断），精确匹配时使用 */
  inferredFileName?: string
  /** 目标类别/目录名（如 "文档"、"报告"、"图片"、"archive"） */
  targetCategory: string
  /** 是否自动创建不存在的目录 */
  createDirectory: boolean
  /** LLM 置信度 0–1 */
  confidence: number
  /** 原始命令文本 */
  rawText: string
  /** 风险等级 */
  riskLevel: 'low' | 'medium' | 'high'
}

/** LLM 返回的原始 JSON 结构 */
interface LlmExtractResult {
  action: string
  target_file_description: string
  inferred_file_name?: string
  target_category: string
  create_directory: boolean
  confidence: number
  risk_reason?: string
}

// =============================================================================
// System Prompt
// =============================================================================

const EXTRACT_SYSTEM_PROMPT = `你是一个文件整理命令解析器。
从用户语音命令中提取文件整理意图，只输出 JSON，不要多余文字。

解析规则：
1. action: 操作类型 — move(移动)/organize(归类整理)/categorize(按类别归类)/archive(归档)/unknown(不确定)
2. target_file_description: 用户对目标文件的口语描述（如 "这份报告"、"那个PDF"、"所有图片"）
3. inferred_file_name: 如果用户提到了明确文件名，提取它（可选）
4. target_category: 目标类别/目录（如 "文档"、"报告"、"图片"、"archive"、"资料"）
5. create_directory: 是否需要自动创建目录（true/false）
6. confidence: 你对解析结果的信心 0–1
7. risk_reason: 如果风险高(confidence<0.6或操作涉及删除/覆盖)，说明原因

示例：
用户：把这份报告移到文档
{"action":"move","target_file_description":"这份报告","target_category":"文档","create_directory":false,"confidence":0.95}

用户：把这个PDF归档到2024年资料
{"action":"archive","target_file_description":"这个PDF","target_category":"2024年资料","create_directory":true,"confidence":0.85}

用户：把所有的图片归类到assets
{"action":"organize","target_file_description":"所有的图片","target_category":"assets","create_directory":false,"confidence":0.9}

用户：我不确定要做什么
{"action":"unknown","target_file_description":"","target_category":"","create_directory":false,"confidence":0.1,"risk_reason":"用户表达不清晰"}

只输出 JSON 对象。`

// =============================================================================
// IntentExtractor
// =============================================================================

export class FileOrganizationIntentExtractor {
  private llmService: LlmService | null = null

  /** 设置 LLM 服务引用 */
  setLlmService(service: LlmService): void {
    this.llmService = service
  }

  /**
   * 从语音文本中提取文件整理意图。
   *
   * @param voiceText ASR 转写的用户语音文本
   * @returns 解析后的意图，或低置信度 fallback
   */
  async extract(voiceText: string): Promise<VoiceFileIntent> {
    const text = voiceText.trim()
    if (!text) {
      return this.lowConfidence('', 'empty input')
    }

    // 快速关键词兜底：如果 LLM 不可用，用简单规则
    if (!this.llmService) {
      return this.fallbackKeywordExtract(text)
    }

    try {
      const result = await this.llmService.chatJson(text, {
        system: EXTRACT_SYSTEM_PROMPT,
        temperature: 0.1,
        timeoutMs: 8000,
        requestId: `file-intent-${Date.now()}`,
      })

      if (result.error || !result.data) {
        log('WARN', 'file_intent_llm_error', { error: result.error })
        return this.fallbackKeywordExtract(text)
      }

      const parsed = result.data as LlmExtractResult

      // 验证必需字段
      if (!parsed.action || !parsed.target_category) {
        log('WARN', 'file_intent_parse_missing_fields', { data: JSON.stringify(parsed) })
        return this.fallbackKeywordExtract(text)
      }

      // 确定风险等级
      let riskLevel: VoiceFileIntent['riskLevel'] = 'low'
      if (parsed.confidence < 0.6) {
        riskLevel = 'high'
      } else if (parsed.confidence < 0.8) {
        riskLevel = 'medium'
      }

      // 验证 action 是否合法
      let action: VoiceFileIntent['action'] = 'unknown'
      const validActions = ['move', 'organize', 'categorize', 'archive'] as const
      for (const a of validActions) {
        if (parsed.action === a) {
          action = a
          break
        }
      }

      // 如果 action 是 unknown 或 confidence 过低且未提供说明 → 提高风险
      if (action === 'unknown' && parsed.confidence >= 0.5) {
        riskLevel = 'medium'
      }

      log('INFO', 'file_intent_extracted', {
        action,
        category: parsed.target_category,
        fileDesc: parsed.target_file_description.slice(0, 30),
        confidence: parsed.confidence,
        riskLevel,
      })

      return {
        action,
        targetFileDescription: parsed.target_file_description || '',
        inferredFileName: parsed.inferred_file_name,
        targetCategory: parsed.target_category,
        createDirectory: parsed.create_directory ?? false,
        confidence: parsed.confidence,
        rawText: text,
        riskLevel,
      }
    } catch (err) {
      log('ERROR', 'file_intent_extract_exception', { error: String(err) })
      return this.fallbackKeywordExtract(text)
    }
  }

  /**
   * 关键词兜底方案 — 当 LLM 不可用或失败时使用。
   * 覆盖常见中英文文件整理命令。
   */
  private fallbackKeywordExtract(text: string): VoiceFileIntent {
    const lower = text.toLowerCase()

    // 动作识别
    let action: VoiceFileIntent['action'] = 'unknown'
    if (/移|搬|move|put|拖/.test(lower)) action = 'move'
    else if (/归类|整|organize|sort|分类/.test(lower)) action = 'organize'
    else if (/归档|存档|archive|存/.test(lower)) action = 'archive'
    else if (/分|categorize|归类/.test(lower)) action = 'categorize'

    // 类别提取：尝试匹配 "到/去/进 + [类别]" 模式
    let targetCategory = ''
    const categoryPatterns = [
      /(?:到|去|进|放入|移到|归到|放到|归档到)\s*[\\"'"]?([^\s\\"'"]{2,})[\\"'"]?/,
      /(?:classify|put in|move to|into)\s*[\\"'"]?([a-zA-Z一-鿿]{2,})[\\"'"]?/,
    ]
    for (const pattern of categoryPatterns) {
      const match = text.match(pattern)
      if (match) {
        targetCategory = match[1].trim()
        break
      }
    }

    // 文件描述提取："[这那][个份篇] + [文件名]"
    let fileDesc = ''
    const filePatterns = [
      /(?:这|那|这)[个份篇]?\s*([^\s，。,.]{1,20})/,
      /(?:the |this |that )?(file|document|report|pdf|image|picture)\s*/i,
    ]
    for (const pattern of filePatterns) {
      const match = text.match(pattern)
      if (match) {
        fileDesc = match[0].trim()
        break
      }
    }

    const confidence = targetCategory ? 0.6 : 0.3

    log('INFO', 'file_intent_fallback_extract', {
      action,
      category: targetCategory,
      fileDesc: fileDesc.slice(0, 30),
      confidence,
    })

    return {
      action,
      targetFileDescription: fileDesc,
      targetCategory,
      createDirectory: true,
      confidence,
      rawText: text,
      riskLevel: confidence < 0.6 ? 'high' : 'medium',
    }
  }

  /** 生成低置信度意图 */
  private lowConfidence(reason: string, detail: string): VoiceFileIntent {
    return {
      action: 'unknown',
      targetFileDescription: '',
      targetCategory: '',
      createDirectory: false,
      confidence: 0,
      rawText: '',
      riskLevel: 'high',
    }
  }
}

/** 全局单例 */
export const fileOrganizationIntentExtractor = new FileOrganizationIntentExtractor()
