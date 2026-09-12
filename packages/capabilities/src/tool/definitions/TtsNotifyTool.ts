/**
 * TtsNotifyTool — MCP 事件语音通知工具
 *
 * 与 speakWithPiperTool（Agent 主动朗读）不同，
 * tts_notify 专为事件驱动的语音通知设计：
 *   - 工具完成/失败时自动播报简短摘要
 *   - 优先级控制（高优先级立即播放，常规通知排队）
 *   - 可配置通知内容的简洁程度
 *   - 支持按工具名过滤（避免读操作频繁播报）
 *
 * 配合 TtsEventNotificationService 使用，实现
 * 工具执行结果 → 语音播报的自动管线。
 */

import { buildTool } from '@akemi-mio/capabilities/tool/types'
import { formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'
import { log } from '@akemi-mio/core/logger/Logger'
import { cleanTTS } from '@akemi-mio/audio/TtsService'
import { piperOrchestrator } from '@akemi-mio/audio/PiperOrchestrator'
import { BrowserWindow } from 'electron'
import { unlinkSync } from 'fs'

// =============================================================================
//  通知优先级
// =============================================================================

export type NotifyPriority = 'high' | 'normal' | 'low'

export const PRIORITY_LABELS: Record<NotifyPriority, string> = {
  high: '高',
  normal: '普通',
  low: '低',
}

// =============================================================================
//  通知过滤器 — 可由 tts_notify_config 动态调整
// =============================================================================

export interface TtsNotifyFilter {
  /** 启用/禁用通知（全局开关） */
  enabled: boolean
  /** 仅通知这些工具（空 = 所有工具） */
  allowTools: string[]
  /** 跳过通知的工具列表（黑名单） */
  blockTools: string[]
  /** 通知文本最大长度（过长会被截断） */
  maxTextLength: number
  /** 播报风格：full=完整摘要，brief=一句话概括 */
  style: 'full' | 'brief'
}

const DEFAULT_FILTER: TtsNotifyFilter = {
  enabled: true,
  allowTools: [],
  blockTools: [
    'list_piper_models',
    'switch_piper_model',
    'list_plans',
    'list_skills',
    'list_workflows',
    'list_workflow_runs',
    'list_credentials',
    'list_memories',
    'list_procedures',
    'list_file_rules',
    'list_providers',
    'list_mcp_servers',
    'get_system_health',
    'list_pipeline_files',
  ],
  maxTextLength: 60,
  style: 'brief',
}

/** 运行时通知过滤器（全局单例，可动态修改） */
export const ttsNotifyFilter: TtsNotifyFilter = { ...DEFAULT_FILTER }

/** 重置过滤器到默认值 */
export function resetTtsNotifyFilter(): void {
  Object.assign(ttsNotifyFilter, DEFAULT_FILTER)
}

// =============================================================================
//  音频播放
// =============================================================================

/** 播放音频文件到渲染进程 */
async function playAudioFile(filePath: string): Promise<void> {
  const wins = BrowserWindow.getAllWindows()
  for (const win of wins) {
    win.webContents.send('tts:play_audio', filePath)
  }
}

// =============================================================================
//  通知队列（优先级管理）
// =============================================================================

interface QueuedNotification {
  text: string
  priority: NotifyPriority
  timestamp: number
}

class NotificationQueue {
  private queue: QueuedNotification[] = []
  private processing = false

  /**
   * 入队通知。
   * high 优先级的通知跳过队列直接播放（中断当前播放）。
   * normal/low 优先级的通知进入 FIFO 队列。
   */
  enqueue(text: string, priority: NotifyPriority): void {
    if (priority === 'high') {
      // 高优先级：立即播放，打断当前
      this.queue.unshift({ text, priority, timestamp: Date.now() })
    } else {
      this.queue.push({ text, priority, timestamp: Date.now() })
    }
    this.process().catch((err) => log('ERROR', 'notif_queue_process_error', { error: String(err) }))
  }

  private async process(): Promise<void> {
    if (this.processing) return
    this.processing = true

    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!
        await this.synthesizeAndPlay(item.text)
      }
    } finally {
      this.processing = false
    }
  }

  private async synthesizeAndPlay(text: string): Promise<void> {
    const t0 = Date.now()
    const cleaned = cleanTTS(text)
    if (!cleaned || cleaned.length < 2) return

    log('INFO', 'notif_tts_synthesize', {
      text_len: cleaned.length,
      text_preview: cleaned.slice(0, 40),
    })

    const result = await piperOrchestrator.synthesize({
      text: cleaned,
      taskTag: 'alert', // 通知统一使用 alert 标签
    })

    if (result.success && result.audioFile) {
      await playAudioFile(result.audioFile)

      // 延迟清理临时文件
      const tempFile = result.audioFile
      setTimeout(() => {
        try {
          unlinkSync(tempFile)
        } catch {
          // 文件可能已被清理
        }
      }, 10000)

      log('INFO', 'notif_tts_done', {
        duration_ms: Date.now() - t0,
        text_len: cleaned.length,
      })
    } else {
      log('WARN', 'notif_tts_failed', { error: result.error })
    }
  }

  /** 获取队列状态 */
  getStatus(): { queueSize: number; isProcessing: boolean } {
    return { queueSize: this.queue.length, isProcessing: this.processing }
  }

  /** 清空队列 */
  clear(): void {
    this.queue = []
  }
}

/** 全局通知队列单例 */
export const notificationQueue = new NotificationQueue()

