/**
 * InspirationService — 语音灵感捕获与情节引导
 *
 * 职责：
 * 1. 对 ASR 转写文本做 NER 提取（角色、事件、情绪、转折方向）
 * 2. 将提取内容包装成自然人话引导 prompt
 * 3. 触发续写模型生成章节
 *
 * 使用方式：
 * - process(text) — 入口：转写文本 → NER提取 → 构建prompt → 返回结构化灵感
 * - 渲染进程拿到结果后展示实体，用户确认后调用 triggerContinuation(promptText) 触发续写
 *
 * 依赖：
 * - CredentialsManager / 环境变量获取 LLM key
 * - LLM_API_URL / LLM_CHAT_MODEL 做 NER 和 prompt 构建
 */
import { log } from '@akemi-mio/core/logger/Logger'
import { getRuntimeLlmConfig } from '@akemi-mio/intelligence/llm/runtimeConfig'
import { getCredentialsManager } from '@akemi-mio/capabilities/tool/deps'
import { createTimeoutSignal } from '@akemi-mio/core/utils/async'

// ── 类型定义 ──

export interface InspirationEntities {
  /** 识别到的角色名列表 */
  characters: string[]
  /** 识别到的事件/情节描述 */
  events: string[]
  /** 识别到的情绪/氛围关键词 */
  emotions: string[]
  /** 可能的剧情转折方向 */
  plotTurns: string[]
}

export interface WritingInspiration {
  /** 原始转写文本 */
  rawText: string
  /** 结构化实体 */
  entities: InspirationEntities
  /** 包装成自然人话的引导 prompt */
  guidedPrompt: string
  /** LLM 处理耗时 ms */
  processingMs: number
  /** 是否有提取结果（至少一个实体有内容） */
  hasContent: boolean
}

// ── LLM NER 系统提示 ──

const NER_SYSTEM_PROMPT = `你是一个小说创作灵感分析助手。你的任务是从用户口述的灵感中提取关键信息。

请分析用户输入的文本，提取以下四类信息：

1. **角色** (characters): 用户提到的任何人物、角色名，包括新角色提议或对现有角色的修改
2. **事件** (events): 用户描述的故事情节、场景、事件发展
3. **情绪** (emotions): 用户提到的情绪氛围、情感基调（如"悲伤""紧张""温馨"等）
4. **剧情转折** (plotTurns): 用户提出的剧情发展方向、转折建议、伏笔、冲突等

注意：
- 不要编造不存在的实体
- 每个列表最多 5 项，每项不超过 20 个字
- 如果没有某项内容，返回空数组
- 提取后构建一段连贯的续写引导 prompt

输出必须是严格的 JSON 格式，不要包含其他文字：
{
  "characters": ["角色A", "角色B"],
  "events": ["事件描述1", "事件描述2"],
  "emotions": ["情绪1", "情绪2"],
  "plotTurns": ["转折1", "转折2"],
  "guidedPrompt": "基于以上提取，构建一段连贯的续写引导prompt（自然语言，50-150字）"
}`

const NER_TEMPERATURE = 0.3
const NER_TIMEOUT = 15000

// ── 服务 ──

export class InspirationService {
  /**
   * 处理语音灵感文本：NER 提取 → prompt 构建
   */
  async process(rawText: string): Promise<WritingInspiration> {
    const t0 = Date.now()

    if (!rawText || !rawText.trim()) {
      return {
        rawText,
        entities: { characters: [], events: [], emotions: [], plotTurns: [] },
        guidedPrompt: '',
        processingMs: Date.now() - t0,
        hasContent: false,
      }
    }

    try {
      const result = await this.callLlmForNer(rawText.trim())
      const ms = Date.now() - t0

      const entities = result.entities || { characters: [], events: [], emotions: [], plotTurns: [] }
      const hasContent =
        entities.characters.length > 0 || entities.events.length > 0 || entities.emotions.length > 0 || entities.plotTurns.length > 0

      return {
        rawText,
        entities,
        guidedPrompt: result.guidedPrompt || '',
        processingMs: ms,
        hasContent,
      }
    } catch (err) {
      const ms = Date.now() - t0
      log('ERROR', 'inspiration_ner_failed', { error: String(err), rawText: rawText.slice(0, 100) })

      // 降级：LLM 调用失败时返回简单包装
      const fallbackPrompt = `根据以下灵感续写故事：${rawText}`
      return {
        rawText,
        entities: { characters: [], events: [], emotions: [], plotTurns: [] },
        guidedPrompt: fallbackPrompt,
        processingMs: ms,
        hasContent: false,
      }
    }
  }

