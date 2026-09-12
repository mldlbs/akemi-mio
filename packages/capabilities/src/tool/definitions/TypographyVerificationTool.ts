/**
 * TypographyVerificationTool — 排版内容语音校验与预览 MCP 工具
 *
 * 功能：
 * 1. verify_typography — 对排版后文本执行 TTS→ASR 闭环校验，
 *    发现格式符号导致的吞词/断句错误，生成校验报告
 * 2. read_aloud_segment — 朗读指定文本段落（不校验）
 *
 * 集成：
 * - TypographyVerificationService（核心校验逻辑）
 * - PiperOrchestrator（TTS 合成）
 * - AsrService（通过依赖注入获取）
 *
 * 使用场景：
 * - 排版完成后，Agent 调用 verify_typography 检查是否有文本丢失
 * - 用户要求"朗读这段"时，Agent 调用 read_aloud_segment
 * - 用户也可通过 UI 直接触发，无需 Agent 介入
 */
import { buildTool, formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'
import { typographyVerificationService } from '@akemi-mio/audio/typing/TypographyVerificationService'
import { getAsrService } from '@akemi-mio/capabilities/tool/deps'
import { log } from '@akemi-mio/core/logger/Logger'

export const verifyTypographyTool = buildTool({
  name: 'verify_typography',
  description: `对排版后的文本执行语音闭环校验（TTS→ASR→对比分析），
发现排版格式符号导致的吞词、断句错误，并生成校验报告。

工作原理：
1. 去除原文中的格式标记得到纯文本
2. 调用本地 PiperTTS 将纯文本合成为语音
3. 调用本地 Whisper ASR 将语音转回文本
4. 逐句计算编辑距离，标记可疑差异

注意：需要 ASR 引擎已加载（通常自动可用）。如 ASR 不可用将返回错误。

返回结果包含：
- plainText: 去掉格式后的纯文本
- recognizedText: ASR 识别结果
- sentences[]: 逐句对比详情（含 diffSegments 和可疑标记）
- summary: 差异总览（总句数、可疑数、总差异率）
- audioFile: 合成音频路径`,
  inputJSONSchema: {
    type: 'object' as const,
    properties: {
      text: {
        type: 'string',
        description: '排版后的完整文本（可含 Markdown 格式标记）',
      },
    },
    required: ['text'],
  },
  isReadOnly: true,
  handler: async (args: { text: string }) => {
    try {
      if (!args.text || args.text.length < 10) {
        return formatToolError('文本太短（至少 10 个字符），无需校验')
      }

      // 从 deps 获取 ASR 服务并注入
      const asr = getAsrService()
      if (!asr) {
        return formatToolError('ASR 服务未就绪，请在 Agent 运行时重试')
      }
      typographyVerificationService.setTranscribeFn(async (pcmInt16: Int16Array) => {
        const result = await asr.transcribe(pcmInt16.buffer as ArrayBuffer)
        return result.text
      })

      const report = await typographyVerificationService.verify(args.text)

      // 构造人类可读的摘要
      const lines: string[] = [
        `📊 语音校验报告`,
        `━━━━━━━━━━━━━━━━━━`,
        `总句数: ${report.summary.totalSentences}`,
        `可疑句数: ${report.summary.suspiciousSentences}`,
        `平均差异率: ${(report.summary.totalDiffRate * 100).toFixed(1)}%`,
        `状态: ${report.summary.hasDiscrepancies ? '⚠️ 发现可疑差异' : '✅ 校验通过'}`,
        `耗时: ${report.summary.verificationMs}ms`,
        ``,
      ]

      if (report.summary.hasDiscrepancies) {
        lines.push('可疑句子:')
        for (const s of report.sentences) {
          if (s.suspicious) {
            lines.push(`  ⚠️ "${s.originalSentence.slice(0, 50)}..."`)
            lines.push(`     识别为: "${s.recognizedSentence.slice(0, 50)}..."`)
            lines.push(`     差异率: ${(s.diffRate * 100).toFixed(0)}%`)
          }
        }
        lines.push('')
      }

      lines.push(`原文(去格式): ${report.plainText.slice(0, 200)}...`)
      lines.push(`识别结果: ${report.recognizedText.slice(0, 200)}...`)

      // 返回人类可读摘要 + JSON 详情
      return formatToolResult(lines.join('\n'))
    } catch (err) {
      log('ERROR', 'verify_typography_tool_failed', { error: String(err) })
      return formatToolError(`语音校验失败: ${String(err)}`)
    }
  },
})

export const readAloudSegmentTool = buildTool({
  name: 'read_aloud_segment',
  description: `朗读指定的文本段落（不执行校验）。
适用于用户要求"朗读这段""读给我听"等场景，或者 Agent 主动朗读内容以让用户感知通顺度。

注意：如果只是普通对话回复，系统会自动朗读，无需调用此工具。
此工具主要用于朗读较长的排版内容或指定段落。`,
  inputJSONSchema: {
    type: 'object' as const,
    properties: {
      text: {
        type: 'string',
        description: '要朗读的文本段落',
      },
    },
    required: ['text'],
  },
  isReadOnly: true,
  handler: async (args: { text: string }) => {
    try {
      if (!args.text || args.text.trim().length < 2) {
        return formatToolError('文本太短或为空')
      }

      const result = await typographyVerificationService.readAloud(args.text)

      if (!result.success) {
        return formatToolError(`朗读失败: ${result.error}`)
      }

      return formatToolResult(`已开始朗读「${args.text.slice(0, 60)}${args.text.length > 60 ? '...' : ''}」` + `(${result.durationMs}ms)`)
    } catch (err) {
      log('ERROR', 'read_aloud_tool_failed', { error: String(err) })
      return formatToolError(`朗读失败: ${String(err)}`)
    }
  },
})

