/**
 * VoiceContinuationService — 语音引导的剧情续写（含情感氛围感知）
 *
 * 职责：
 * 1. 根据故事名和章节号从远程写作 API 获取上一章内容
 * 2. 从 Memory 中获取读者期望摘要
 * 3. 将用户语音输入格式化为"用户需求：..."，与上下文合并
 * 4. 【新增】接收用户语音的韵律特征分析 → 故事氛围参数
 * 5. 调用 LLM 生成续写章节（氛围参数作为生成约束）
 * 6. 将生成结果保存为新的章节/场景
 *
 * 使用方式：
 * - execute(storyName, chapterNum, userVoiceText, atmosphere) — 入口：完整流程
 * - 若 userVoiceText 为空（用户静默），使用默认 prompt 续写
 * - atmosphere 参数可选，来自 AudioFeatureExtractor + AtmosphereMapper
 *
 * 依赖：
 * - 远程写作 API（与 WritingTool 共用 same 端点）
 * - LLM API（OpenAI 兼容格式，与 InspirationService 一致）
 * - WritingMemoryContinuation（读者期望摘要）
 * - StoryAtmosphere（音频特征 → 氛围参数，VoiceContinuationCapture 上游提供）
 */
import { log } from '@akemi-mio/core/logger/Logger'
import { getRuntimeLlmConfig } from '@akemi-mio/intelligence/llm/runtimeConfig'
import { getCredentialsManager } from '@akemi-mio/capabilities/tool/deps'
import { createTimeoutSignal } from '@akemi-mio/core/utils/async'
import { WritingMemoryContinuation } from '@akemi-mio/creativity/WritingMemoryContinuation'
import type { StoryAtmosphere } from '@akemi-mio/audio/types'

// ── 类型定义 ──

export interface ContinuationContext {
  /** 故事名 */
  storyName: string
  /** 目标续写章节号 */
  chapterNum: number
  /** 故事 ID（远程 API） */
  storyId: string | null
  /** 上一章的内容 */
  previousChapter: { title: string; content: string } | null
  /** 已存在的章节总数 */
  totalChapters: number
  /** 读者期望摘要 */
  readerExpectations: string
}

export interface ContinuationResult {
  /** 是否成功 */
  success: boolean
  /** 生成的章节标题 */
  chapterTitle: string
  /** 生成的章节内容 */
  content: string
  /** 远程 API 返回的场景 ID */
  sceneId: string | null
  /** 使用的用户语音输入（可能为空） */
  userVoiceText: string
  /** 语音情绪分析得到的氛围参数（新增） */
  atmosphere?: StoryAtmosphere | null
  /** 错误信息 */
  error?: string
  /** 处理耗时 ms */
  processingMs: number
}

// ── 常量 ──

const DEFAULT_WRITING_API = 'https://www.crlkcloud.cyou/writing/api'
const LLM_TIMEOUT = 60000
const API_TIMEOUT = 15000
const LLM_TEMPERATURE = 0.8
const MAX_CHAPTER_LENGTH = 4000

// ── 服务 ──

export class VoiceContinuationService {
  private writingMemory = new WritingMemoryContinuation()

  /**
   * 获取写作 API 基 URL
   */
  private getWritingApiUrl(): string {
    const creds = getCredentialsManager()
    return creds?.get('writing_api_url') || process.env.WRITING_API_URL || DEFAULT_WRITING_API
  }

  /**
   * 调用远程写作 API
   */
  private async writingFetch(method: string, path: string, body?: any): Promise<any> {
    const url = `${this.getWritingApiUrl()}${path}`
    const { controller, timer } = createTimeoutSignal(API_TIMEOUT)
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
      }
      return res.json()
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 获取 LLM API Key
   */
  private getApiKey(): string | null {
    const getCredential = (key: string) => getCredentialsManager()?.get(key) ?? null
    return getRuntimeLlmConfig({ getCredential }).chat.apiKey || null
  }