  /**
   * 调用 LLM 进行 NER 提取。
   */
  private async callLlmForNer(text: string): Promise<{
    entities: InspirationEntities
    guidedPrompt: string
  }> {
    const apiKey = this.getApiKey()
    const { chat } = getRuntimeLlmConfig({
      getCredential: (key) => getCredentialsManager()?.get(key) ?? null,
    })
    const apiUrl = chat.apiUrl

    const body = {
      model: chat.model,
      messages: [
        { role: 'system', content: NER_SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
      temperature: NER_TEMPERATURE,
      max_tokens: 600,
    }

    const { controller, timer } = createTimeoutSignal(NER_TIMEOUT)
    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        throw new Error(`LLM HTTP ${res.status}: ${errText.slice(0, 200)}`)
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      const content = data.choices?.[0]?.message?.content
      if (!content) throw new Error('LLM returned empty content')

      return this.parseResponse(content)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 解析 LLM 返回的 JSON 响应。
   */
  private parseResponse(content: string): {
    entities: InspirationEntities
    guidedPrompt: string
  } {
    // 尝试从 markdown 代码块中提取 JSON
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/)
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : content.trim()

    try {
      const parsed = JSON.parse(jsonStr)
      return {
        entities: {
          characters: Array.isArray(parsed.characters) ? parsed.characters.slice(0, 5) : [],
          events: Array.isArray(parsed.events) ? parsed.events.slice(0, 5) : [],
          emotions: Array.isArray(parsed.emotions) ? parsed.emotions.slice(0, 5) : [],
          plotTurns: Array.isArray(parsed.plotTurns) ? parsed.plotTurns.slice(0, 5) : [],
        },
        guidedPrompt: typeof parsed.guidedPrompt === 'string' ? parsed.guidedPrompt : '',
      }
    } catch {
      // JSON 解析失败，尝试正则提取
      log('WARN', 'inspiration_json_parse_failed', { content: content.slice(0, 200) })
      return {
        entities: { characters: [], events: [], emotions: [], plotTurns: [] },
        guidedPrompt: content.slice(0, 300),
      }
    }
  }

  /**
   * 获取 LLM API Key（优先级：环境变量 > 凭据管理）。
   */
  private getApiKey(): string | null {
    const getCredential = (key: string) => getCredentialsManager()?.get(key) ?? null
    return getRuntimeLlmConfig({ getCredential }).chat.apiKey || null
  }

  /**
   * 获取创作领域 ASR 热词，提升写作相关语音的识别准确率。
   * 这些词在语音灵感捕获时注入 ASR 引擎。
   */
  getWritingHotwords(): string[] {
    return [
      // 创作通用词
      '故事',
      '小说',
      '剧情',
      '角色',
      '章节',
      '情节',
      '场景',
      '对话',
      '描写',
      '氛围',
      '转折',
      '伏笔',
      '冲突',
      '高潮',
      '结尾',
      '序章',
      '第一章',
      '开篇',
      '主线',
      '支线',
      // 情绪词
      '悲伤',
      '欢乐',
      '紧张',
      '温馨',
      '悬疑',
      '治愈',
      '热血',
      '感动',
      '恐惧',
      '愤怒',
      '平静',
      '浪漫',
      // 结构词
      '回想',
      '插叙',
      '倒叙',
      '蒙太奇',
      '闪回',
      '铺垫',
      '推进',
      '放缓',
      '加速',
      '切换',
      // 用户可能提及的常见角色/写作要素
      '主角',
      '配角',
      '反派',
      '女主',
      '男主',
      '路人',
      '性格',
      '动机',
      '成长',
      '变化',
      '命运',
    ]
  }
}

// ── 单例 ──

export const inspirationService = new InspirationService()
