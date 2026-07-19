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
import { voiceRoleManager } from '../../tts/VoiceRoleManager'
import { VOICE_ROLE_MAP } from '../../tts/VoiceRoleTypes'
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
        description: '任务标签，自动选择最佳模型。可选: chat（日常对话/快速回复）, story（讲故事/朗读/高表现力）, alert（通知/提醒/警告）。与 role_id 二选一。',
        enum: ['chat', 'story', 'alert'],
      },
      role_id: {
        type: 'string',
        description: '语音角色 ID。通过角色方案映射到对应的 Piper 模型、语速和音调。与 task_tag 二选一。可用: gentle_female（温柔女声）, calm_male（沉稳男声）, lively_child（活泼童声）, warm_female（温暖女声）, professional_male（专业男声）。使用 list_voice_roles 查看详情。',
      },
      model: {
        type: 'string',
        description: '显式指定 Piper 语音模型。可选: zh_CN-huayan-medium（花颜·女声/默认）, zh_CN-ling_ling-medium（玲玲·温柔女声）, zh_CN-tx_mati-medium（马提·沉稳男声）。优先级高于 task_tag 和 role_id。',
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
    role_id?: string
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

    // 验证 role_id
    const ROLE_IDS = Object.keys(VOICE_ROLE_MAP)
    if (args.role_id && !ROLE_IDS.includes(args.role_id)) {
      return formatToolError(`无效的角色 ID: ${args.role_id}。可用角色: ${ROLE_IDS.join(', ')}`)
    }

    // 从角色 ID 解析模型参数
    let resolvedModel = args.model
    let resolvedSpeed = args.speed
    let resolvedPitch = args.pitch
    if (!resolvedModel && args.role_id) {
      const role = VOICE_ROLE_MAP[args.role_id]
      if (role) {
        resolvedModel = role.piperModel
        if (resolvedSpeed === undefined) resolvedSpeed = role.piperSpeed
        if (resolvedPitch === undefined) resolvedPitch = role.piperPitch
      }
    }

    // 验证 model
    const VALID_MODELS = Object.keys(PIPER_MODEL_CATALOG)
    if (resolvedModel && !VALID_MODELS.includes(resolvedModel)) {
      return formatToolError(`无效的模型名: ${resolvedModel}。可选: ${VALID_MODELS.join(', ')}`)
    }

    // 验证参数范围
    if (resolvedSpeed !== undefined && (resolvedSpeed < 0.5 || resolvedSpeed > 2.0)) {
      return formatToolError(`语速超出范围: ${resolvedSpeed}。应在 0.5-2.0 之间。`)
    }
    if (resolvedPitch !== undefined && (resolvedPitch < 0.5 || resolvedPitch > 2.0)) {
      return formatToolError(`音调超出范围: ${resolvedPitch}。应在 0.5-2.0 之间。`)
    }

    const roleName = args.role_id ? VOICE_ROLE_MAP[args.role_id]?.name || args.role_id : '(none)'

    log('INFO', 'piper_tool_request', {
      text_len: text.length,
      task_tag: args.task_tag || '(none)',
      role_id: args.role_id || '(none)',
      role_name: roleName,
      model: resolvedModel || '(auto)',
      speed: resolvedSpeed ?? '(model default)',
      pitch: resolvedPitch ?? '(model default)',
      text_preview: text.slice(0, 60),
      queue_size: piperOrchestrator.getQueueStatus().queueSize,
    })

    // 通过 Orchestrator 排队合成（串行处理，自动回退）
    const result = await piperOrchestrator.synthesize({
      text,
      taskTag: args.task_tag as PiperTaskTag | undefined,
      model: resolvedModel,
      speed: resolvedSpeed,
      pitch: resolvedPitch,
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

// ══════════════════════════════════════════
//  角色化语音引擎工具
// ══════════════════════════════════════════

export const listVoiceRolesTool = buildTool({
  name: 'list_voice_roles',
  description: '列出所有可用的语音角色及其 TTS 参数和 Piper 模型映射。语音角色是角色化多任务语音引擎的核心概念，每个角色绑定了一套完整的 TTS 参数（Edge-TTS + Piper）。',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    const roles = voiceRoleManager.getRoles()
    const activeScheme = voiceRoleManager.getActiveScheme()

    const roleLines = roles.map((r) => {
      return `  - ${r.name} (${r.id})
    ${r.description}
    Edge-TTS: ${r.voice} | 语速 ${r.rate} | 音调 ${r.pitch}
    Piper: ${r.piperModel} | 语速 ${r.piperSpeed}x | 音调 ${r.piperPitch}x
    风格: ${r.voiceStyle}`
    })

    const schemeLines = [
      '',
      '当前方案:',
      `  ${activeScheme.name} (${activeScheme.id})`,
      '  任务映射:',
      ...Object.entries(activeScheme.mappings).map(([task, roleId]) => {
        const roleName = VOICE_ROLE_MAP[roleId]?.name || roleId
        return `    ${task} → ${roleName}`
      }),
    ]

    return formatToolResult([
      `可用语音角色 (${roles.length} 个):`,
      ...roleLines,
      ...schemeLines,
    ].join('\n'))
  },
  isReadOnly: true,
})

export const listVoiceSchemesTool = buildTool({
  name: 'list_voice_schemes',
  description: '列出所有可用的角色方案及其任务映射。角色方案将不同任务类型映射到不同的语音角色，实现多任务语音区分。',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    const schemes = voiceRoleManager.getSchemes()
    const activeId = voiceRoleManager.getActiveScheme().id

    const lines = schemes.map((s) => {
      const marker = s.id === activeId ? ' ★ 当前' : ''
      const mappingLines = Object.entries(s.mappings).map(([task, roleId]) => {
        const roleName = VOICE_ROLE_MAP[roleId]?.name || roleId || '(未设置)'
        return `    ${task} → ${roleName}`
      })
      return `- ${s.name} (${s.id})${marker}
  ${s.description}
  映射:
${mappingLines.join('\n')}`
    })

    return formatToolResult(
      `可用角色方案 (${schemes.length} 个):\n\n${lines.join('\n\n')}\n\n使用 set_voice_scheme 切换方案。`,
    )
  },
  isReadOnly: true,
})

export const setVoiceSchemeTool = buildTool({
  name: 'set_voice_scheme',
  description: '切换当前角色方案。方案切换后，Agent 在不同任务场景下的语音角色将自动更新。切换时会预加载新方案涉及的 Piper 模型以减少延迟。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      scheme_id: {
        type: 'string',
        description: '要切换到的方案 ID。可选: default（默认方案）, geek（极客方案）, gentle（柔和方案）。使用 list_voice_schemes 查看所有方案详情。',
      },
    },
    required: ['scheme_id'],
  },
  handler: async (args: { scheme_id: string }) => {
    const result = await voiceRoleManager.setActiveScheme(args.scheme_id)
    if (!result.success) {
      return formatToolError(result.message)
    }
    return formatToolResult(result.message)
  },
  isReadOnly: false,
})
