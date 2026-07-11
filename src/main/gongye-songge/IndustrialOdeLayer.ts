/**
 * IndustrialOdeLayer — Plan:工业颂歌 公众号排版处理 上层增强层
 *
 * 职责：
 * - 以装饰器模式包裹 AgentService，不侵入其核心逻辑
 * - 在 Agent 执行前后插入预处理/后处理钩子
 * - 通过 feature flag 控制各增强特性的启用/禁用
 * - 提供公众号排版格式化的默认实现
 *
 * 架构模式：与 UserBehaviorLayer 一致
 *   IndustrialOdeLayer
 *     ├── wraps AgentService (decorator pattern)
 *     ├── preProcess()  — 调用前预处理（注入风格提示、检测排版需求）
 *     ├── postProcess() — 调用后后处理（公众号格式化回复）
 *     └── feature flags → 控制哪些钩子生效
 */

import { log } from '../logger/Logger'
import type {
  GongyeSonggeFeature,
  GongyeSonggeFeatureMap,
  PreProcessContext,
  PostProcessContext,
  PostProcessResult,
  PreProcessHook,
  PostProcessHook,
  IndustrialOdeLayerConfig,
} from './types'
import { parseFeaturesFromEnv } from './types'
import { formatBasic, formatWithLlm, detectFormatNeed } from './formatters'

const DEFAULT_CONFIG: Partial<IndustrialOdeLayerConfig> = {
  debug: false,
}

export class IndustrialOdeLayer {
  /** 启用的 feature 集合 */
  private features: GongyeSonggeFeatureMap

  /** 配置 */
  private config: Required<Pick<IndustrialOdeLayerConfig, 'debug'>>

  /** 注册的预处理钩子（按注册顺序执行） */
  private preHooks: PreProcessHook[] = []

  /** 注册的后处理钩子（按注册顺序执行） */
  private postHooks: PostProcessHook[] = []

  /** 上一次后处理结果缓存 */
  private lastPostResult: PostProcessResult | null = null

  /** LLM 服务引用 */
  private llmService: { chatJson(prompt: string, opts?: unknown): Promise<unknown> } | null = null

  constructor(config?: IndustrialOdeLayerConfig) {
    this.features = new Set(config?.features ?? parseFeaturesFromEnv())
    this.config = {
      debug: config?.debug ?? DEFAULT_CONFIG.debug ?? false,
    }

    if (config?.llmService) {
      this.llmService = config.llmService
    }

    if (config?.preHooks) this.preHooks.push(...config.preHooks)
    if (config?.postHooks) this.postHooks.push(...config.postHooks)

    if (this.features.size > 0) {
      log('INFO', 'industrial_ode_active', {
        features: Array.from(this.features),
        preHooks: this.preHooks.length,
        postHooks: this.postHooks.length,
        llmAvailable: !!this.llmService,
      })
    }
  }

  // ==================== Feature 查询 ====================

  /** 检查指定特性是否启用 */
  hasFeature(feature: GongyeSonggeFeature): boolean {
    return this.features.has(feature)
  }

  /** 获取当前启用的特性列表 */
  getActiveFeatures(): GongyeSonggeFeature[] {
    return Array.from(this.features)
  }

  /** 获取最后的后处理结果 */
  getLastPostProcessResult(): PostProcessResult | null {
    return this.lastPostResult
  }

  /** 设置 LLM 服务引用 */
  setLlmService(service: { chatJson(prompt: string, opts?: unknown): Promise<unknown> }): void {
    this.llmService = service
    log('INFO', 'industrial_ode_llm_service_set')
  }

  // ==================== 钩子注册 ====================

  /** 注册预处理钩子 */
  addPreHook(hook: PreProcessHook): void {
    this.preHooks.push(hook)
    log('INFO', 'industrial_ode_pre_hook_added', { total: this.preHooks.length })
  }

  /** 注册后处理钩子 */
  addPostHook(hook: PostProcessHook): void {
    this.postHooks.push(hook)
    log('INFO', 'industrial_ode_post_hook_added', { total: this.postHooks.length })
  }

  // ==================== 预处理 ====================