  /**
   * 初始化续写上下文：查找故事、获取上一章内容、获取读者期望
   */
  async initializeContext(storyName: string, chapterNum: number): Promise<ContinuationContext> {
    const t0 = Date.now()
    log('INFO', 'continuation_init', { storyName, chapterNum })

    let storyId: string | null = null
    let previousChapter: { title: string; content: string } | null = null
    let totalChapters = 0

    try {
      // 1. 查找故事
      const stories: any[] = await this.writingFetch('GET', '/stories')
      const story = stories.find((s: any) => s.title === storyName || s.title?.includes(storyName) || storyName.includes(s.title || ''))
      if (story) {
        storyId = String(story.id)

        // 2. 获取章节列表
        const scenes: any[] = await this.writingFetch('GET', `/scenes?storyId=${storyId}`)
        totalChapters = Array.isArray(scenes) ? scenes.length : 0

        // 3. 获取上一章内容（按 order 或位置）
        const prevChapterNum = Math.max(1, chapterNum - 1)
        let prevScene = Array.isArray(scenes) ? scenes.find((s: any) => Number(s.order) === prevChapterNum) : null
        // 若未找到按 order 的，按数组索引取
        if (!prevScene && Array.isArray(scenes) && scenes.length >= prevChapterNum) {
          prevScene = scenes[prevChapterNum - 1]
        }
        if (prevScene) {
          // 如果场景只有摘要，获取完整内容
          let content = prevScene.content || prevScene.summary || ''
          if ((!content || content.length < 50) && prevScene.id) {
            try {
              const detail = await this.writingFetch('GET', `/scenes/${prevScene.id}`)
              content = detail.content || detail.summary || content
            } catch {
              // 使用已有内容
            }
          }
          previousChapter = {
            title: prevScene.title || `第${prevChapterNum}章`,
            content: content.slice(0, MAX_CHAPTER_LENGTH),
          }
        }
      }
    } catch (err) {
      log('WARN', 'continuation_init_fetch_failed', {
        storyName,
        chapterNum,
        error: String(err),
      })
      // 降级：即使获取失败也继续，使用空上下文
    }

    // 4. 获取读者期望
    let readerExpectations = ''
    try {
      readerExpectations = this.writingMemory.getReaderExpectationContext(storyName)
    } catch {
      // 降级
    }

    const ms = Date.now() - t0
    log('INFO', 'continuation_init_complete', {
      storyName,
      chapterNum,
      foundStory: !!storyId,
      hasPrevious: !!previousChapter,
      totalChapters,
      tookMs: ms,
    })

    return {
      storyName,
      chapterNum,
      storyId,
      previousChapter,
      totalChapters,
      readerExpectations,
    }
  }

  /**
   * 生成续写：合并语音输入 + 语音氛围参数 + 上下文 → 调用 LLM → 保存结果
   *
   * @param storyName 故事名（如"工业颂歌"）
   * @param chapterNum 要续写的章节号（如 9）
   * @param userVoiceText 用户语音输入（空串/无内容 = 静默，使用默认提示）
   * @param atmosphere 语音韵律分析得到的氛围参数（可选）
   */
  async execute(
    storyName: string,
    chapterNum: number,
    userVoiceText?: string,
    atmosphere?: StoryAtmosphere | null,
  ): Promise<ContinuationResult> {
    const t0 = Date.now()
    const voiceText = (userVoiceText || '').trim()
    const hasAtmo = !!atmosphere && atmosphere.confidence > 0.2

    log('INFO', 'continuation_execute_start', {
      storyName,
      chapterNum,
      hasVoice: voiceText.length > 0,
      voiceLength: voiceText.length,
      hasAtmosphere: hasAtmo,
      atmosphereDominant: hasAtmo ? atmosphere!.dominantLabel : 'none',
    })

    // 1. 初始化上下文
    const ctx = await this.initializeContext(storyName, chapterNum)

    // 2. 构建续写 prompt（含氛围约束）
    const prompt = this.buildContinuationPrompt(storyName, chapterNum, voiceText, ctx, hasAtmo ? atmosphere! : undefined)

    // 3. 调用 LLM 生成续写
    let generatedContent: string
    try {
      generatedContent = await this.callLlmForContinuation(prompt, storyName, chapterNum)
    } catch (err) {
      const ms = Date.now() - t0
      log('ERROR', 'continuation_llm_failed', { storyName, chapterNum, error: String(err) })
      return {
        success: false,
        chapterTitle: `第${chapterNum}章`,
        content: '',
        sceneId: null,
        userVoiceText: voiceText,
        atmosphere: hasAtmo ? atmosphere! : null,
        error: `LLM 生成失败: ${String(err)}`,
        processingMs: ms,
      }
    }

    // 4. 生成章节标题
    const chapterTitle = this.generateChapterTitle(storyName, chapterNum, generatedContent)

    // 5. 保存到远程 API（如果有 storyId）
    let sceneId: string | null = null
    if (ctx.storyId) {
      try {
        const result = await this.writingFetch('POST', '/scenes', {
          title: chapterTitle,
          content: generatedContent,
          storyId: ctx.storyId,
          order: chapterNum,
        })
        sceneId = String(result.id || result.sceneId || '')
        log('INFO', 'continuation_scene_saved', { storyName, chapterNum, sceneId })
      } catch (err) {
        log('WARN', 'continuation_scene_save_failed', {
          storyName,
          chapterNum,
          error: String(err),
        })
        // 不因保存失败而影响返回结果
      }
    }

    const ms = Date.now() - t0
    log('INFO', 'continuation_execute_complete', {
      storyName,
      chapterNum,
      contentLength: generatedContent.length,
      saved: !!sceneId,
      tookMs: ms,
    })

    return {
      success: true,
      chapterTitle,
      content: generatedContent,
      sceneId,
      userVoiceText: voiceText,
      atmosphere: hasAtmo ? atmosphere! : null,
      processingMs: ms,
    }
  }

