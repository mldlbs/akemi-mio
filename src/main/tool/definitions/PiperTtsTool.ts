/**
 * PiperTTS 工具 — 让 Agent 显式调用本地 Piper TTS 进行语音合成
 *
 * 与自动 TTS（ChatExecutor 自动为每条回复发音）不同，
 * 此工具允许 Agent 在以下场景主动控制语音输出：
 *   - 选择性朗读特定段落（跳过代码块/表格）
 *   - 使用不同语速朗读不同类型内容（快读通知、慢读教导）
 *   - 在工具执行完成后播放提示音/确认语音
 *   - 根据任务类型自动选择最佳语音模型（chat/story/alert）
 *
 * 参数：
 *   - text: 要朗读的文本
 *   - task_tag: 任务标签 (chat/story/alert)，自动选择合适的模型
 *   - model: Piper 模型名（显式指定，优先级高于 task_tag）
 *   - speed: 语速因子，1.0=正常，0.8=慢，1.3=快
 *   - pitch: 音调因子，1.0=正常
 *
 * 集成：
 *   - PiperOrchestrator: 排队合成 + 模型回退 + 任务标签映射
 */

import { unlinkSync } from 'fs'
import { buildTool } from '../types'
import { formatToolResult, formatToolError } from '../types'
import { log } from '../../logger/Logger'
import { cleanTTS } from '../../tts/TtsService'
import { piperOrchestrator, type PiperTaskTag, PIPER_MODEL_CATALOG } from '../../tts/PiperOrchestrator'
import { BrowserWindow } from 'electron'

/** 播放音频文件到渲染进程 */
async function playAudioFile(filePath: string): Promise<void> {
  const wins = BrowserWindow.getAllWindows()
  for (const win of wins) {
    win.webContents.send('tts:play_audio', filePath)
  }
}

export const speakWithPiperTool = buildTool({
  name: 'speak_with_piper',
  description:
    '使用本地 Piper TTS 引擎朗读指定文本。支持根据任务标签自动选择语音模型（chat=日常对话/story=讲故事/alert=通知提醒），也可手动指定模型、语速和音调。注意：如果只是普通对话回复，系统会自动朗读，无需调用此工具。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: '要朗读的文本内容（中文）。会自动清理 markdown 标记和 emoji。',
      },
      task_tag: {
        type: 'string',
        description: '任务标签，自动选择最佳模型。可选: chat（日常对话/快速回复）, story（讲故事/朗读/高表现力）, alert（通知/提醒/警告）。',
        enum: ['chat', 'story', 'alert'],
      },
      model: {
        type: 'string',
        description: '显式指定 Piper 语音模型。可选: zh_CN-huayan-medium（花颜·女声/默认）, zh_CN-ling_ling-medium（玲玲·温柔女声）, zh_CN-tx_mati-medium（马提·沉稳男声）。优先级高于 task_tag。',
      },
      speed: {
        type: 'number',
        description: '语速因子，1.0=正常速度，0.7-0.9=较慢（适合教导/解释），1.1-1.3=较快（适合通知/提醒）。默认由模型推荐。',
      },
      pitch: {
        type: 'number',
        description: '音调因子，1.0=正常，>1=偏高（活泼），<1=偏低（沉稳）。默认由模型推荐。',
      },
    },
    required: ['text'],
  },
  handler: async (args: {
    text: string
    task_tag?: string
    model?: string
    speed?: number
    pitch?: number
  }) => {
    const t0 = Date.now()
    const text = cleanTTS(args.text || '')
    if (!text || text.length < 2) {
      return formatToolError('文本太短或清理后为空')
    }

    // 验证 task_tag
    if (args.task_tag && !['chat', 'story', 'alert'].includes(args.task_tag)) {
      return formatToolError(`无效的任务标签: ${args.task_tag}。可选: chat, story, alert`)
    }

    // 验证 model（如果指定）
    const VALID_MODELS = Object.keys(PIPER_MODEL_CATALOG)
    if (args.model && !VALID_MODELS.includes(args.model)) {
      return formatToolError(`无效的模型名: ${args.model}。可选: ${VALID_MODELS.join(', ')}`)
    }

    // 验证参数范围
    if (args.speed !== undefined && (args.speed < 0.5 || args.speed > 2.0)) {
      return formatToolError(`语速超出范围: ${args.speed}。应在 0.5-2.0 之间。`)
    }
    if (args.pitch !== undefined && (args.pitch < 0.5 || args.pitch > 2.0)) {
      return formatToolError(`音调超出范围: ${args.pitch}。应在 0.5-2.0 之间。`)
    }

    log('INFO', 'piper_tool_request', {
      text_len: text.length,
      task_tag: args.task_tag || '(none)',
      model: args.model || '(auto)',
      speed: args.speed ?? '(model default)',
      pitch: args.pitch ?? '(model default)',
      text_preview: text.slice(0, 60),
      queue_size: piperOrchestrator.getQueueStatus().queueSize,
    })

    // 通过 Orchestrator 排队合成（串行处理，自动回退）
    const result = await piperOrchestrator.synthesize({
      text,
      taskTag: args.task_tag as PiperTaskTag | undefined,
      model: args.model,
      speed: args.speed,
      pitch: args.pitch,
    })

    if (!result.success) {
      log('ERROR', 'piper_tool_failed', {
        error: result.error,
        model: result.model,
        duration_ms: result.durationMs,
        fallback: result.fallbackUsed,
      })
      return formatToolError(`Piper TTS 合成失败: ${result.error}`)
    }

    const durationMs = result.durationMs

    // 播放音频
    if (result.audioFile) {
      await playAudioFile(result.audioFile)

      // 延迟清理临时文件（给渲染进程时间加载）
      const tempFile = result.audioFile
      setTimeout(() => {
        try {
          unlinkSync(tempFile)
        } catch {
          // 文件可能已被清理
        }
      }, 10000)
    }

    const modelDisplayName = PIPER_MODEL_CATALOG[result.model]?.displayName || result.model
    const fallbackNote = result.fallbackUsed ? ' (已自动回退到默认模型)' : ''

    log('INFO', 'piper_tool_done', {
      duration_ms: durationMs,
      text_len: text.length,
      model: result.model,
      fallback: result.fallbackUsed,
      queue_remaining: piperOrchestrator.getQueueStatus().queueSize,
    })

    return formatToolResult(
      `已通过 Piper TTS 朗读文本 (${text.length} 字符, 模型: ${modelDisplayName}${fallbackNote}, 耗时: ${durationMs}ms):\n"${text.slice(0, 100)}${text.length > 100 ? '...' : ''}"`,
    )
  },
  isReadOnly: true,
})

