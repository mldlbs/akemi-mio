/**
 * TtsSpeakTool — 多引擎动态 TTS 编排器（统一语音合成 MCP 工具）
 *
 * 功能：
 * 1. 统一接口：一个 tts_speak 工具覆盖所有 TTS 需求
 * 2. 多引擎路由：内部根据网络延迟（ping）和任务要求自动选择引擎
 *    - PiperTTS（本地）：低延迟，离线可用
 *    - Edge TTS（云端）：高质量，多音色
 * 3. 流式模式：按句合成音频，通过 IPC 实时发送到播放模块（边合成边播放）
 * 4. 情感控制：通过显式情感标签映射到不同音色/语速/音调
 * 5. 非流式模式：一次性合成全部文本
 *
 * 与现有工具的关系：
 * - speak_with_piper（仅 Piper）：保留以支持显式 Piper 调用
 * - tts_notify（仅 Piper + 事件通知）：保留作为通知专用通道
 * - tts_speak（统一接口）：新工具，覆盖以上两者的大部分场景
 */

import { BrowserWindow } from 'electron'
import { unlinkSync } from 'fs'
import { buildTool } from '@akemi-mio/capabilities/tool/types'
import { formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'
import { log } from '@akemi-mio/core/logger/Logger'
import { cleanTTS } from '@akemi-mio/audio/TtsService'
import { streamingAudioBuffer } from '@akemi-mio/audio/StreamingAudioBuffer'
import { ttsRouter } from '@akemi-mio/audio/TtsRouter'
import { networkMonitor } from '@akemi-mio/audio/NetworkMonitor'
import { VOICE_ROLE_MAP } from '@akemi-mio/audio/VoiceRoleTypes'
import { PIPER_MODEL_CATALOG } from '@akemi-mio/audio/PiperOrchestrator'

// ══════════════════════════════════════════
//  常量
// ══════════════════════════════════════════

/** 支持的引擎模式 */
const ENGINE_MODES = ['auto', 'cloud', 'local'] as const

/** 支持的情感标签 */
const EMOTION_LABELS = ['cheerful', 'serious', 'gentle', 'neutral', 'warm', 'energetic', 'calm', 'playful'] as const

/** 可用的语音角色 ID */
const VOICE_ROLE_IDS = Object.keys(VOICE_ROLE_MAP)

/** 可用的 Piper 模型名 */
const PIPER_MODEL_NAMES = Object.keys(PIPER_MODEL_CATALOG)

// ══════════════════════════════════════════
//  音频播放辅助
// ══════════════════════════════════════════

/** 播放音频文件到渲染进程 */
function playAudioFile(filePath: string): void {
  const wins = BrowserWindow.getAllWindows()
  for (const win of wins) {
    win.webContents.send('tts:play_audio', filePath)
  }
}

// ══════════════════════════════════════════
//  网络状态辅助
// ══════════════════════════════════════════

/** 获取人类可读的网络状态描述 */
async function getNetworkDescription(): Promise<string> {
  const status = await networkMonitor.getStatus()
  if (!status.available) return '网络不可用'
  return `延迟 ${status.latencyMs}ms（目标: ${status.target}）`
}

// ══════════════════════════════════════════
//  tts_speak — 统一语音合成工具
// ══════════════════════════════════════════

export const ttsSpeakTool = buildTool({
  name: 'tts_speak',
  description:
    '统一语音合成工具。支持根据网络状况自动选择本地 PiperTTS（低延迟）或云端 Edge TTS（高质量），' +
    '支持情感控制（通过情感标签映射音色/语速）和流式模式（边合成边播放）。' +
    '适用于朗读回复、播报通知、讲故事等各种语音输出场景。',

  inputJSONSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: '要朗读的文本内容。会自动清理 markdown 标记和 emoji。',
      },

      // ── 引擎控制 ──
      engine: {
        type: 'string',
        description:
          '引擎选择策略。auto=自动路由（根据网络延迟和任务要求自动选择最佳引擎），' +
          'cloud=强制使用云端 Edge TTS（高质量，需网络），' +
          'local=强制使用本地 Piper TTS（低延迟，离线可用）。默认 auto。',
        enum: ['auto', 'cloud', 'local'],
      },

      // ── 情感控制 ──
      emotion: {
        type: 'string',
        description:
          '情感标签，自动映射到对应的音色、语速和音调。' +
          '可选: cheerful（欢快）, serious（严肃）, gentle（温柔）, neutral（中性）, ' +
          'warm（温暖）, energetic（活力）, calm（沉稳）, playful（俏皮）。' +
          '不指定时使用默认中性参数。',
      },

      // ── 流式模式 ──
      streaming: {
        type: 'boolean',
        description:
          '是否启用流式模式。true=按句合成、边合成边播放（适合长文本），' +
          'false=全部合成后一次播放（适合短文本）。默认 false。长文本（>200 字符）建议启用。',
      },

      // ── Edge TTS 云端参数 ──
      voice: {
        type: 'string',
        description:
          'Edge TTS 语音角色名（云端引擎使用）。仅在 engine=cloud 或 emotion 参数不足以表达时指定。' +
          '常用: zh-CN-XiaoxiaoNeural（女声/活泼）, zh-CN-XiaoyiNeural（女声/温柔）, ' +
          'zh-CN-YunxiNeural（男声/温暖）, zh-CN-YunjianNeural（男声/严肃）。' +
          '不指定时由情感标签自动选择。',
      },
      rate: {
        type: 'string',
        description: '语速（Edge TTS 云端引擎）。格式如 "+10%"（加快 10%）或 "-5%"（减慢 5%）。' + '不指定时由情感标签自动选择。',
      },
      pitch: {
        type: 'string',
        description: '音调（Edge TTS 云端引擎）。格式如 "+8Hz"（升高）或 "-4Hz"（降低）。' + '不指定时由情感标签自动选择。',
      },

      // ── Piper 本地参数 ──
      role_id: {
        type: 'string',
        description:
          '语音角色 ID（本地引擎使用）。通过角色方案映射到对应的 Piper 模型、语速和音调。' +
          '可选: gentle_female, calm_male, lively_child, warm_female, professional_male。' +
          '与 piper_model 二选一，优先级：role_id 低于 piper_model。',
      },
      piper_model: {
        type: 'string',
        description:
          'Piper 语音模型名（本地引擎使用）。' +
          '可选: zh_CN-huayan-medium（花颜·女声/通用）, ' +
          'zh_CN-ling_ling-medium（玲玲·温柔女声/讲故事）, ' +
          'zh_CN-tx_mati-medium（马提·沉稳男声/通知）。' +
          '不指定时由角色 ID 或情感标签自动选择。',
      },
      speed: {
        type: 'number',
        description: '语速因子（本地引擎，0.5-2.0）。1.0=正常，0.7-0.9=较慢，1.1-1.3=较快。' + '不指定时由情感标签或模型默认值决定。',
      },
      pitch_factor: {
        type: 'number',
        description: '音调因子（本地引擎，0.5-2.0）。1.0=正常，>1=偏高（活泼），<1=偏低（沉稳）。' + '不指定时由情感标签或模型默认值决定。',
      },
    },
    required: ['text'],
  },

  handler: async (args: {
    text: string
    engine?: string
    emotion?: string
    streaming?: boolean
    voice?: string
    rate?: string
    pitch?: string
    role_id?: string
    piper_model?: string
    speed?: number
    pitch_factor?: number
  }) => {
    const t0 = Date.now()

    // ══════════════════════════════════════════
    //  参数验证
    // ══════════════════════════════════════════

    // 清理文本
    const text = cleanTTS(args.text || '')
    if (!text || text.length < 2) {
      return formatToolError('文本太短或清理后为空')
    }

    // 验证引擎模式
    const engine = (args.engine || 'auto') as 'auto' | 'cloud' | 'local'
    if (!ENGINE_MODES.includes(engine)) {
      return formatToolError(`无效的引擎模式: ${args.engine}。可选: auto, cloud, local`)
    }

    // 验证情感标签
    const emotion = args.emotion?.toLowerCase() || ''
    if (
      emotion &&
      !EMOTION_LABELS.includes(emotion as any) &&
      !['欢快', '严肃', '温柔', '中性', '温暖', '活力', '沉稳', '俏皮', '开心', '高兴', '生气', '难过', '平静', '热情', '活泼'].includes(
        emotion,
      )
    ) {
      return formatToolError(`无效的情感标签: ${args.emotion}。可选: ${EMOTION_LABELS.join(', ')}`)
    }

    // 验证角色 ID
    if (args.role_id && !VOICE_ROLE_IDS.includes(args.role_id)) {
      return formatToolError(`无效的角色 ID: ${args.role_id}。可用角色: ${VOICE_ROLE_IDS.join(', ')}`)
    }

    // 验证 Piper 模型
    if (args.piper_model && !PIPER_MODEL_NAMES.includes(args.piper_model)) {
      return formatToolError(`无效的 Piper 模型: ${args.piper_model}。可选: ${PIPER_MODEL_NAMES.join(', ')}`)
    }

    // 验证参数范围
    if (args.speed !== undefined && (args.speed < 0.5 || args.speed > 2.0)) {
      return formatToolError(`语速超出范围: ${args.speed}。应在 0.5-2.0 之间。`)
    }
    if (args.pitch_factor !== undefined && (args.pitch_factor < 0.5 || args.pitch_factor > 2.0)) {
      return formatToolError(`音调因子超出范围: ${args.pitch_factor}。应在 0.5-2.0 之间。`)
    }

    // 获取网络状态
    const netDesc = await getNetworkDescription()

    // 获取路由决策（仅用于日志和展示）
    const decision =
      engine === 'auto'
        ? await ttsRouter.decide({ forceCheck: false })
        : { engine: engine === 'local' ? ('local' as const) : ('cloud' as const), reason: `user_forced_${engine}` as string }

    // ══════════════════════════════════════════
    //  解析角色/模型参数（Piper 本地模式）
    // ══════════════════════════════════════════

    let resolvedPiperModel: string | undefined = args.piper_model
    let resolvedSpeed: number | undefined = args.speed
    let resolvedPitch: number | undefined = args.pitch_factor

    // 从角色 ID 解析
    if (!resolvedPiperModel && args.role_id) {
      const role = VOICE_ROLE_MAP[args.role_id]
      if (role) {
        resolvedPiperModel = role.piperModel
        if (resolvedSpeed === undefined) resolvedSpeed = role.piperSpeed
        if (resolvedPitch === undefined) resolvedPitch = role.piperPitch
      }
    }

    // ══════════════════════════════════════════
    //  执行合成
    // ══════════════════════════════════════════

    const streaming = args.streaming ?? false
    const isLongText = text.length > 200

    // 自动启用流式模式（长文本）
    const effectiveStreaming = streaming || (isLongText && engine !== 'cloud')

    log('INFO', 'tts_speak_invoke', {
      text_len: text.length,
      engine,
      emotion: emotion || '(none)',
      streaming: effectiveStreaming,
      role_id: args.role_id || '(none)',
      piper_model: resolvedPiperModel || '(auto)',
      speed: resolvedSpeed ?? '(auto)',
      pitch: resolvedPitch ?? '(auto)',
      network: netDesc,
      decision_engine: decision.engine,
      decision_reason: decision.reason,
      text_preview: text.slice(0, 60),
    })

    if (effectiveStreaming) {
      // ── 流式模式：逐句合成播放 ──
      const result = await streamingAudioBuffer.stream(text, {
        engine,
        enabled: true,
        emotion: emotion || undefined,
        voice: args.voice,
        rate: args.rate,
        pitch: args.pitch,
        piperModel: resolvedPiperModel,
        piperSpeed: resolvedSpeed,
        piperPitch: resolvedPitch,
      })

      const failInfo = result.failCount > 0 ? `, ${result.failCount} 句失败` : ''

      return formatToolResult(
        `✅ 流式语音合成完成 (${result.successCount}/${result.totalSentences} 句成功${failInfo})` +
          `\n引擎: ${decision.engine === 'local' ? 'PiperTTS（本地）' : 'Edge TTS（云端）'}` +
          `\n网络: ${netDesc}` +
          `\n总耗时: ${result.totalDurationMs}ms` +
          (emotion ? `\n情感: ${emotion}` : '') +
          (resolvedPiperModel ? `\nPiper 模型: ${PIPER_MODEL_CATALOG[resolvedPiperModel]?.displayName || resolvedPiperModel}` : '') +
          `\n文本: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`,
      )
    } else {
      // ── 非流式模式：一次性合成 ──
      const audioFile = await streamingAudioBuffer.synthesizeAll(text, {
        engine,
        enabled: false,
        emotion: emotion || undefined,
        voice: args.voice,
        rate: args.rate,
        pitch: args.pitch,
        piperModel: resolvedPiperModel,
        piperSpeed: resolvedSpeed,
        piperPitch: resolvedPitch,
      })

      if (!audioFile) {
        return formatToolError('语音合成失败')
      }

      // 播放音频
      playAudioFile(audioFile)

      // 延迟清理
      setTimeout(() => {
        try {
          unlinkSync(audioFile)
        } catch {
          /* ignore */
        }
      }, 10000)

      const durationMs = Date.now() - t0
      const modelDisplayName = resolvedPiperModel ? PIPER_MODEL_CATALOG[resolvedPiperModel]?.displayName || resolvedPiperModel : ''

      return formatToolResult(
        `✅ 语音合成完成` +
          `\n引擎: ${decision.engine === 'local' ? 'PiperTTS（本地）' : 'Edge TTS（云端）'}` +
          `\n网络: ${netDesc}` +
          `\n耗时: ${durationMs}ms` +
          `\n文本长度: ${text.length} 字符` +
          (emotion ? `\n情感: ${emotion}` : '') +
          (modelDisplayName ? `\nPiper 模型: ${modelDisplayName}` : '') +
          `\n文本: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`,
      )
    }
  },

  isReadOnly: true,
})