  /**
   * 构建完整的续写 prompt（含情感氛围约束）
   *
   * @param atmosphere 可选的语音韵律氛围参数，注入为写作风格约束
   */
  private buildContinuationPrompt(
    storyName: string,
    chapterNum: number,
    voiceText: string,
    ctx: ContinuationContext,
    atmosphere?: StoryAtmosphere,
  ): string {
    const parts: string[] = []

    // 1. 系统指令
    parts.push(`你是一个小说续写助手。请根据已有的故事内容，续写《${storyName}》的第${chapterNum}章。`)

    // 2. 用户需求（语音输入或默认）
    if (voiceText) {
      parts.push(`\n【用户需求】\n${voiceText}`)
    }

    // 3. 情感氛围约束（来自语音韵律特征分析）
    if (atmosphere && atmosphere.confidence > 0.2) {
      const atmoLines: string[] = ['\n【情感氛围约束】']
      atmoLines.push(`用户语音的情感氛围主导方向：${atmosphere.description}`)
      atmoLines.push(`氛围强度（0-1）：${atmosphere.confidence.toFixed(2)}`)
      atmoLines.push('')
      atmoLines.push('请在续写中体现以下氛围调节要求：')

      // 为每个氛围维度提供调节方向
      const activeDims: string[] = []
      if (atmosphere.tension > 0.3)
        activeDims.push(`- 紧张度 ${(atmosphere.tension * 100).toFixed(0)}%：节奏紧凑，悬念适度，让读者有压迫感`)
      if (atmosphere.joy > 0.3) activeDims.push(`- 欢乐度 ${(atmosphere.joy * 100).toFixed(0)}%：语调轻快，文字明亮，充满温暖与笑容`)
      if (atmosphere.sadness > 0.3) activeDims.push(`- 悲伤度 ${(atmosphere.sadness * 100).toFixed(0)}%：氛围伤感，舒缓低沉，带淡淡忧伤`)
      if (atmosphere.calmness > 0.3) activeDims.push(`- 平静度 ${(atmosphere.calmness * 100).toFixed(0)}%：平和安宁，描写舒缓，节奏平缓`)
      if (atmosphere.mystery > 0.3) activeDims.push(`- 神秘度 ${(atmosphere.mystery * 100).toFixed(0)}%：悬念伏笔，文字朦胧，欲说还休`)
      if (atmosphere.romance > 0.3) activeDims.push(`- 浪漫度 ${(atmosphere.romance * 100).toFixed(0)}%：温馨浪漫，柔软细腻，情感含蓄`)

      if (activeDims.length > 0) {
        atmoLines.push(...activeDims)
      }
      atmoLines.push('以上氛围约束来源于用户的语音表达——请通过描写手法自然呈现，而非直接陈述。"show, don\'t tell"。')

      parts.push(atmoLines.join('\n'))
    }

    // 4. 上一章内容
    if (ctx.previousChapter) {
      parts.push(`\n【${ctx.previousChapter.title}内容】\n${ctx.previousChapter.content}`)
    }

    // 5. 读者期望（如果有）
    if (ctx.readerExpectations) {
      parts.push(`\n${ctx.readerExpectations}`)
    }

    // 6. 写作指令
    parts.push(
      `\n【写作要求】\n` +
        `1. 请基于以上上下文，续写第${chapterNum}章，字数不少于 2000 字。\n` +
        `2. 保持与前文一致的写作风格、叙事视角和人物设定。\n` +
        `3. 注意章节之间的情节连贯性，合理承接上一章结尾。\n` +
        `4. 如果用户提供了需求，请尽量融入这些元素。\n` +
        `5. 如果提供了情感氛围约束，请在描写中自然体现该氛围。\n` +
        `6. 直接输出章节正文，不要包含章节标题。`,
    )

    return parts.join('\n\n')
  }

  /**
   * 调用 LLM 进行续写生成
   */
  private async callLlmForContinuation(prompt: string, storyName: string, chapterNum: number): Promise<string> {
    const apiKey = this.getApiKey()
    const { chat } = getRuntimeLlmConfig({
      getCredential: (key) => getCredentialsManager()?.get(key) ?? null,
    })
    const apiUrl = chat.apiUrl

    const body = {
      model: chat.model,
      messages: [
        {
          role: 'system',
          content: `你是一位优秀的小说创作者。你正在续写小说《${storyName}》的第${chapterNum}章。请输出连贯、有画面感的叙事文字。`,
        },
        { role: 'user', content: prompt },
      ],
      temperature: LLM_TEMPERATURE,
      max_tokens: 4096,
      stream: false,
    }

    const { controller, timer } = createTimeoutSignal(LLM_TIMEOUT)
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

      return content.trim()
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 从生成内容中提取或生成章节标题
   */
  private generateChapterTitle(storyName: string, chapterNum: number, content: string): string {
    // 尝试从内容首行提取标题（如 "# 第九章 新的开始"）
    const firstLine = content.split('\n')[0].trim()
    const titleMatch = firstLine.match(/^#{1,3}\s+(.+)$/)
    if (titleMatch) {
      return titleMatch[1].trim()
    }
    // 尝试用书名号包裹的标题
    const angleMatch = firstLine.match(/[《（( ](.+?)[》）) ]/)
    if (angleMatch) {
      return angleMatch[1].trim()
    }
    return `第${chapterNum}章`
  }
}

// ── 单例 ──

export const voiceContinuationService = new VoiceContinuationService()