// =============================================================================
//  tts_notify — 语音通知工具
// =============================================================================

export const ttsNotifyTool = buildTool({
  name: 'tts_notify',
  description:
    '播报语音通知。用于在工具执行完成、发生错误或需要语音提示时调用。' +
    '支持优先级：high=高优（立即播放，适合错误/告警），normal=普通（排队播放），low=低优（空闲时播放）。' +
    '注意：系统会自动为工具完成/失败事件播报通知，仅在需要手动触发通知时使用此工具。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: '要播报的通知文本。建议保持简短（30 字以内效果最佳），系统会自动清理 markdown 和 emoji。',
      },
      priority: {
        type: 'string',
        description:
          '通知优先级。high=高优先级（立即播放，适合错误/告警），normal=普通（排队播放），low=低优先级（空闲时播放）。默认 normal。',
        enum: ['high', 'normal', 'low'],
      },
    },
    required: ['text'],
  },
  handler: async (args: { text: string; priority?: string }) => {
    const text = args.text || ''
    const priority: NotifyPriority = (args.priority as NotifyPriority) || 'normal'

    if (!['high', 'normal', 'low'].includes(priority)) {
      return formatToolError(`无效的优先级: ${args.priority}。可选: high, normal, low`)
    }

    const cleaned = cleanTTS(text)
    if (!cleaned || cleaned.length < 2) {
      return formatToolError('通知文本太短或清理后为空')
    }

    log('INFO', 'tts_notify_invoke', {
      text_len: cleaned.length,
      priority,
      text_preview: cleaned.slice(0, 40),
      queue_status: notificationQueue.getStatus(),
    })

    notificationQueue.enqueue(cleaned, priority)

    return formatToolResult(
      `已加入语音通知队列 (优先级: ${PRIORITY_LABELS[priority]}, 文本: "${cleaned.slice(0, 40)}${cleaned.length > 40 ? '...' : ''}")`,
    )
  },
  isReadOnly: true,
})

// =============================================================================
//  tts_notify_config — 通知配置工具
// =============================================================================

export const ttsNotifyConfigTool = buildTool({
  name: 'tts_notify_config',
  description: '配置语音通知系统：启用/禁用自动播报、添加/移除过滤规则、调整播报风格等。' + '无需参数时返回当前配置状态。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        description: '是否启用自动语音通知（全局开关）。true=启用，false=禁用。',
      },
      add_block: {
        type: 'string',
        description: '将指定工具加入通知黑名单（播报跳过该工具的通知）。',
      },
      remove_block: {
        type: 'string',
        description: '将指定工具移出通知黑名单。',
      },
      style: {
        type: 'string',
        description: '播报风格：brief=一句话概括（仅播报工具名和结果），full=完整摘要（播报更多信息）。',
        enum: ['brief', 'full'],
      },
      max_length: {
        type: 'number',
        description: '通知文本最大长度（字符数），超过截断。默认 60。',
      },
    },
    required: [],
  },
  handler: async (args: { enabled?: boolean; add_block?: string; remove_block?: string; style?: string; max_length?: number }) => {
    const changes: string[] = []

    if (args.enabled !== undefined) {
      ttsNotifyFilter.enabled = args.enabled
      changes.push(`通知${args.enabled ? '启用' : '禁用'}`)
    }

    if (args.add_block) {
      if (!ttsNotifyFilter.blockTools.includes(args.add_block)) {
        ttsNotifyFilter.blockTools.push(args.add_block)
        changes.push(`已屏蔽工具 "${args.add_block}"`)
      } else {
        changes.push(`工具 "${args.add_block}" 已在黑名单中`)
      }
    }

    if (args.remove_block) {
      const idx = ttsNotifyFilter.blockTools.indexOf(args.remove_block)
      if (idx >= 0) {
        ttsNotifyFilter.blockTools.splice(idx, 1)
        changes.push(`已移除工具 "${args.remove_block}" 的黑名单`)
      } else {
        changes.push(`工具 "${args.remove_block}" 不在黑名单中`)
      }
    }

    if (args.style) {
      if (args.style === 'brief' || args.style === 'full') {
        ttsNotifyFilter.style = args.style
        changes.push(`播报风格: ${args.style === 'brief' ? '简要' : '完整'}`)
      }
    }

    if (args.max_length !== undefined) {
      ttsNotifyFilter.maxTextLength = Math.max(10, Math.min(200, args.max_length))
      changes.push(`通知文本最大长度: ${ttsNotifyFilter.maxTextLength}`)
    }

    // 返回当前配置
    const status = notificationQueue.getStatus()
    const lines = [
      '═ 语音通知系统配置 ═',
      `状态: ${ttsNotifyFilter.enabled ? '🟢 已启用' : '🔴 已禁用'}`,
      `播报风格: ${ttsNotifyFilter.style === 'brief' ? '简要' : '完整'}`,
      `文本最大长度: ${ttsNotifyFilter.maxTextLength}`,
      `通知队列: ${status.queueSize} 个待处理${status.isProcessing ? ' (正在合成)' : ''}`,
      '',
      '黑名单工具:',
    ]

    if (ttsNotifyFilter.blockTools.length === 0) {
      lines.push('  (无)')
    } else {
      for (const t of ttsNotifyFilter.blockTools) {
        lines.push(`  - ${t}`)
      }
    }

    if (changes.length > 0) {
      lines.push('', '本次变更:', ...changes.map((c) => `  ✓ ${c}`))
    }

    return formatToolResult(lines.join('\n'))
  },
  isReadOnly: false,
})