// ══════════════════════════════════════════
//  switch_piper_model — 用户切换当前模型
// ══════════════════════════════════════════

export const switchPiperModelTool = buildTool({
  name: 'switch_piper_model',
  description:
    '切换当前 Piper TTS 语音模型。后续所有未指定模型的语音合成将使用此模型。可用于适配不同的使用场景（日常对话/讲故事/通知）。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      model: {
        type: 'string',
        description: '要切换到的模型名。可选: zh_CN-huayan-medium（花颜·女声/通用）, zh_CN-ling_ling-medium（玲玲·温柔女声/讲故事）, zh_CN-tx_mati-medium（马提·沉稳男声/通知）。',
        enum: Object.keys(PIPER_MODEL_CATALOG),
      },
    },
    required: ['model'],
  },
  handler: async (args: { model: string }) => {
    const result = piperOrchestrator.switchModel(args.model)
    if (!result.success) {
      return formatToolError(result.message)
    }
    return formatToolResult(result.message)
  },
  isReadOnly: false,
})

// ══════════════════════════════════════════
//  list_piper_models — 列出可用模型
// ══════════════════════════════════════════

export const listPiperModelsTool = buildTool({
  name: 'list_piper_models',
  description:
    '列出所有可用的本地 Piper TTS 语音模型及其描述，以及当前活跃模型。',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    const models = piperOrchestrator.getAvailableModels()
    const current = piperOrchestrator.getCurrentModel()
    const status = piperOrchestrator.getQueueStatus()

    const lines = [
      `当前模型: ${PIPER_MODEL_CATALOG[current]?.displayName || current} (${current})`,
      `队列状态: ${status.queueSize} 个待处理, ${status.isProcessing ? '正在合成' : '空闲'}`,
      '',
      '可用模型:',
      ...models.map((m) => {
        const marker = m.name === current ? ' ★ 当前' : ''
        return `  - ${m.displayName} (${m.name})${marker}\n    ${m.description}\n    推荐语速: ${m.speed}x, 推荐音调: ${m.pitch}x`
      }),
    ]

    return formatToolResult(lines.join('\n'))
  },
  isReadOnly: true,
})