  /**
   * 在 Agent 执行前调用。
   * 返回增强后的上下文（可被后续 hook 消费）。
   */
  async preProcess(ctx: PreProcessContext): Promise<PreProcessContext> {
    if (this.features.size === 0) return ctx

    let current = ctx
    for (const hook of this.preHooks) {
      try {
        current = await hook(current)
      } catch (err: any) {
        log('WARN', 'industrial_ode_pre_hook_error', {
          error: err.message,
        })
      }
    }

    if (this.config.debug) {
      log('DEBUG', 'industrial_ode_pre_process_done', {
        needsFormatting: current.needsFormatting,
        textChanged: current.rawText !== current.processedText,
      })
    }

    return current
  }

  // ==================== 后处理 ====================

  /**
   * 在 Agent 执行后调用。
   * 返回增强后的结果。
   */
  async postProcess(ctx: PostProcessContext): Promise<PostProcessResult> {
    if (this.features.size === 0) {
      const empty: PostProcessResult = { text: ctx.rawReply, formatted: false }
      this.lastPostResult = empty
      return empty
    }

    let result: PostProcessResult = { text: ctx.rawReply, formatted: false }
    for (const hook of this.postHooks) {
      try {
        const partial = await hook(ctx)
        result = this.mergePostResults(result, partial)
      } catch (err: any) {
        log('WARN', 'industrial_ode_post_hook_error', {
          error: err.message,
        })
      }
    }

    this.lastPostResult = result

    if (this.config.debug) {
      log('DEBUG', 'industrial_ode_post_process_done', {
        formatted: result.formatted,
        length: result.text.length,
        description: result.description,
      })
    }

    return result
  }

  private mergePostResults(base: PostProcessResult, incoming: PostProcessResult): PostProcessResult {
    return {
      text: incoming.text ?? base.text,
      formatted: incoming.formatted || base.formatted,
      description: incoming.description ?? base.description,
    }
  }

  // ==================== 默认钩子实现 ====================

  /**
   * 默认预处理钩子：检测排版需求 + 风格注入。
   * 检测用户输入是否需要公众号排版，若需要则标记预处理上下文。
   */
  static createDetectNeedPreHook(): PreProcessHook {
    return async (ctx) => {
      const detection = detectFormatNeed(ctx.rawText)
      return {
        ...ctx,
        needsFormatting: detection.needsFormat,
      }
    }
  }

  /**
   * 默认预处理钩子：工业颂歌风格注入。
   * 当检测到排版需求时，在输入文本中注入风格提示。
   */
  static createStyleInjectPreHook(): PreProcessHook {
    return async (ctx) => {
      if (!ctx.needsFormatting) return ctx

      const styleHint = `【工业颂歌公众号排版】
请以公众号文章风格回复，注意：
- 使用吸引人的标题
- 段落分明，每段2-3句
- 重要内容可加粗强调
- 结尾可添加总结或引导语`

      return {
        ...ctx,
        processedText: `${ctx.rawText}\n\n${styleHint}`,
      }
    }
  }

  /**
   * 默认后处理钩子：公众号内容格式化。
   * 将 Agent 输出格式化为工业颂歌公众号排版。
   */
  static createFormatPostHook(): PostProcessHook {
    return async (ctx) => {
      if (!ctx.preProcessData?.needsFormatting && !ctx.preProcessData?.forceFormat) {
        // 未检测到排版需求，但开启 publish_ready 时始终格式化
        return { text: ctx.rawReply, formatted: false }
      }

      const result = formatBasic(ctx.rawReply, {
        publishReady: true,
        sentenceDensity: 'normal',
        paragraphSpacing: 'normal',
      })

      return {
        text: result.success ? result.text : ctx.rawReply,
        formatted: result.success,
        description: result.success ? `工业颂歌公众号排版 (${result.type})` : undefined,
      }
    }
  }

  /**
   * 后处理钩子：LLM 增强格式化。
   * 在基础格式化之上使用 LLM 进行智能排版增强。
   */
  static createLlmFormatPostHook(llmService?: { chatJson(prompt: string, opts?: unknown): Promise<unknown> }): PostProcessHook {
    return async (ctx) => {
      if (!ctx.preProcessData?.needsFormatting) {
        return { text: ctx.rawReply, formatted: false }
      }

      if (!llmService) {
        return { text: ctx.rawReply, formatted: false }
      }

      const result = await formatWithLlm(ctx.rawReply, { useLlmEnhance: true, publishReady: true }, llmService)

      return {
        text: result.success ? result.text : ctx.rawReply,
        formatted: result.success,
        description: result.success ? `工业颂歌公众号排版 (${result.type})` : undefined,
      }
    }
  }
}
